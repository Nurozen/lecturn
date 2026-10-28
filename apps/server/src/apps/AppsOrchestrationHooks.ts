/**
 * Connected apps' contribution to the Lecturn orchestration hook registry.
 * server.ts registers it beside the other fork contributions; later steps add
 * their hooks to this one contribution.
 */
import type { AppId, ProjectId } from "@lecturn/contracts";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  type LecturnCommandAdmissionInput,
  LecturnHookRejectedError,
  LecturnOrchestrationHooks,
  type LecturnRunTerminalNotice,
  type LecturnTurnStartInput,
} from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import {
  type AppRegistrationRecord,
  AppRegistrationRepository,
  layer as AppRegistrationRepositoryLayer,
} from "../persistence/AppRegistrations.ts";
import { formatAppContext, hostContextForTurn } from "./AppHostContextStore.ts";
import { RUNNING_STATUSES } from "./AppProjectService.ts";
import { type AppCredentialTools, AppRuntimeState } from "./AppRuntimeState.ts";
import { makeAppToolsUnavailableNotices } from "./appToolsUnavailableNotice.ts";
import { makeHeadlessReaper } from "./headlessReaper.ts";

const CONTRIBUTION = "apps";

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const registrations = yield* AppRegistrationRepository;
  const eventSink = yield* EventSink.EventSinkV2;
  const { headlessProcesses, hostContext } = yield* AppRuntimeState;
  const reaper = yield* makeHeadlessReaper((projectId) =>
    threads.getShellSnapshot({ projectId }).pipe(
      Effect.map((snapshot) =>
        snapshot.threads.some((thread) => RUNNING_STATUSES.has(thread.status)),
      ),
      // An unreadable projection keeps the process; the next run end retries.
      Effect.orElseSucceed(() => true),
    ),
  );

  /** Most servers run no headless process, so they skip the thread lookup. */
  const reapIdleHeadless = (notice: LecturnRunTerminalNotice) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(headlessProcesses)).size === 0) return;
      const thread = yield* threads.getThread(notice.threadId);
      yield* reaper.onProjectRunEnded(thread.projectId);
    }).pipe(Effect.ignore);

  /**
   * An app project's root is the app's own folder: the app finds the project
   * by it and its tools run there, so moving it would orphan both. The planner
   * stays upstream-shaped; the refusal lives here, inside the project lock.
   */
  const refuseAppWorkspaceMove = (input: LecturnCommandAdmissionInput) =>
    Effect.gen(function* () {
      if (input.scope !== "project") return;
      const { command } = input;
      if (command.type !== "project.meta.update" || command.workspaceRoot === undefined) return;
      const project = yield* projects.get(command.projectId).pipe(
        Effect.mapError(
          (cause) =>
            new LecturnHookRejectedError({
              hook: "aroundCommand",
              contribution: CONTRIBUTION,
              reason: "Could not read the project to check its app binding.",
              cause,
            }),
        ),
      );
      if (Option.isNone(project) || project.value.appBinding === undefined) return;
      return yield* new LecturnHookRejectedError({
        hook: "aroundCommand",
        contribution: CONTRIBUTION,
        reason: `This project belongs to the connected app ${project.value.appBinding.appId}; its folder cannot be changed.`,
      });
    });

  /**
   * A revoked or denied app keeps its project rows, so the binding alone does
   * not make its context or instructions current.
   */
  const grantedAppOf = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* projects.get(projectId);
      if (Option.isNone(project) || project.value.appBinding === undefined) {
        return Option.none<AppRegistrationRecord>();
      }
      const record = yield* registrations.get(project.value.appBinding.appId);
      return Option.filter(record, (entry) => entry.state === "granted");
    }).pipe(
      // A missing context or instruction must never cost the user the turn.
      Effect.catch((cause) =>
        Effect.logWarning("Could not read the connected app for a turn.", {
          projectId,
          cause,
        }).pipe(Effect.as(Option.none<AppRegistrationRecord>())),
      ),
    );

  const instructionsFor = (projectId: ProjectId) =>
    grantedAppOf(projectId).pipe(
      Effect.map(
        Option.flatMap((app) => Option.fromNullishOr(app.registration.instructions || undefined)),
      ),
    );

  /** Every cached name, model-visible or not: approving an unlisted one costs nothing. */
  const toolsFor = (appId: AppId) =>
    registrations.get(appId).pipe(
      Effect.map(
        Option.flatMap((record) =>
          record.state !== "granted"
            ? Option.none<AppCredentialTools>()
            : Option.some({
                toolPrefix: record.registration.toolPrefix,
                toolNames: [
                  ...new Set(
                    [
                      ...(record.cachedHeadlessTools ?? []),
                      ...(record.registration.liveTools ? (record.cachedLiveTools ?? []) : []),
                    ].map((tool) => `${record.registration.toolPrefix}_${tool.name}`),
                  ),
                ],
              }),
        ),
      ),
      // Without names the provider may ask about app tools too; the call still works.
      Effect.orElseSucceed(() => Option.none<AppCredentialTools>()),
    );

  const toolsUnavailableNotice = makeAppToolsUnavailableNotices({
    threads,
    eventSink,
    grantedAppName: (projectId) =>
      grantedAppOf(projectId).pipe(Effect.map(Option.map((app) => app.registration.name))),
  });

  /** Most turns are on servers where no app ever set context, so they skip both reads. */
  const hostContextPrefix = (input: LecturnTurnStartInput) =>
    Effect.gen(function* () {
      if (input.compaction) return;
      const text = hostContextForTurn(
        yield* Ref.get(hostContext),
        input.thread.id,
        input.thread.projectId,
      );
      if (Option.isNone(text)) return;
      const app = yield* grantedAppOf(input.thread.projectId);
      if (Option.isNone(app)) return;
      return { contextPrefix: formatAppContext(app.value.appId, text.value) };
    });

  return {
    instructionsFor,
    toolsFor,
    toolsUnavailableNotice,
    name: CONTRIBUTION,
    aroundCommand: <A, E, R>(input: LecturnCommandAdmissionInput, commit: Effect.Effect<A, E, R>) =>
      refuseAppWorkspaceMove(input).pipe(Effect.andThen(commit)),
    beforeTurnStart: hostContextPrefix,
    onRunTerminal: reapIdleHeadless,
  };
});

/** Tests give it their own event sink; `layer` gives it the runtime's. */
export const layerWithoutEventSink = Layer.effectDiscard(
  Effect.gen(function* () {
    const hooks = yield* LecturnOrchestrationHooks;
    const { appInstructions, appTools } = yield* AppRuntimeState;
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const { instructionsFor, toolsFor, toolsUnavailableNotice, ...contribution } = yield* make;
    yield* hooks.register(contribution);
    yield* Effect.acquireRelease(Ref.set(appInstructions, Option.some(instructionsFor)), () =>
      Ref.set(appInstructions, Option.none()),
    );
    yield* Effect.acquireRelease(Ref.set(appTools, Option.some(toolsFor)), () =>
      Ref.set(appTools, Option.none()),
    );
    // Adapters report activation outside any hook call (a reused session's
    // thread, a startup failure after ensureThread), so it is a stream here.
    const activations = yield* mcpSessions.subscribeActivations;
    yield* activations.pipe(Stream.runForEach(toolsUnavailableNotice), Effect.forkScoped);
  }),
).pipe(Layer.provide(AppRegistrationRepositoryLayer));

export const layer = layerWithoutEventSink.pipe(Layer.provide(RuntimeLayer.layerEventSink));
