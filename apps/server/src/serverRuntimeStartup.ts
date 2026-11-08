import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type OrchestrationProjectShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@lecturn/contracts";
import { resolveProjectSettings } from "@lecturn/shared/projectSettings";
import { resolveProjectAutoPull } from "@lecturn/shared/serverSettings";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import { flushCompileCache } from "./compileCache.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import { forkParked, forkParkedFiber } from "./serverActivation.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import { getServerOwners } from "./telemetry/Identify.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { ContextualService } from "./contextual/ContextualService.ts";
import { ExtensionsCloudClient } from "./extensions/ExtensionsCloudClient.ts";
import { PullRequestWatchDiscovery } from "./pullRequest/PullRequestWatchDiscovery.ts";
import { PullRequestWatchService } from "./pullRequest/PullRequestWatchService.ts";
import { StaveLifecycleService } from "./stave/lifecycle/StaveLifecycleService.ts";
import { SagaInferenceReactor } from "./stave/SagaInferenceReactor.ts";
import { makeStaveAutoPullOwnerCheck } from "./stave/StaveAutoPullOwnership.ts";
import { StaveProjectShells } from "./stave/StaveProjectShells.ts";
import { DecisionCloudClient } from "./threadDecisions/DecisionCloudClient.ts";
import { DecisionIngestion } from "./threadDecisions/DecisionIngestion.ts";
import { SquireActions } from "./squire/SquireActions.ts";
import { SquireClock } from "./squire/SquireClock.ts";
import { SquireDelivery } from "./squire/SquireDelivery.ts";
import { SquireJevRouting } from "./squire/SquireJevRouter.ts";
import { SquireLifecycle } from "./squire/SquireLifecycle.ts";
import { SquireCiExcerpt } from "./squire/SquireCiExcerpt.ts";
import { SquireProbe } from "./squire/SquireProbe.ts";
import { SquireReactor } from "./squire/SquireReactor.ts";
import { SquireCursorAtStart, syncCursorWithSwitch } from "./squire/SquireCursorStartup.ts";
import * as SquireRepository from "./squire/SquireRepository.ts";
import { SquireSummaries } from "./squire/SquireSummaries.ts";
import * as SquireSwitch from "./squire/SquireSwitch.ts";
import { DecisionRelations } from "./threadDecisions/DecisionRelations.ts";
import { DecisionWorker } from "./threadDecisions/DecisionWorker.ts";
import {
  formatHeadlessServeOutput,
  formatHostForUrl,
  isWildcardHost,
  issueHeadlessServeAccessInfo,
} from "./startupAccess.ts";

export class ServerRuntimeStartupError extends Schema.TaggedError<ServerRuntimeStartupError>()(
  "ServerRuntimeStartupError",
  {
    mode: ServerConfig.RuntimeMode,
    host: Schema.NullOr(Schema.String),
    port: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Server runtime startup failed before command readiness.";
  }
}

export class ServerRuntimeStartup extends Context.Service<
  ServerRuntimeStartup,
  {
    readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
    readonly markHttpListening: Effect.Effect<void>;
    readonly enqueueCommand: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
  }
>()("lecturn/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

const settleQueuedCommand = <A, E>(deferred: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Deferred.succeed(deferred, exit.value)
    : Deferred.failCause(deferred, exit.cause);

export const makeCommandGate = Effect.gen(function* () {
  const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
  const commandQueue = yield* Queue.unbounded<QueuedCommand>();
  const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

  const commandWorker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap((command) => command.run)),
  );
  yield* Effect.forkScoped(commandWorker);

  const enqueueCommand = Effect.fn("serverRuntimeStartup.enqueueCommand")(function* <A, E>(
    effect: Effect.Effect<A, E>,
  ): Effect.fn.Return<A, E | ServerRuntimeStartupError> {
    const readinessState = yield* Ref.get(commandReadinessState);
    if (readinessState === "ready") {
      return yield* effect;
    }
    if (readinessState !== "pending") {
      return yield* readinessState;
    }

    const result = yield* Deferred.make<A, E | ServerRuntimeStartupError>();
    yield* Queue.offer(commandQueue, {
      run: Deferred.await(commandReady).pipe(
        Effect.flatMap(() => effect),
        Effect.exit,
        Effect.flatMap((exit) => settleQueuedCommand(result, exit)),
      ),
    });
    return yield* Deferred.await(result);
  });

  return {
    awaitCommandReady: Deferred.await(commandReady),
    signalCommandReady: Effect.gen(function* () {
      yield* Ref.set(commandReadinessState, "ready");
      yield* Deferred.succeed(commandReady, undefined).pipe(Effect.orDie);
    }),
    failCommandReady: Effect.fn("serverRuntimeStartup.failCommandReady")(function* (error) {
      yield* Ref.set(commandReadinessState, error);
      yield* Deferred.fail(commandReady, error).pipe(Effect.orDie);
    }),
    enqueueCommand,
  } satisfies CommandGate;
});

const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const { threadCount, projectCount } = yield* Effect.all({
    projects: projects.snapshot,
    threads: threads.getShellSnapshot(),
  }).pipe(
    Effect.map(({ projects: projectSnapshot, threads: shellSnapshot }) => ({
      projectCount: projectSnapshot.projects.length,
      threadCount: shellSnapshot.threads.length + shellSnapshot.archivedThreads.length,
    })),
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather V2 startup counts for telemetry", {
        cause,
      }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
  yield* analytics.recordOwners(yield* getServerOwners, "server");
});

const getAutoBootstrapThreadModelSelection = (): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
});

interface AutoBootstrapWelcomeTargets {
  readonly bootstrapProjectId?: ProjectId;
  readonly bootstrapThreadId?: ThreadId;
}

export const autoPullProjects = Effect.fn("autoPullProjects")(function* (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  settings = DEFAULT_SERVER_SETTINGS,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  // After the one-time fold, project overrides alone decide so a reset in
  // settings is not undone by the legacy aggregate flag.
  const enabledProjects = projects.filter((project) =>
    settings.projectSettingsFolded
      ? resolveProjectSettings(settings, project.id).settings.defaultAutoPull
      : resolveProjectAutoPull(settings, project.id, project.autoPull),
  );
  if (enabledProjects.length === 0) return;
  // Lecturn: Stave owns pulls inside its spaces (also for projects imported
  // from V1, whose space is only on disk until a shell is decorated).
  const hasStaveAutoPullOwner = yield* makeStaveAutoPullOwnerCheck(projects);
  const workspaceRoots = new Set<string>();
  for (const project of enabledProjects) {
    if (project.stave != null || (yield* hasStaveAutoPullOwner(project.workspaceRoot))) {
      yield* Effect.logDebug("Skipped automatic project pull", {
        cwd: project.workspaceRoot,
        reason: "stave-space",
      });
      continue;
    }
    workspaceRoots.add(project.workspaceRoot);
  }

  yield* Effect.forEach(
    [...workspaceRoots],
    (cwd) =>
      Effect.gen(function* () {
        const status = yield* git.statusDetails(cwd);
        if (
          !status.isRepo ||
          !status.isDefaultBranch ||
          !status.hasUpstream ||
          status.hasWorkingTreeChanges ||
          status.aheadCount > 0
        ) {
          yield* Effect.logDebug("Skipped automatic project pull", {
            cwd,
            reason: !status.isRepo
              ? "not-a-repository"
              : !status.isDefaultBranch
                ? "not-on-default-branch"
                : !status.hasUpstream
                  ? "no-upstream"
                  : status.hasWorkingTreeChanges
                    ? "working-tree-changes"
                    : "local-commits",
          });
          return;
        }

        if (status.behindCount <= 0) return;

        const result = yield* git.pullCurrentBranch(cwd);
        yield* Effect.logDebug("Automatic project pull completed", {
          cwd,
          status: result.status,
          refName: result.refName,
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Automatic project pull failed", {
            cwd,
            cause,
          }),
        ),
      ),
    { concurrency: 4, discard: true },
  );
});

const resolveWelcomeBase = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const segments = serverConfig.cwd.split(/[/\\]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? "project";

  return {
    cwd: serverConfig.cwd,
    projectName,
  } as const;
});

const resolveAutoBootstrapWelcomeTargets = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4();
  const serverConfig = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const path = yield* Path.Path;

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;

  if (serverConfig.autoBootstrapProjectFromCwd) {
    const threadModelSelection = getAutoBootstrapThreadModelSelection();
    const { project } = yield* projects.bootstrap({
      commandId: CommandId.make(yield* randomUUID),
      projectId: ProjectId.make(yield* randomUUID),
      title: path.basename(serverConfig.cwd) || "project",
      workspaceRoot: serverConfig.cwd,
    });
    const shell = yield* threads.getShellSnapshot();
    const existingThread = shell.threads.find(
      (thread) =>
        thread.projectId === project.id && thread.lineage.relationshipToParent !== "subagent",
    );
    if (existingThread === undefined) {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const settings = yield* serverSettings.getSettings;
      const launched = yield* threadLaunch
        .launch({
          commandId: CommandId.make(yield* randomUUID),
          projectId: project.id,
          title: "New thread",
          modelSelection:
            resolveProjectSettings(settings, project.id, project).settings.defaultModelSelection ??
            threadModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: resolveProjectSettings(settings, project.id, project).settings
            .defaultRuntimeMode,
          workspaceStrategy: { type: "root" },
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          // The bootstrap thread is optional; its launch must not prevent opening the app.
          Effect.catchTags({
            ThreadManagementProviderInstanceDisabledError: (error) =>
              Effect.logInfo("Skipped bootstrap thread because its provider instance is disabled", {
                projectId: project.id,
                instanceId: error.instanceId,
              }).pipe(Effect.as(undefined)),
            ThreadLaunchError: (error) =>
              Effect.logWarning("Failed to launch bootstrap thread", {
                projectId: project.id,
                operation: error.operation,
              }).pipe(Effect.as(undefined)),
          }),
        );
      bootstrapProjectId = project.id;
      bootstrapThreadId = launched?.threadId;
    } else {
      bootstrapProjectId = project.id;
      bootstrapThreadId = existingThread.id;
    }
  }

  return {
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } satisfies AutoBootstrapWelcomeTargets;
});

const resolveStartupBrowserTarget = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const localUrl = `http://localhost:${serverConfig.port}`;
  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;
  const baseTarget = serverConfig.devUrl?.toString() ?? bindUrl;
  return serverConfig.mode === "desktop"
    ? baseTarget
    : yield* serverAuth.issueStartupPairingUrl(baseTarget);
});

/** Prints the one-time admin pairing URL to stdout only; logger records reach trace files and collectors. */
export const announceStartupPairingUrl = (pairingUrl: string) =>
  Effect.logInfo("Authentication required. Open Lecturn using the pairing URL.").pipe(
    Effect.andThen(Console.log(`  pairingUrl: ${pairingUrl}`)),
  );

// Pairing tokens belong only in announceStartupPairingUrl's stdout output.
export const logBrowserAutoOpenUnavailable = Effect.logInfo("browser auto-open unavailable", {
  hint: "Open the pairing URL above in your browser.",
});

export const maybeOpenBrowser = Effect.fn("serverRuntimeStartup.maybeOpenBrowser")(function* (
  target: string,
) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  if (serverConfig.noBrowser) {
    return;
  }
  const externalLauncher = yield* ExternalLauncher.ExternalLauncher;

  yield* externalLauncher.launchBrowser(target).pipe(
    // The target carries the pairing token, and a failed launch records its
    // command line on the span, so this call stays out of traces.
    Effect.withTracerEnabled(false),
    Effect.catch(() => logBrowserAutoOpenUnavailable),
  );
});

const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    // Use span attributes; annotations would follow long-lived forked fibers for the server's lifetime.
    Effect.withSpan(`server.startup.${phase}`, { attributes: { "startup.phase": phase } }),
  );

/**
 * Lecturn background roots that V1 started from its orchestration reactor:
 * Stave lifecycle and saga inference, decision ingestion and its worker,
 * Contextual capture, PR watches, and the cloud reconcilers. Each is optional
 * so focused runtimes without the feature still start.
 */
export const startLecturnReactors = Effect.gen(function* () {
  const staveLifecycle = yield* Effect.serviceOption(StaveLifecycleService);
  if (Option.isSome(staveLifecycle)) yield* staveLifecycle.value.start();
  const sagaInference = yield* Effect.serviceOption(SagaInferenceReactor);
  if (Option.isSome(sagaInference)) yield* sagaInference.value.start();
  const decisionCloud = yield* Effect.serviceOption(DecisionCloudClient);
  if (Option.isSome(decisionCloud))
    yield* forkParked(
      decisionCloud.value.refreshFunding.pipe(Effect.repeat(Schedule.spaced("1 minute"))),
    );
  const extensionsCloud = yield* Effect.serviceOption(ExtensionsCloudClient);
  if (Option.isSome(extensionsCloud))
    yield* forkParked(
      extensionsCloud.value.reconcilePending.pipe(Effect.repeat(Schedule.spaced("5 seconds"))),
    );
  const contextual = yield* Effect.serviceOption(ContextualService);
  if (Option.isSome(contextual))
    yield* forkParked(
      contextual.value
        .maintainCapture()
        .pipe(Effect.ignore, Effect.repeat(Schedule.spaced("2 minutes"))),
    );
  const decisionRelations = yield* Effect.serviceOption(DecisionRelations);
  if (Option.isSome(decisionRelations))
    yield* forkParked(
      decisionRelations.value.drive.pipe(
        Effect.ignore,
        Effect.repeat(Schedule.spaced("2 minutes")),
      ),
    );
  const decisionIngestion = yield* Effect.serviceOption(DecisionIngestion);
  const decisionWorker = yield* Effect.serviceOption(DecisionWorker);
  if (Option.isSome(decisionIngestion) && Option.isSome(decisionWorker))
    yield* forkParked(
      decisionIngestion.value.start.pipe(
        Effect.catch(() =>
          Effect.logError(
            "Decision history recovery is waiting; saved decisions remain available.",
          ),
        ),
        Effect.andThen(decisionWorker.value.start),
      ),
    );
  const watches = yield* Effect.serviceOption(PullRequestWatchService);
  if (Option.isSome(watches)) yield* watches.value.start;
  const discovery = yield* Effect.serviceOption(PullRequestWatchDiscovery);
  if (Option.isSome(discovery)) yield* discovery.value.start;
  const squireSwitch = yield* Effect.serviceOption(SquireSwitch.SquireSwitch);
  if (Option.isSome(squireSwitch)) yield* followSquireSwitch(squireSwitch.value);
});

/**
 * One Squire on period, each piece forked into the period's scope so turning
 * the switch off interrupts it. Each service is optional so focused runtimes
 * without it still start.
 */
const squireOnPeriod = Effect.fn("serverRuntimeStartup.squireOnPeriod")(function* (
  turnedOn: boolean,
) {
  // Resumes setups and deletes a crash interrupted.
  const squireLifecycle = yield* Effect.serviceOption(SquireLifecycle);
  if (Option.isSome(squireLifecycle)) yield* Effect.forkScoped(squireLifecycle.value.reconcileAll);
  // Summaries a crash left `generating` settle to `partial` before the
  // reactor could start new ones for the same run.
  const squireSummaries = yield* Effect.serviceOption(SquireSummaries);
  const settleSquireSummaries = Option.isSome(squireSummaries)
    ? squireSummaries.value.settleInterrupted.pipe(
        Effect.catchCause((cause) => Effect.logWarning("Squire summary settle failed", { cause })),
      )
    : Effect.void;
  const squireReactor = yield* Effect.serviceOption(SquireReactor);
  if (Option.isSome(squireReactor))
    yield* Effect.forkScoped(
      settleSquireSummaries.pipe(Effect.andThen(squireReactor.value.start({ turnedOn }))),
    );
  const squireDelivery = yield* Effect.serviceOption(SquireDelivery);
  if (Option.isSome(squireDelivery))
    yield* Effect.forkScoped(
      squireDelivery.value.redispatchBatched.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Squire batch re-dispatch failed; the next wake retries", { cause }),
        ),
      ),
    );
  // Lecturn: a Jev request in flight at a restart is asked again under its request id.
  const squireJev = yield* Effect.serviceOption(SquireJevRouting);
  if (Option.isSome(squireJev))
    yield* Effect.forkScoped(
      squireJev.value.resumePending.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Squire Jev resume failed; the deadline falls back", { cause }),
        ),
      ),
    );
  const squireClock = yield* Effect.serviceOption(SquireClock);
  // Executions a crash left unfinished are settled from their receipts
  // (charged once) before the clock can run a hold against the same budget.
  const squireActions = yield* Effect.serviceOption(SquireActions);
  const reconcileSquireActions = Option.isSome(squireActions)
    ? squireActions.value.reconcileStartup.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Squire action reconcile failed", { cause }),
        ),
      )
    : Effect.void;
  if (Option.isSome(squireClock))
    yield* Effect.forkScoped(reconcileSquireActions.pipe(Effect.andThen(squireClock.value.start)));
  // Excerpts CI-failure cards off committed rows; a restart re-reads its window.
  const squireCiExcerpt = yield* Effect.serviceOption(SquireCiExcerpt);
  if (Option.isSome(squireCiExcerpt)) yield* Effect.forkScoped(squireCiExcerpt.value.start);
  // An ask a crash left running resumes or settles from its derived ids.
  const squireProbe = yield* Effect.serviceOption(SquireProbe);
  if (Option.isSome(squireProbe))
    yield* Effect.forkScoped(
      squireProbe.value.reconcileStartup.pipe(
        Effect.catchCause((cause) => Effect.logWarning("Squire probe reconcile failed", { cause })),
      ),
    );
});

/**
 * The cursor sync runs first on the way in, before anything can commit an event the jump would
 * skip, and last on the way out, after the reactor that rewrites the cursor's flag stops. The
 * start's sync ran at layer build (SquireCursorAtStart) or, without it, runs here unparked.
 */
const followSquireSwitch = Effect.fn("serverRuntimeStartup.followSquireSwitch")(function* (
  squireSwitch: SquireSwitch.SquireSwitch["Service"],
) {
  const repository = yield* Effect.serviceOption(SquireRepository.SquireRepository);
  const events = yield* Effect.serviceOption(OrchestrationEventStore.OrchestrationEventStore);
  // Squire bookkeeping must not stop the switch: a failed sync is logged and
  // reads as `None`. An off period whose write failed leaves the cursor
  // marked on, so the next on period forces the jump past the off period
  // instead of delivering it.
  let offUnrecorded = false;
  const syncCursor = (on: boolean) =>
    Option.isNone(repository) || Option.isNone(events)
      ? Effect.succeedSome(false)
      : syncCursorWithSwitch(on, { forceJump: on && offUnrecorded }).pipe(
          Effect.provideService(SquireRepository.SquireRepository, repository.value),
          Effect.provideService(OrchestrationEventStore.OrchestrationEventStore, events.value),
          Effect.tap(() => Effect.sync(() => void (offUnrecorded = false))),
          Effect.asSome,
          Effect.catchCause((cause) =>
            Effect.logWarning("Squire cursor sync failed", { on, cause }).pipe(
              Effect.andThen(Effect.sync(() => void (offUnrecorded ||= !on))),
              Effect.as(Option.none<boolean>()),
            ),
          ),
        );
  const atStart = yield* Effect.serviceOption(SquireCursorAtStart);
  let presynced: { readonly on: boolean; readonly turnedOn: boolean } | undefined = Option.isSome(
    atStart,
  )
    ? atStart.value
    : yield* Effect.gen(function* () {
        const on = yield* squireSwitch.isOn;
        return { on, turnedOn: Option.getOrElse(yield* syncCursor(on), () => false) };
      });
  const parent = yield* Effect.scope;
  let period: Scope.Closeable | undefined;
  yield* forkParked(
    Stream.runForEach(squireSwitch.changes, (on) =>
      Effect.gen(function* () {
        const synced = presynced;
        presynced = undefined;
        if (on) {
          if (period !== undefined) return;
          const turnedOn =
            synced?.on === true
              ? synced.turnedOn
              : Option.getOrElse(yield* syncCursor(true), () => false);
          const scope = yield* Scope.fork(parent, "parallel");
          period = scope;
          yield* squireOnPeriod(turnedOn).pipe(Scope.provide(scope));
          return;
        }
        if (period !== undefined) {
          const scope = period;
          period = undefined;
          yield* Scope.close(scope, Exit.void);
        }
        if (synced?.on !== false) yield* syncCursor(false);
      }),
    ),
  );
});

interface StartupOptions {
  readonly activate?: Effect.Effect<void>;
  readonly awaitAuxiliaryParked?: Effect.Effect<void>;
  readonly abort?: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
}

export const startEffectWorkerWithRelay = Effect.fn(
  "ServerRuntimeStartup.startEffectWorkerWithRelay",
)(function* <WorkerContext, RelayContext>(input: {
  readonly runWorker: Effect.Effect<void, never, WorkerContext>;
  readonly startRelay: Effect.Effect<void, never, RelayContext>;
  readonly workerFiberRef: Ref.Ref<Fiber.Fiber<void, never> | null>;
}) {
  const workerFiber = yield* forkParkedFiber(input.runWorker);
  yield* Ref.set(input.workerFiberRef, workerFiber);
  yield* input.startRelay.pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit)) {
        return Effect.void;
      }
      return Ref.getAndSet(input.workerFiberRef, null).pipe(
        Effect.flatMap((ownedWorkerFiber) =>
          ownedWorkerFiber === null
            ? Effect.void
            : Fiber.interrupt(ownedWorkerFiber).pipe(Effect.asVoid),
        ),
      );
    }),
  );
});

const runOrderedV2StartupPhases = Effect.fn("serverRuntimeStartup.runOrderedV2StartupPhases")(
  function* <
    Import,
    Recovery,
    Bootstrap,
    ImportError,
    RecoveryError,
    DelegationError,
    WorkerError,
    BootstrapError,
    ImportContext,
    RecoveryContext,
    DelegationContext,
    WorkerContext,
    BootstrapContext,
  >(input: {
    readonly importLegacyShells: Effect.Effect<Import, ImportError, ImportContext>;
    readonly recover: Effect.Effect<Recovery, RecoveryError, RecoveryContext>;
    readonly recoverDelegatedTasks: Effect.Effect<void, DelegationError, DelegationContext>;
    readonly startEffectWorker: Effect.Effect<void, WorkerError, WorkerContext>;
    readonly autoBootstrap: Effect.Effect<Bootstrap, BootstrapError, BootstrapContext>;
  }) {
    yield* input.importLegacyShells;
    const recovery = yield* input.recover;
    yield* input.recoverDelegatedTasks;
    yield* input.startEffectWorker;
    const bootstrap = yield* input.autoBootstrap;
    return { recovery, bootstrap } as const;
  },
);

const make = Effect.fn("serverRuntimeStartup.make")(function* (options?: StartupOptions) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const keybindings = yield* Keybindings.Keybindings;
  const legacyV1ThreadImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const providerRuntimeRecovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;

  const commandGate = yield* makeCommandGate;
  const httpListening = yield* Deferred.make<void>();
  const effectWorkerFiber = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* commandGate.failCommandReady(
        new ServerRuntimeStartupError({
          mode: serverConfig.mode,
          host: serverConfig.host ?? null,
          port: serverConfig.port,
          cause: "Server runtime is shutting down.",
        }),
      );
      const workerFiber = yield* Ref.getAndSet(effectWorkerFiber, null);
      if (workerFiber !== null) {
        yield* Fiber.interrupt(workerFiber).pipe(Effect.ignore);
      }
      yield* providerRuntimeRecovery.prepareForShutdown.pipe(
        Effect.ensuring(providerSessions.shutdown),
      );
      const reconciliation = yield* providerRuntimeRecovery.reconcile("shutdown");
      yield* Effect.logInfo("V2 orchestration shutdown reconciliation completed", reconciliation);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("V2 orchestration shutdown reconciliation failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );

  const startup = Effect.gen(function* () {
    yield* Effect.logDebug("startup phase: starting keybindings runtime");
    yield* runStartupPhase(
      "keybindings.start",
      keybindings.start.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to start keybindings runtime", {
            path: error.configPath,
            detail: error.detail,
            cause: error.cause,
          }),
        ),
      ),
    );

    yield* Effect.logDebug("startup phase: starting server settings runtime");
    yield* runStartupPhase(
      "settings.start",
      serverSettings.start.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to start server settings runtime", {
            path: error.settingsPath,
            operation: error.operation,
            providerInstanceId: error.providerInstanceId,
            environmentVariable: error.environmentVariable,
            cause: error.cause,
          }),
        ),
      ),
    );

    const welcomeBase = yield* resolveWelcomeBase;
    const environment = yield* serverEnvironment.getDescriptor;
    const legacyMigrationThreadCount = yield* legacyV1ThreadImporter.pendingThreadCount;
    if (legacyMigrationThreadCount > 0) {
      yield* lifecycleEvents.publish({
        version: 1,
        type: "legacyThreadMigration",
        payload: {
          status: "running",
          totalThreadCount: legacyMigrationThreadCount,
        },
      });
    }
    const { recovery, bootstrap: bootstrapTargets } = yield* runOrderedV2StartupPhases({
      importLegacyShells: runStartupPhase(
        "orchestration-v2.legacy-v1.import-shells",
        legacyV1ThreadImporter.reconcileShells.pipe(
          Effect.tap((summary) =>
            summary.importedThreadCount === 0
              ? Effect.void
              : Effect.logInfo("Imported legacy v1 thread shells", summary),
          ),
        ),
      ),
      recover: runStartupPhase("orchestration-v2.recovery", providerRuntimeRecovery.recover),
      recoverDelegatedTasks: runStartupPhase(
        "orchestration-v2.delegated-tasks.recover",
        orchestrator.recoverDelegatedTasks,
      ),
      startEffectWorker: runStartupPhase(
        "orchestration-v2.effect-worker.start",
        startEffectWorkerWithRelay({
          runWorker: EffectWorker.runDaemon,
          startRelay: agentAwarenessRelay.start(),
          workerFiberRef: effectWorkerFiber,
        }),
      ),
      autoBootstrap: (serverConfig.autoBootstrapProjectFromCwd
        ? runStartupPhase(
            "welcome.autobootstrap",
            resolveAutoBootstrapWelcomeTargets.pipe(Effect.provideService(Crypto.Crypto, crypto)),
          )
        : Effect.succeed({})
      ).pipe(Effect.map((targets): AutoBootstrapWelcomeTargets => targets)),
    });
    yield* Effect.logInfo("V2 orchestration recovery completed", recovery);
    yield* runStartupPhase("lecturn.reactors.start", startLecturnReactors);
    // Runs after activation: the status check fetches every enabled project's
    // remote, and awaiting it here held command readiness for that long.
    yield* runStartupPhase(
      "projects.auto-pull",
      Effect.gen(function* () {
        const shells = yield* (yield* ProjectStore.ProjectStoreV2).listShells();
        const staveShells = yield* Effect.serviceOption(StaveProjectShells);
        const projects = Option.isSome(staveShells)
          ? yield* staveShells.value.decorate(shells)
          : shells;
        const settings = yield* serverSettings.getSettings;
        yield* autoPullProjects(projects, settings);
      }),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to load projects for automatic pull", { cause }),
      ),
      forkParked,
    );

    const importPendingTranscripts = legacyV1ThreadImporter.importPendingTranscripts.pipe(
      Effect.tap((summary) =>
        summary.importedThreadCount === 0
          ? Effect.void
          : Effect.logInfo("Hydrated legacy v1 thread transcripts", summary),
      ),
    );
    yield* (
      legacyMigrationThreadCount > 0
        ? importPendingTranscripts.pipe(
            Effect.tap(() =>
              lifecycleEvents.publish({
                version: 1,
                type: "legacyThreadMigration",
                payload: {
                  status: "complete",
                  totalThreadCount: legacyMigrationThreadCount,
                },
              }),
            ),
          )
        : importPendingTranscripts
    ).pipe(forkParked);

    yield* forkParked(
      Effect.gen(function* () {
        yield* Effect.logDebug("startup phase: recording startup heartbeat");
        yield* recordStartupHeartbeat.pipe(
          Effect.withSpan("server.startup.heartbeat.record", {
            attributes: { "startup.phase": "heartbeat.record" },
          }),
          Effect.ignoreCause({ log: true }),
        );
        if (serverConfig.startupPresentation === "headless") {
          yield* Effect.logDebug("startup phase: headless access info");
          const accessInfo = yield* issueHeadlessServeAccessInfo();
          yield* runStartupPhase(
            "headless.output",
            Console.log(formatHeadlessServeOutput(accessInfo)),
          );
        } else {
          yield* Effect.logDebug("startup phase: browser open check");
          const startupBrowserTarget = yield* resolveStartupBrowserTarget;
          if (serverConfig.mode !== "desktop") {
            yield* announceStartupPairingUrl(startupBrowserTarget);
          }
          yield* runStartupPhase("browser.open", maybeOpenBrowser(startupBrowserTarget));
        }
      }),
    );

    yield* Effect.logDebug("startup phase: waiting for http listener");
    yield* runStartupPhase("http.wait", Deferred.await(httpListening));
    yield* runStartupPhase("auxiliary-roots.parked", options?.awaitAuxiliaryParked ?? Effect.void);

    const updateOutcome = yield* launcher.prepareTrial;

    yield* Effect.logDebug("startup phase: publishing welcome event", {
      environmentId: environment.environmentId,
      cwd: welcomeBase.cwd,
      projectName: welcomeBase.projectName,
      bootstrapProjectId: bootstrapTargets.bootstrapProjectId,
      bootstrapThreadId: bootstrapTargets.bootstrapThreadId,
    });
    yield* runStartupPhase(
      "welcome.publish",
      lifecycleEvents.publish({
        version: 1,
        type: "welcome",
        payload: {
          environment,
          ...welcomeBase,
          ...bootstrapTargets,
        },
      }),
    );

    yield* options?.activate ?? Effect.void;
    yield* Effect.logDebug("Accepting commands");
    yield* commandGate.signalCommandReady;
    yield* Effect.logDebug("startup phase: publishing ready event");
    yield* runStartupPhase(
      "ready.publish",
      lifecycleEvents.publish({
        version: 1,
        type: "ready",
        payload: {
          at: DateTime.formatIso(yield* DateTime.now),
          environment,
          ...(updateOutcome === undefined ? {} : { updateOutcome }),
        },
      }),
    );
    yield* Effect.logDebug("startup phase: complete");
    yield* flushCompileCache;
  }).pipe(
    Effect.withSpan("server.startup", {
      kind: "server",
      root: true,
      attributes: {
        "server.mode": serverConfig.mode,
        "server.port": serverConfig.port,
        "server.host": serverConfig.host ?? "default",
      },
    }),
  );

  yield* Effect.forkScoped(
    Effect.exit(startup).pipe(
      Effect.flatMap((startupExit) => {
        if (Exit.isSuccess(startupExit)) return Effect.void;
        const error = new ServerRuntimeStartupError({
          mode: serverConfig.mode,
          host: serverConfig.host ?? null,
          port: serverConfig.port,
          cause: startupExit.cause,
        });
        return Effect.logError("server runtime startup failed", {
          cause: Cause.pretty(startupExit.cause),
        }).pipe(
          Effect.andThen(commandGate.failCommandReady(error)),
          Effect.andThen(options?.abort?.(error) ?? Effect.void),
        );
      }),
    ),
  );

  return {
    awaitCommandReady: commandGate.awaitCommandReady,
    markHttpListening: Deferred.succeed(httpListening, undefined),
    enqueueCommand: commandGate.enqueueCommand,
  } satisfies ServerRuntimeStartup["Service"];
});

export const layerWithOptions = (options?: StartupOptions) =>
  Layer.effect(ServerRuntimeStartup, make(options));
