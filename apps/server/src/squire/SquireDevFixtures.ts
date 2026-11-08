/**
 * Sandbox threads under `<lecturn home>/squire-fixtures/` are fixture-owned: `inject` is their only row source and
 * they run on the scripted provider, so nothing on them reaches a real provider.
 * Provided only with the switch on and `LECTURN_TEST_PROVIDERS=1`.
 * @module squire/SquireDevFixtures
 */
import {
  CommandId,
  DEFAULT_SQUIRE_BUDGETS,
  DEFAULT_SQUIRE_COMPANION,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  ProjectId,
  type ProviderInstanceId,
  type RunId,
  SquireBudgets,
  SquireCompanion,
  SquireCreateInput,
  SquireEvent,
  SquireEventToggles,
  SquireFixtureSetup,
  type SquireFakeScript,
  type SquireFixtureContainer,
  type SquireFixtureTimelineAction,
  type SquireGrantKind,
  type SquireId,
  SquirePermissions,
  type SquirePullRequestSnapshot,
  SquireSweepSettings,
  SquireTurnSummary,
  type ThreadId,
  type ThreadPullRequestSnapshot,
  type UnknownUnionMember,
  isUnknownUnionMember,
} from "@lecturn/contracts";
import { threadPullRequestKeyOf } from "../sourceControl/threadPullRequests.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import {
  readPath,
  type ScriptedScript,
  ScriptedScript as ScriptedScriptSchema,
  type ScriptedStep,
} from "../orchestration-v2/Adapters/scriptedScript.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { FIXTURE_PULL_REQUEST_HOST } from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SquireContainers from "./SquireContainers.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquireFakeScripts from "./SquireFakeScripts.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquireReactor from "./SquireReactor.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireScope from "./SquireScope.ts";
import * as SquireService from "./SquireService.ts";
import { SquireHooks } from "./squireHooks.ts";
import type { SquireSummaryStage } from "./SquireSummaries.ts";
import { type SquireEventPayload, SquireEventPayloadJson } from "./squireEvents.ts";

export class SquireDevFixturesError extends Schema.TaggedError<SquireDevFixturesError>()(
  "SquireDevFixturesError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Squire fixture: ${this.detail}`;
  }
}

/** A timeline action this phase cannot perform yet; a runner must fail on it, not skip it. */
export class SquireFixtureActionUnavailable extends Schema.TaggedError<SquireFixtureActionUnavailable>()(
  "SquireFixtureActionUnavailable",
  { action: Schema.String, phase: Schema.Number, detail: Schema.String },
) {
  override get message(): string {
    return `Squire fixture ${this.action} is not available until phase ${this.phase}: ${this.detail}`;
  }
}

export type SquireDevFixturesFailure = SquireDevFixturesError | SquireFixtureActionUnavailable;

export interface SquireFixtureLoadOptions {
  /** `--set` overrides: dot paths relative to `setup`, applied before it is decoded. */
  readonly set?: Readonly<Record<string, unknown>>;
  /** The main Squire's `squireFake` script; its home thread then runs it. */
  readonly fake?: SquireFakeScript;
  /** The instance an `under-test` Squire runs on; the scripted instance when absent. */
  readonly providerInstanceId?: ProviderInstanceId;
}

export interface SquireFixtureLoaded {
  /** The setup's own Squire, or the Lead for `role: lead`. */
  readonly squireId: SquireId;
  readonly homeThreadId: ThreadId | null;
  readonly squires: Readonly<Record<string, SquireId>>;
  readonly projects: Readonly<Record<string, ProjectId>>;
}

export interface SquireFixtureInjectOptions {
  /** Which fixture Squire a thread-less event goes to; the last loaded main Squire by default. */
  readonly squire?: string;
}

/** A stored injected summary, for the post-store hooks such as overlap detection. */
export interface SquireInjectedSummary {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly stage: SquireSummaryStage;
  readonly summary: SquireTurnSummary;
}

export class SquireDevFixtures extends Context.Service<
  SquireDevFixtures,
  {
    /** Idempotent: a second load updates the same records. Never pauses the Lead. */
    readonly loadSetup: (
      setup: SquireFixtureSetup,
      options?: SquireFixtureLoadOptions,
    ) => Effect.Effect<SquireFixtureLoaded, SquireDevFixturesFailure>;
    /** The event's row id, or the original's for a deduped event. */
    readonly inject: (
      event: SquireEvent,
      options?: SquireFixtureInjectOptions,
    ) => Effect.Effect<number, SquireDevFixturesFailure>;
    /**
     * Resolves once the rows `inject` wrote for `sequence` settle (delivered
     * or dropped), which is after the home run that consumed their batch
     * ended, and then the effect worker and the reactor are drained.
     */
    readonly drainThrough: (sequence: number) => Effect.Effect<void, SquireDevFixturesFailure>;
    readonly timeline: (
      action: SquireFixtureTimelineAction,
    ) => Effect.Effect<void, SquireDevFixturesFailure>;
    /** Deletes the fixture Squire with this name; a no-op when there is none. */
    readonly reset: (name: string) => Effect.Effect<void, SquireDevFixturesFailure>;
    /** The bar harness option. Nothing reachable from the dev route calls it. */
    readonly pauseLeadForHarness: Effect.Effect<void, SquireDevFixturesFailure>;
  }
>()("lecturn/squire/SquireDevFixtures") {}

// ── Fake scripts ──

const TEMPLATE = /\{\{\s*event((?:\.[A-Za-z0-9_]+)+)\s*\}\}/g;
const WHOLE_TEMPLATE = /^\{\{\s*event((?:\.[A-Za-z0-9_]+)+)\s*\}\}$/;

/**
 * Fills `{{event.<path>}}` from the delivered event. A string that is only
 * one template takes the value with its JSON type; a path the event lacks
 * (or no event yet) leaves the template as written.
 */
function fillEventTemplates(value: unknown, event: unknown): unknown {
  if (typeof value === "string") {
    if (event === undefined) return value;
    const whole = WHOLE_TEMPLATE.exec(value);
    if (whole !== null) {
      const found = readPath(event, whole[1]!.slice(1));
      return found.found ? found.value : value;
    }
    return value.replace(TEMPLATE, (match, path: string) => {
      const found = readPath(event, path.slice(1));
      if (!found.found) return match;
      return typeof found.value === "string" ? found.value : JSON.stringify(found.value);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => fillEventTemplates(entry, event));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, fillEventTemplates(entry, event)]),
    );
  }
  return value;
}

/**
 * The first step per `onEvent` key, templates unfilled; a `*` step shadows every later step.
 * Tool calls become real `tools/call`s; a refused one is recorded and the turn goes on, as a model reads a refusal.
 */
export function squireFakeScriptSet(
  script: SquireFakeScript,
): SquireFakeScripts.SquireFakeScriptSet {
  const set: Record<string, ScriptedScript> = {};
  for (const step of script.steps) {
    if (Object.hasOwn(set, SquireFakeScripts.ANY_KIND)) break;
    if (Object.hasOwn(set, step.onEvent)) continue;
    const steps: Array<ScriptedStep> = [
      ...(step.toolCalls ?? []).map((call): ScriptedStep => ({
        toolCall: { name: call.name, arguments: call.args },
        onError: "continue",
      })),
      ...(step.askUser === undefined
        ? []
        : [{ askUser: { question: step.askUser.question, options: step.askUser.options } }]),
      ...(step.hold === true ? [{ hold: true as const }] : []),
    ];
    set[step.onEvent] = steps;
  }
  return set;
}

/** Fills each tool call's `{{event.*}}` arguments from the event the turn was woken by. */
export function fillSquireFakeScript(script: ScriptedScript, event: unknown): ScriptedScript {
  return script.map((step) =>
    "toolCall" in step && step.toolCall.arguments !== undefined
      ? {
          ...step,
          toolCall: {
            ...step.toolCall,
            arguments: fillEventTemplates(step.toolCall.arguments, event) as Record<
              string,
              unknown
            >,
          },
        }
      : step,
  );
}

// ── Setup helpers ──

/** Applies `--set` paths (`a.b.0.c`) to the encoded setup. */
export function applyFixtureOverrides(
  setup: unknown,
  overrides: Readonly<Record<string, unknown>>,
): unknown {
  const root = structuredClone(setup) as Record<string, unknown>;
  for (const [path, value] of Object.entries(overrides)) {
    const segments = path.split(".").filter((segment) => segment.length > 0);
    let current: Record<string, unknown> = root;
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        current[segment] = value;
        return;
      }
      const next = current[segment];
      if (typeof next !== "object" || next === null) {
        current[segment] = /^\d+$/.test(segments[index + 1]!) ? [] : {};
      }
      current = current[segment] as Record<string, unknown>;
    });
  }
  return root;
}

const slugOf = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "project";

const FIXTURE_HOME_PROJECT = "Squire fixtures";
const fixtureRequestId = (name: string) => `fixture:${name}`;

type KnownEvent = Exclude<SquireEvent, UnknownUnionMember>;
type ThreadEvent = Extract<
  KnownEvent,
  { readonly type: "turn-finished" | "thread-stopped" | "waiting-on-user" | "pull-request-changed" }
>;
type OtherEvent = Exclude<KnownEvent, ThreadEvent>;

const isThreadEvent = (event: KnownEvent): event is ThreadEvent =>
  event.type === "turn-finished" ||
  event.type === "thread-stopped" ||
  event.type === "waiting-on-user" ||
  event.type === "pull-request-changed";

/** The evidence the delivered batch quotes; the rest reaches the run another way. */
const quotedEvidence = (evidence: ThreadEvent["evidence"]) => {
  if (evidence === undefined) return undefined;
  const { errorLines, headBranch, diffStats } = evidence;
  const quoted = {
    ...(errorLines === undefined || errorLines.length === 0 ? {} : { errorLines }),
    ...(headBranch === undefined ? {} : { headBranch }),
    ...(diffStats === undefined ? {} : { diffStats }),
  };
  return Object.keys(quoted).length === 0 ? undefined : quoted;
};

/** The dedupe key the reactor or the trigger service would give the event. */
const otherStateKey = (event: OtherEvent): string => {
  switch (event.type) {
    case "voice-note":
      return event.voiceNoteId;
    case "onboarding":
      return "onboarding";
    case "digest-due":
      return event.date;
    case "item-raised":
      return `${event.cardId}:raised`;
    case "item-resolved":
      return `${event.cardId}:resolved`;
    case "routed-task":
      return event.taskId;
    case "schedule-due":
      return `${event.triggerId}:${event.slot}`;
    case "webhook-received":
      return `${event.triggerId}:${event.deliveryId}`;
    case "sweep-due":
      return event.sweepKey;
    case "message":
      return event.messageKey;
    case "room-proposed":
      return event.proposalId;
  }
};

/** The link snapshot an event's PR claims: head, checks, review, merge state. */
function fixturePullRequestSnapshot(
  pr: SquirePullRequestSnapshot,
  input: { readonly title: string; readonly headBranch?: string; readonly at: string },
): ThreadPullRequestSnapshot {
  const checksState =
    pr.transition === "checks:failed" || pr.checks.failed > 0
      ? "failing"
      : pr.transition === "checks:passed" || pr.checks.passed > 0
        ? "passing"
        : null;
  return {
    state: pr.merged ? "merged" : pr.closed ? "closed" : "open",
    title: input.title,
    headBranch: input.headBranch ?? `fixture/${pr.number}`,
    baseBranch: pr.baseBranch,
    isDraft: false,
    updatedAt: input.at,
    syncedAt: input.at,
    reviewDecision: pr.review === "none" ? null : pr.review,
    checksState,
    mergeability:
      pr.mergeable === "mergeable"
        ? "mergeable"
        : pr.mergeable === "conflicts"
          ? "conflicting"
          : "unknown",
    headSha: pr.headSha,
  };
}

/** Stopped runs capture a checkpoint too; failed and rolled-back runs capture none. */
const isSettledRun = (run: OrchestrationV2Run) =>
  run.status === "completed" ||
  run.status === "failed" ||
  run.status === "rolled_back" ||
  ((run.status === "interrupted" || run.status === "cancelled") && run.checkpointId !== null);
const SETTLED_ROW_STATUSES: ReadonlySet<string> = new Set(["delivered", "dropped"]);

const decodeSetup = Schema.decodeUnknownEffect(SquireFixtureSetup);
const encodeSetup = Schema.encodeSync(SquireFixtureSetup);
const decodeEvent = Schema.decodeUnknownEffect(SquireEvent);
const encodeEventJson = Schema.encodeSync(Schema.fromJsonString(SquireEvent));
const decodeEventJson = Schema.decodeUnknownOption(Schema.fromJsonString(SquireEvent));
const encodeSummary = Schema.encodeSync(Schema.fromJsonString(SquireTurnSummary));
const encodePayload = Schema.encodeSync(SquireEventPayloadJson);
const encodePermissions = Schema.encodeSync(Schema.fromJsonString(SquirePermissions));
const encodeBudgets = Schema.encodeSync(Schema.fromJsonString(SquireBudgets));
const decodeBudgets = Schema.decodeUnknownOption(Schema.fromJsonString(SquireBudgets));
const encodeToggles = Schema.encodeSync(Schema.fromJsonString(SquireEventToggles));
const decodeToggles = Schema.decodeUnknownOption(Schema.fromJsonString(SquireEventToggles));
const DEFAULT_TOGGLES = Schema.decodeSync(SquireEventToggles)({});
const encodeCompanion = Schema.encodeSync(Schema.fromJsonString(SquireCompanion));
const decodeCompanionJson = Schema.decodeUnknownOption(Schema.fromJsonString(SquireCompanion));
const encodeCompanionValue = Schema.encodeSync(SquireCompanion);
const decodeCompanionValue = Schema.decodeUnknownEffect(SquireCompanion);
const encodeSweep = Schema.encodeSync(Schema.fromJsonString(SquireSweepSettings));
const decodeCreateInput = Schema.decodeUnknownEffect(SquireCreateInput);
const encodeScript = Schema.encodeSync(Schema.fromJsonString(ScriptedScriptSchema));
const isOurError = Schema.is(
  Schema.Union([SquireDevFixturesError, SquireFixtureActionUnavailable]),
);

const fail = (detail: string) => Effect.fail(new SquireDevFixturesError({ detail }));

/** Every failure crosses the service boundary as a fixture error carrying its cause. */
const asFixtureError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, SquireDevFixturesFailure, R> =>
    effect.pipe(
      Effect.mapError((error) =>
        isOurError(error)
          ? error
          : new SquireDevFixturesError({
              detail: `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
            }),
      ),
    );

interface FixtureFake {
  readonly homeThreadId: ThreadId;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repository = yield* SquireRepository.SquireRepository;
  const service = yield* SquireService.SquireService;
  const scope = yield* SquireScope.SquireScope;
  const reactor = yield* SquireReactor.SquireReactor;
  const delivery = yield* SquireDelivery.SquireDelivery;
  const policyLock = yield* SquirePolicyLock.SquirePolicyLock;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectService = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const worker = yield* Effect.serviceOption(EffectWorker.OrchestrationEffectWorkerV2);
  const fakes = yield* Effect.serviceOption(SquireFakeScripts.SquireFakeScripts);
  const fixtureStave = yield* Effect.serviceOption(SquireContainers.SquireFixtureStave);
  // Injected summaries run the same post-store hooks as live ones.
  const postStore = yield* Effect.serviceOption(SquireHooks);

  const mainSquire = yield* Ref.make(Option.none<SquireId>());
  const fakeBySquire = yield* Ref.make(new Map<SquireId, FixtureFake>());
  // The event each injected row stands for: a thread event's row holds only its payload.
  const injectedEvents = yield* Ref.make(new Map<number, KnownEvent>());
  // The rows one inject wrote, so its sequence waits for every tracking Squire's.
  const injected = yield* Ref.make(new Map<number, ReadonlyArray<number>>());

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const sandboxRoot = path.join(config.baseDir, "squire-fixtures");

  const drainWorker = Option.isSome(worker) ? Effect.asVoid(worker.value.drain()) : Effect.void;

  /**
   * Re-checks `check` after each committed event on the thread, driving the
   * effect worker between checks, until it yields a value.
   */
  const awaitThread = Effect.fn("SquireDevFixtures.awaitThread")(function* <A, E, R>(
    threadId: ThreadId,
    check: Effect.Effect<Option.Option<A>, E, R>,
  ) {
    for (;;) {
      const head = yield* events.latestApplicationSequence;
      yield* drainWorker;
      const found = yield* check;
      if (Option.isSome(found)) return found.value;
      yield* events.streamApplicationEvents({ afterSequence: head }).pipe(
        Stream.filter((stored) => "event" in stored && stored.event.threadId === threadId),
        Stream.runHead,
      );
    }
  });

  // ── Scripted provider ──

  const scriptedModel = Effect.gen(function* () {
    const instance = (yield* providers.listInstances).find(
      (candidate) => String(candidate.driverKind) === "scripted",
    );
    if (instance === undefined) {
      return yield* fail("no scripted provider instance; set LECTURN_TEST_PROVIDERS=1");
    }
    const models = (yield* instance.snapshot.getSnapshot).models;
    const model = models.find((candidate) => candidate.isDefault) ?? models[0];
    if (model === undefined) return yield* fail("the scripted provider lists no model");
    return { instanceId: instance.instanceId, model: model.slug } satisfies ModelSelection;
  });

  // ── Projects and threads ──

  const isFixtureProjectId = (projectId: ProjectId) =>
    projects
      .get(projectId, { includeDeleted: true })
      .pipe(
        Effect.map(
          (project) =>
            Option.isSome(project) &&
            SquireReactor.isFixtureWorkspaceRoot(config.baseDir, project.value.workspaceRoot),
        ),
      );

  /** Reuses only the sandbox project a fixture made, never a real project of the same name. */
  const ensureProject = Effect.fn("SquireDevFixtures.ensureProject")(function* (name: string) {
    const dir = path.join(sandboxRoot, slugOf(name));
    yield* fileSystem.makeDirectory(dir, { recursive: true });
    const workspaceRoot = yield* fileSystem.realPath(dir);
    const existing = yield* projects.findActiveByWorkspaceRoot(workspaceRoot);
    if (Option.isSome(existing)) return existing.value.projectId;
    const projectId = ProjectId.make(`project-fixture-${slugOf(name)}-${yield* uniqueSuffix}`);
    yield* projectService.create({
      commandId: CommandId.make(`fixture:project:${projectId}`),
      projectId,
      title: name,
      workspaceRoot,
    });
    return projectId;
  });

  const uniqueSuffix = crypto.randomUUIDv4().pipe(
    Effect.orDie,
    Effect.map((uuid) => uuid.slice(0, 8)),
  );

  const ensureThread = Effect.fn("SquireDevFixtures.ensureThread")(function* (
    thread: NonNullable<SquireFixtureSetup["threads"]>[number],
    projectId: ProjectId,
    modelSelection: ModelSelection,
  ) {
    const shell = yield* projections.getThreadShell(thread.threadId);
    if (shell !== null) {
      if (!(yield* isFixtureProjectId(shell.projectId))) {
        return yield* fail(`thread ${thread.threadId} already exists outside the fixtures`);
      }
      if (shell.title !== thread.title) {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`fixture:thread-title:${thread.threadId}:${thread.title}`),
          threadId: thread.threadId,
          title: thread.title,
        });
      }
      if (thread.branch !== undefined && shell.branch !== thread.branch) {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`fixture:thread-branch:${thread.threadId}:${thread.branch}`),
          threadId: thread.threadId,
          branch: thread.branch,
        });
      }
      return;
    }
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`fixture:thread:${thread.threadId}`),
      threadId: thread.threadId,
      projectId,
      title: thread.title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: thread.branch ?? null,
      worktreePath: null,
      createdBy: "system",
      creationSource: "server",
    });
  });

  const requireFixtureThread = Effect.fn("SquireDevFixtures.requireFixtureThread")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* projections.getThreadShell(threadId);
    if (shell === null) return yield* fail(`thread ${threadId} does not exist`);
    if (!(yield* isFixtureProjectId(shell.projectId))) {
      return yield* fail(`thread ${threadId} is not fixture-owned`);
    }
    return shell;
  });

  // ── Squire records ──

  type SquireConfig = Pick<
    SquireFixtureSetup,
    | "scope"
    | "exclusions"
    | "permissions"
    | "undoWindowSeconds"
    | "budgetUsage"
    | "companion"
    | "waitingThresholdMinutes"
    | "rules"
    | "triggers"
  >;

  type Grants = ReadonlyArray<{ readonly kind: SquireGrantKind; readonly targetId: string }>;

  interface SquirePlan {
    readonly config: SquireConfig;
    /** Absent leaves the record's brief, grants, or companion as they are. */
    readonly brief?: string;
    readonly grants?: Grants;
    /** `--set companion.*` paths over the record's own companion, when the fixture names none. */
    readonly companionSet?: Readonly<Record<string, unknown>>;
  }

  /**
   * A fixture's own Squire takes everything; a reused user Squire takes only the companion and permissions sections
   * and `--set`. Neither gets a companion the fixture does not name (it would reset to the default figure).
   */
  const planSquire = (input: {
    readonly declared: Partial<SquireConfig>;
    readonly config: SquireConfig;
    readonly brief: string;
    readonly overrides: Readonly<Record<string, unknown>>;
    readonly briefPath: string;
    readonly owned: boolean;
  }): Omit<SquirePlan, "grants"> & { readonly writesGrants: boolean } => {
    const paths = Object.keys(input.overrides);
    const touched = (key: string) =>
      paths.some((path) => path === key || path.startsWith(`${key}.`));
    const companionSet = Object.fromEntries(
      Object.entries(input.overrides).flatMap(([path, value]) =>
        path.startsWith("companion.") ? [[path.slice("companion.".length), value]] : [],
      ),
    );
    const companionNamed =
      input.declared.companion !== undefined || Object.hasOwn(input.overrides, "companion");
    const { companion, ...rest } = input.config;
    const kept: SquireConfig = input.owned
      ? rest
      : Object.fromEntries(
          Object.entries(rest).filter(
            ([key]) =>
              touched(key) || (key === "permissions" && input.declared.permissions !== undefined),
          ),
        );
    return {
      config: { ...kept, ...(companionNamed && companion !== undefined ? { companion } : {}) },
      ...(input.owned || touched(input.briefPath) ? { brief: input.brief } : {}),
      ...(!companionNamed && Object.keys(companionSet).length > 0 ? { companionSet } : {}),
      writesGrants: input.owned || touched("scope") || touched("exclusions"),
    };
  };

  const grantsOf = Effect.fn("SquireDevFixtures.grantsOf")(function* (
    containers: ReadonlyArray<SquireFixtureContainer>,
    exclusions: ReadonlyArray<ThreadId>,
    projectIds: ReadonlyMap<string, ProjectId>,
  ) {
    const grants: Array<{ readonly kind: SquireGrantKind; readonly targetId: string }> = [];
    for (const container of containers) {
      switch (container.kind) {
        case "project":
          grants.push({ kind: "project", targetId: projectIds.get(container.name)! });
          break;
        case "thread":
          yield* requireFixtureThread(container.threadId);
          grants.push({ kind: "thread", targetId: container.threadId });
          break;
        case "staveSpace":
        case "staveSaga":
          grants.push({ kind: container.kind, targetId: syntheticStaveId(container) });
          break;
      }
    }
    for (const threadId of exclusions) grants.push({ kind: "exclusion", targetId: threadId });
    return grants;
  });

  /** Config, grants, and budget usage written straight to the record, Auto included. */
  const writeConfig = (
    squireId: SquireId,
    input: SquirePlan & {
      readonly sweep?: SquireSweepSettings;
      readonly lead: boolean;
    },
  ) =>
    policyLock.withPolicyLock(
      repository.transaction(
        Effect.gen(function* () {
          const row = yield* repository.getSquire(squireId);
          if (Option.isNone(row)) return yield* fail(`Squire ${squireId} vanished`);
          const now = yield* nowIso;
          const { config } = input;
          const budgets = Option.getOrElse(
            decodeBudgets(row.value.budgets_json),
            () => DEFAULT_SQUIRE_BUDGETS,
          );
          const toggles = Option.getOrElse(
            decodeToggles(row.value.events_json),
            () => DEFAULT_TOGGLES,
          );
          const companion =
            config.companion ??
            (input.companionSet === undefined
              ? undefined
              : yield* decodeCompanionValue(
                  applyFixtureOverrides(
                    encodeCompanionValue(
                      Option.getOrElse(
                        decodeCompanionJson(row.value.companion_json),
                        () => DEFAULT_SQUIRE_COMPANION,
                      ),
                    ),
                    input.companionSet,
                  ),
                ));
          const permissions =
            config.permissions === undefined
              ? undefined
              : input.lead
                ? {
                    ...config.permissions,
                    manageSquires: config.permissions.manageSquires ?? ("recommend" as const),
                  }
                : config.permissions;
          yield* repository.updateSquire({
            id: squireId,
            updatedAt: now,
            patch: {
              ...(input.brief === undefined ? {} : { brief: input.brief }),
              ...(permissions === undefined
                ? {}
                : { permissions_json: encodePermissions(permissions) }),
              ...(config.undoWindowSeconds === undefined
                ? {}
                : { undo_window_seconds: config.undoWindowSeconds }),
              ...(config.budgetUsage === undefined
                ? {}
                : {
                    budgets_json: encodeBudgets({
                      ...budgets,
                      steersPerDay: config.budgetUsage.steersPerDay.limit,
                      threadsPerDay: config.budgetUsage.threadsPerDay.limit,
                      steersPerThreadPerHour: config.budgetUsage.steersPerThreadPerHour.limit,
                    }),
                  }),
              ...(config.waitingThresholdMinutes === undefined
                ? {}
                : {
                    events_json: encodeToggles({
                      ...toggles,
                      waitingThresholdMinutes: config.waitingThresholdMinutes,
                    }),
                  }),
              ...(companion === undefined
                ? {}
                : {
                    companion_json: encodeCompanion(
                      input.lead ? { ...companion, palette: "gold" } : companion,
                    ),
                  }),
              ...(input.sweep === undefined ? {} : { sweep_json: encodeSweep(input.sweep) }),
            },
          });
          if (input.grants !== undefined) {
            const wanted = new Set(input.grants.map((grant) => `${grant.kind}\0${grant.targetId}`));
            for (const grant of yield* repository.listGrants(squireId)) {
              if (!wanted.has(`${grant.kind}\0${grant.target_id}`)) {
                yield* repository.deleteGrant({
                  squireId,
                  kind: grant.kind,
                  targetId: grant.target_id,
                });
              }
            }
            for (const grant of input.grants) {
              yield* repository.insertGrant({
                squire_id: squireId,
                kind: grant.kind,
                target_id: grant.targetId,
                origin: "granted",
                created_at: now,
              });
            }
          }
          if (config.budgetUsage !== undefined)
            yield* seedBudget(squireId, config.budgetUsage, now);
        }),
      ),
    );

  /** Usage rows only, never log rows, so seeding never counts as a scenario effect. */
  const seedBudget = Effect.fn("SquireDevFixtures.seedBudget")(function* (
    squireId: SquireId,
    usage: NonNullable<SquireFixtureSetup["budgetUsage"]>,
    executedAt: string,
  ) {
    yield* repository.deleteBudgetUsage(squireId);
    const row = (kind: "steer" | "thread", threadId: ThreadId | null) =>
      repository.insertBudgetUsage({
        squire_id: squireId,
        thread_id: threadId,
        kind,
        room_id: null,
        executed_at: executedAt,
        execution_key: null,
      });
    let steers = 0;
    for (const [threadId, count] of Object.entries(usage.steersPerThreadPerHour.usedByThread)) {
      for (let index = 0; index < count; index++) yield* row("steer", threadId as ThreadId);
      steers += count;
    }
    for (; steers < usage.steersPerDay.used; steers++) yield* row("steer", null);
    for (let index = 0; index < usage.threadsPerDay.used; index++) yield* row("thread", null);
  });

  const syntheticStaveId = (container: { readonly kind: string; readonly name: string }) =>
    `fixture-${container.kind === "staveSaga" ? "saga" : "space"}:${slugOf(container.name)}`;

  /** Each Squire record's provider, switched through the service so the home thread follows. */
  const ensureProvider = Effect.fn("SquireDevFixtures.ensureProvider")(function* (
    squireId: SquireId,
    instanceId: ProviderInstanceId,
  ) {
    const row = yield* repository.getSquire(squireId);
    if (Option.isNone(row) || row.value.provider_instance_id === instanceId) return;
    yield* service.update({
      requestId: `fixture:provider:${squireId}:${instanceId}:${row.value.revision}`,
      squireId,
      expectedRevision: row.value.revision,
      providerInstanceId: instanceId,
    });
  });

  /** A fixture's own Squire first, then one the user made with that name. */
  const squireNamed = Effect.fn("SquireDevFixtures.squireNamed")(function* (name: string) {
    const owned = yield* repository.getSquireByCreateRequestId(fixtureRequestId(name));
    if (Option.isSome(owned) && owned.value.lifecycle !== "deleting") {
      return Option.some({ id: owned.value.id, owned: true });
    }
    const wanted = name.trim().toLowerCase();
    const user = (yield* repository.listSquires).find(
      (row) =>
        row.role === "squire" &&
        row.lifecycle !== "deleting" &&
        row.name.trim().toLowerCase() === wanted,
    );
    return user === undefined ? Option.none() : Option.some({ id: user.id, owned: false });
  });

  /**
   * A user's Squire with the fixture's name is reused rather than duplicated,
   * and keeps its provider; `planSquire` limits what the fixture changes on it.
   */
  const upsertSquire = Effect.fn("SquireDevFixtures.upsertSquire")(function* (input: {
    readonly name: string;
    readonly homeProjectId: ProjectId;
    readonly instanceId: ProviderInstanceId;
  }) {
    const existing = yield* squireNamed(input.name);
    if (Option.isSome(existing)) {
      if (existing.value.owned) yield* ensureProvider(existing.value.id, input.instanceId);
      return existing.value;
    }
    const created = yield* service.create(
      yield* decodeCreateInput({
        requestId: fixtureRequestId(input.name),
        homeProjectId: input.homeProjectId,
        providerInstanceId: input.instanceId,
        name: input.name,
        brief: "",
        grants: [],
        events: {},
        permissions: {},
        budgets: {},
      }),
    );
    return { id: created.id, owned: true };
  });

  const ensureLead = Effect.fn("SquireDevFixtures.ensureLead")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const lead = yield* service.ensureLead({ requestId: "fixture" });
    if (Option.isNone(lead)) return yield* fail("no project to home the Lead in");
    yield* ensureProvider(lead.value.id, instanceId);
    return lead.value.id;
  });

  const setFake = Effect.fn("SquireDevFixtures.setFake")(function* (
    squireId: SquireId,
    fake: SquireFakeScript,
  ) {
    if (Option.isNone(fakes)) {
      return yield* fail("fake scripts need the scripted provider's script registry");
    }
    const row = yield* repository.getSquire(squireId);
    const homeThreadId = Option.isSome(row) ? row.value.home_thread_id : null;
    if (homeThreadId === null) return yield* fail("the fixture Squire has no home thread yet");
    const entry: FixtureFake = { homeThreadId };
    yield* Ref.update(fakeBySquire, (current) => new Map(current).set(squireId, entry));
    yield* fakes.value.set(homeThreadId, squireFakeScriptSet(fake), fillFromBatch);
  });

  /**
   * `{{event.*}}` reads the batch that woke the turn: its first event of the
   * picked kind (its first event for `*`). A typed message names no batch, so
   * its templates stay as written.
   */
  const fillFromBatch: SquireFakeScripts.SquireFakeFill = Effect.fn(
    "SquireDevFixtures.fillFromBatch",
  )(
    function* ({ kind, script, message }) {
      const batch = SquireDelivery.parseSquireMessageId(message.messageId);
      if (Option.isNone(batch)) return script;
      const rows = yield* repository.listBatch(batch.value.batchId);
      const row =
        kind === SquireFakeScripts.ANY_KIND ? rows[0] : rows.find((entry) => entry.kind === kind);
      if (row === undefined) return script;
      const event =
        (yield* Ref.get(injectedEvents)).get(row.id) ??
        Option.getOrUndefined(decodeEventJson(row.payload_json));
      return fillSquireFakeScript(script, event);
    },
    (effect, { script }) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Squire fake could not read its batch", error).pipe(Effect.as(script)),
        ),
      ),
  );

  const noteInjected = (ids: ReadonlyArray<number>, event: KnownEvent) =>
    Ref.update(injectedEvents, (current) => {
      const next = new Map(current);
      for (const id of ids) next.set(id, event);
      return next;
    });

  const loadSetup: SquireDevFixtures["Service"]["loadSetup"] = Effect.fn(
    "SquireDevFixtures.loadSetup",
  )(function* (input, options = {}) {
    const overrides = options.set ?? {};
    const setup =
      Object.keys(overrides).length === 0
        ? input
        : yield* decodeSetup(applyFixtureOverrides(encodeSetup(input), overrides));
    const configs: ReadonlyArray<SquireConfig> = [setup, ...(setup.squires ?? [])];
    for (const config of configs) {
      if ((config.rules?.length ?? 0) > 0 || (config.triggers?.length ?? 0) > 0) {
        return yield* new SquireFixtureActionUnavailable({
          action: "loadSetup",
          phase: 8,
          detail: "fixture rules and triggers load with the dev fixture route",
        });
      }
    }
    if ((setup.rooms?.length ?? 0) > 0) {
      return yield* new SquireFixtureActionUnavailable({
        action: "loadSetup",
        phase: 9,
        detail: "fixture rooms arrive with messaging",
      });
    }

    const threadModel = yield* scriptedModel;
    const squireInstance = options.providerInstanceId ?? threadModel.instanceId;

    // Projects: the threads', then every container's, in fixture order.
    const names: Array<string> = [];
    const addName = (name: string) => {
      if (!names.includes(name)) names.push(name);
    };
    for (const thread of setup.threads ?? []) addName(thread.project);
    for (const config of configs) {
      for (const container of config.scope ?? []) {
        if (container.kind === "project") addName(container.name);
        if (container.kind === "staveSpace" || container.kind === "staveSaga") {
          container.covers.forEach(addName);
        }
      }
    }
    const projectIds = new Map<string, ProjectId>();
    for (const name of names) projectIds.set(name, yield* ensureProject(name));
    for (const thread of setup.threads ?? []) {
      yield* ensureThread(thread, projectIds.get(thread.project)!, threadModel);
    }
    if (Option.isSome(fixtureStave)) {
      const memberships = new Map<ProjectId, { spaceId: string | null; sagaId: string | null }>();
      for (const config of configs) {
        for (const container of config.scope ?? []) {
          if (container.kind !== "staveSpace" && container.kind !== "staveSaga") continue;
          yield* fixtureStave.value.setName(syntheticStaveId(container), container.name);
          for (const name of container.covers) {
            const projectId = projectIds.get(name)!;
            const current = memberships.get(projectId) ?? { spaceId: null, sagaId: null };
            memberships.set(
              projectId,
              container.kind === "staveSaga"
                ? { ...current, sagaId: syntheticStaveId(container) }
                : { ...current, spaceId: syntheticStaveId(container) },
            );
          }
        }
      }
      for (const [projectId, membership] of memberships) {
        yield* fixtureStave.value.set(projectId, membership);
      }
    }
    const homeProjectId =
      names.length > 0 ? projectIds.get(names[0]!)! : yield* ensureProject(FIXTURE_HOME_PROJECT);

    const squires: Record<string, SquireId> = {};
    let main: SquireId;
    if (setup.role === "lead") {
      main = yield* ensureLead(squireInstance);
      const plan = planSquire({
        declared: input,
        config: setup,
        brief: setup.squire?.brief ?? "",
        overrides,
        briefPath: "squire.brief",
        owned: true,
      });
      yield* writeConfig(main, {
        ...plan,
        ...(setup.sweep === undefined ? {} : { sweep: setup.sweep }),
        lead: true,
      });
      squires[setup.squire?.name ?? "Lead"] = main;
    } else {
      const identity = setup.squire!;
      const found = yield* upsertSquire({
        name: identity.name,
        homeProjectId,
        instanceId: squireInstance,
      });
      main = found.id;
      const plan = planSquire({
        declared: input,
        config: setup,
        brief: identity.brief,
        overrides,
        briefPath: "squire.brief",
        owned: found.owned,
      });
      yield* writeConfig(main, {
        ...plan,
        ...(plan.writesGrants
          ? { grants: yield* grantsOf(setup.scope ?? [], setup.exclusions ?? [], projectIds) }
          : {}),
        lead: false,
      });
      squires[identity.name] = main;
    }
    for (const [index, extra] of (setup.squires ?? []).entries()) {
      const found = yield* upsertSquire({
        name: extra.name,
        homeProjectId,
        instanceId: squireInstance,
      });
      const prefix = `squires.${index}.`;
      const plan = planSquire({
        declared: input.squires?.[index] ?? {},
        config: extra,
        brief: extra.brief,
        overrides: Object.fromEntries(
          Object.entries(overrides).flatMap(([path, value]) =>
            path.startsWith(prefix) ? [[path.slice(prefix.length), value]] : [],
          ),
        ),
        briefPath: "brief",
        owned: found.owned,
      });
      yield* writeConfig(found.id, {
        ...plan,
        ...(plan.writesGrants
          ? { grants: yield* grantsOf(extra.scope ?? [], extra.exclusions ?? [], projectIds) }
          : {}),
        lead: false,
      });
      squires[extra.name] = found.id;
    }
    if (options.fake !== undefined) yield* setFake(main, options.fake);
    yield* Ref.set(mainSquire, Option.some(main));
    const row = yield* repository.getSquire(main);
    return {
      squireId: main,
      homeThreadId: Option.isSome(row) ? row.value.home_thread_id : null,
      squires,
      projects: Object.fromEntries(projectIds),
    } satisfies SquireFixtureLoaded;
  }, asFixtureError("loadSetup"));

  // ── Matching orchestration state ──

  const fixtureMessageId = (threadId: ThreadId, turnId: string, generation = 0) =>
    MessageId.make(
      `message:fixture:${threadId}:${turnId}${generation === 0 ? "" : `:g${generation}`}`,
    );

  /** The newest run a fixture turn id made, with its generation. */
  const latestOfTurn = (threadId: ThreadId, turnId: string) =>
    projections.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.map(({ runs }) => {
        const base = fixtureMessageId(threadId, turnId);
        let latest: { readonly generation: number; readonly run: OrchestrationV2Run } | undefined;
        for (const run of runs) {
          const id = run.userMessageId;
          const generation =
            id === base ? 0 : id?.startsWith(`${base}:g`) ? Number(id.slice(base.length + 2)) : -1;
          if (!Number.isInteger(generation) || generation < 0) continue;
          if (latest === undefined || generation > latest.generation) latest = { generation, run };
        }
        return latest;
      }),
    );

  const runOfTurn = (threadId: ThreadId, turnId: string, generation: number) =>
    projections
      .getThreadRecords(threadId, ["runs"])
      .pipe(
        Effect.map(({ runs }) =>
          Option.fromUndefinedOr(
            runs.find(
              (run) => run.userMessageId === fixtureMessageId(threadId, turnId, generation),
            ),
          ),
        ),
      );

  const pendingRequestItems = (threadId: ThreadId, run: OrchestrationV2Run) =>
    projections
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemRunId: run.id,
        turnItemTypes: ["user_input_request"],
        turnItemStatuses: ["pending", "running", "waiting"],
      })
      .pipe(Effect.map(({ turnItems }) => turnItems));

  /**
   * One scripted turn per fixture turn id; a repeat finds the run the first
   * one made. A run that can no longer stand for the turn (a reset cancelled
   * its request) gets a next generation, so a fixture re-runs on a reset home
   * with its own ids.
   */
  const startTurn = Effect.fn("SquireDevFixtures.startTurn")(function* <E, R>(
    threadId: ThreadId,
    turnId: string,
    prompt: string,
    script: ScriptedScript,
    reusable: (run: OrchestrationV2Run) => Effect.Effect<boolean, E, R>,
  ) {
    const latest = yield* latestOfTurn(threadId, turnId);
    if (latest !== undefined && (yield* reusable(latest.run))) return latest.generation;
    const generation = latest === undefined ? 0 : latest.generation + 1;
    const suffix = generation === 0 ? "" : `:g${generation}`;
    yield* requireFixtureThread(threadId);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`fixture:turn:${threadId}:${turnId}${suffix}`),
      threadId,
      messageId: fixtureMessageId(threadId, turnId, generation),
      text: `${prompt}\n\`\`\`scripted\n${encodeScript(script)}\n\`\`\``,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "system",
      creationSource: "server",
    });
    return generation;
  });

  /**
   * Resolves once the turn's run is over, its checkpoint included: `waiting`
   * is a finished turn whose capture has not committed, which the effect
   * daemon may hold while `drainWorker` finds nothing to run. The next
   * scripted turn starts only after this one is fully done.
   */
  // The turn's closing reply is what a card's Why quotes, so it reads like the agent's own
  // wrap-up from the scenario's summary rather than a placeholder.
  const turnReply = (summary: {
    readonly completed: ReadonlyArray<string>;
    readonly goal: string;
  }) => {
    const done = summary.completed.join(" ").trim();
    if (done !== "") return /[.!?]$/.test(done) ? done : `${done}.`;
    const goal = summary.goal.trim();
    return goal === "" ? "Done for now." : `Working on: ${goal}.`;
  };

  // The user's side of the turn, which a summary may quote, so it reads as the ask.
  const turnPrompt = (summary: { readonly goal: string }) => {
    const goal = summary.goal.trim();
    return goal === "" ? "Keep going." : /[.!?]$/.test(goal) ? goal : `${goal}.`;
  };

  const completedTurn = Effect.fn("SquireDevFixtures.completedTurn")(function* (
    threadId: ThreadId,
    turnId: string,
    prompt: string,
    assistantText: string,
  ) {
    const generation = yield* startTurn(threadId, turnId, prompt, [{ assistantText }], () =>
      Effect.succeed(true),
    );
    const run = yield* awaitThread(
      threadId,
      Effect.gen(function* () {
        const run = yield* runOfTurn(threadId, turnId, generation);
        if (Option.isNone(run) || isSettledRun(run.value)) return run;
        if ((yield* pendingRequestItems(threadId, run.value)).length > 0) {
          return yield* fail(`turn ${turnId} still waits on a request; answer it first`);
        }
        return Option.none();
      }),
    );
    return run.id;
  });

  /** The waiting event's question is raised for real by a scripted `askUser` run. */
  const waitingTurn = Effect.fn("SquireDevFixtures.waitingTurn")(function* (
    threadId: ThreadId,
    event: Extract<ThreadEvent, { type: "waiting-on-user" }>,
  ) {
    const pending = event.evidence?.pendingRequest;
    const question = pending?.question ?? event.summary.pendingQuestion;
    if (!question) return yield* fail("a waiting-on-user event needs a pending question");
    const turnId = event.summary.turnId;
    const generation = yield* startTurn(
      threadId,
      turnId,
      turnPrompt(event.summary),
      [
        {
          askUser: {
            question,
            ...(pending === undefined
              ? {}
              : { options: pending.options.map((option) => option.label) }),
          },
        },
        { assistantText: turnReply(event.summary) },
      ],
      // A duplicate inject reuses the turn while its question still waits.
      (run) =>
        isSettledRun(run)
          ? Effect.succeed(false)
          : Effect.gen(function* () {
              const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
                turnItemRunId: run.id,
                turnItemTypes: ["user_input_request"],
              });
              return (
                turnItems.length === 0 || (yield* pendingRequestItems(threadId, run)).length > 0
              );
            }),
    );
    return yield* awaitThread(
      threadId,
      Effect.gen(function* () {
        const run = yield* runOfTurn(threadId, turnId, generation);
        if (Option.isNone(run)) return Option.none();
        const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
          turnItemRunId: run.value.id,
          turnItemTypes: ["user_input_request"],
        });
        const item = turnItems.find((candidate) => candidate.type === "user_input_request");
        return item?.type === "user_input_request"
          ? Option.some({ runId: run.value.id, requestId: item.requestId, question })
          : Option.none();
      }),
    );
  });

  /** Links the PR on host `fixture.invalid` and commits the snapshot the event claims. */
  const commitPullRequest = Effect.fn("SquireDevFixtures.commitPullRequest")(function* (
    threadId: ThreadId,
    event: ThreadEvent,
  ) {
    const pr = event.summary.pullRequest ?? event.evidence?.pullRequest;
    if (!pr) return yield* fail("a pull-request-changed event needs summary.pullRequest");
    const key = {
      host: FIXTURE_PULL_REQUEST_HOST,
      repository: pr.repository,
      number: pr.number,
    };
    const url = `https://${FIXTURE_PULL_REQUEST_HOST}/${pr.repository}/pull/${pr.number}`;
    const prKey = threadPullRequestKeyOf({ ...key, url });
    const linked = (yield* projections.getThreadsWithPullRequests(threadId))
      .flatMap((thread) => thread.pullRequests ?? [])
      .some((link) => threadPullRequestKeyOf(link) === prKey);
    if (!linked) {
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`fixture:pr-link:${threadId}:${prKey}`),
        threadId,
        ...key,
        url,
        source: "manual",
      });
    }
    const snapshot = fixturePullRequestSnapshot(pr, {
      title: event.summary.threadTitle || `PR #${pr.number}`,
      ...(event.evidence?.headBranch === undefined
        ? {}
        : { headBranch: event.evidence.headBranch }),
      at: yield* nowIso,
    });
    yield* orchestrator.dispatch({
      type: "thread.pull-request-link.sync",
      commandId: CommandId.make(
        `fixture:pr-sync:${threadId}:${prKey}:${pr.headSha}:${pr.transition}`,
      ),
      threadId,
      ...key,
      snapshot,
      stack: null,
    });
    return {
      stateKey: `${prKey}:${pr.headSha}:${pr.transition}`,
      pullRequest: {
        ...key,
        url,
        headSha: pr.headSha,
        transition: pr.transition,
        state: snapshot.state,
        title: snapshot.title,
        headBranch: snapshot.headBranch,
        baseBranch: snapshot.baseBranch,
        checksState: snapshot.checksState ?? null,
        reviewDecision: snapshot.reviewDecision ?? null,
        mergeability: snapshot.mergeability ?? null,
        threadSelfWatching: false,
      } satisfies NonNullable<SquireEventPayload["pullRequest"]>,
    };
  });

  /** Stored `complete`, no payer, immutable once there. */
  const storeSummary = Effect.fn("SquireDevFixtures.storeSummary")(function* (
    stored: SquireInjectedSummary,
  ) {
    const now = yield* nowIso;
    const inserted = yield* repository.insertSummary({
      thread_id: stored.threadId,
      run_id: stored.runId,
      stage: stored.stage,
      status: "complete",
      summary_json: encodeSummary(stored.summary),
      payer_squire_id: null,
      created_at: now,
      updated_at: now,
    });
    if (inserted && Option.isSome(postStore)) yield* postStore.value.summaryStored(stored);
  });

  /** Inserts the row for each Squire, or finds the row its dedupe key already holds. */
  const writeRows = Effect.fn("SquireDevFixtures.writeRows")(function* (
    targets: ReadonlyArray<SquireRepository.SquireRow>,
    row: (squire: SquireRepository.SquireRow) => Omit<SquireRepository.SquireEventRow, "id">,
  ) {
    const ids: Array<number> = [];
    const fresh: Array<SquireRepository.SquireEventRow> = [];
    for (const squire of targets) {
      const candidate = row(squire);
      const id = yield* repository.insertTriggerEvent(candidate);
      if (Option.isSome(id)) {
        ids.push(id.value);
        fresh.push({ ...candidate, id: id.value });
        continue;
      }
      const original = yield* repository.getEventByKey({
        squireId: candidate.squire_id,
        kind: candidate.kind,
        threadId: candidate.thread_id,
        stateKey: candidate.state_key,
      });
      if (Option.isSome(original)) ids.push(original.value.id);
    }
    return { ids, fresh };
  });

  const togglesOf = (row: SquireRepository.SquireRow) =>
    Option.getOrElse(decodeToggles(row.events_json), () => DEFAULT_TOGGLES);

  const toggleOf = (kind: ThreadEvent["type"]) =>
    kind === "turn-finished"
      ? "turnFinished"
      : kind === "thread-stopped"
        ? "threadStopped"
        : kind === "waiting-on-user"
          ? "waitingOnUser"
          : "pullRequestChanged";

  const injectThreadEvent = Effect.fn("SquireDevFixtures.injectThreadEvent")(function* (
    event: ThreadEvent,
  ) {
    const threadId = event.summary.threadId;
    yield* requireFixtureThread(threadId);

    let runId: RunId;
    let stateKey: string;
    let payload: SquireEventPayload;
    let stage: SquireSummaryStage = "terminal";
    let waitingSince: DateTime.Utc | null = null;
    if (event.type === "waiting-on-user") {
      const raised = yield* waitingTurn(threadId, event);
      runId = raised.runId;
      stateKey = raised.requestId;
      stage = `request:${raised.requestId}`;
      waitingSince = DateTime.subtract(yield* DateTime.now, { minutes: event.waitingMinutes });
      payload = {
        outcome: "waiting-on-input",
        runId,
        pendingRequest: {
          kind: "user_input",
          requestId: raised.requestId,
          createdAt: DateTime.formatIso(waitingSince),
          question: raised.question,
        },
        pullRequest: null,
      };
    } else {
      runId = yield* completedTurn(
        threadId,
        event.summary.turnId,
        turnPrompt(event.summary),
        turnReply(event.summary),
      );
      if (event.type === "pull-request-changed") {
        const committed = yield* commitPullRequest(threadId, event);
        stateKey = committed.stateKey;
        payload = {
          outcome: null,
          runId,
          pendingRequest: null,
          pullRequest: committed.pullRequest,
        };
      } else {
        stateKey = runId;
        payload = {
          outcome: event.summary.outcome,
          runId,
          pendingRequest: null,
          pullRequest: null,
        };
      }
    }
    const quoted = quotedEvidence(event.evidence);
    if (quoted !== undefined) payload = { ...payload, evidence: quoted };
    yield* storeSummary({
      threadId,
      runId,
      stage,
      summary: { ...event.summary, turnId: runId },
    });

    const trackerIds = yield* scope.trackersOf(threadId);
    const targets = (yield* repository.listSquires).filter(
      (row) =>
        trackerIds.includes(row.id) &&
        row.status === "active" &&
        row.lifecycle !== "deleting" &&
        togglesOf(row)[toggleOf(event.type)],
    );
    if (targets.length === 0) return yield* fail(`no active Squire tracks ${threadId}`);
    const now = yield* DateTime.now;
    const createdAt = DateTime.formatIso(now);
    const { ids, fresh } = yield* writeRows(targets, (squire) => {
      const notBefore =
        waitingSince === null
          ? createdAt
          : DateTime.formatIso(
              DateTime.add(waitingSince, { minutes: togglesOf(squire).waitingThresholdMinutes }),
            );
      return {
        squire_id: squire.id,
        thread_id: threadId,
        kind: event.type,
        state_key: stateKey,
        payload_json: encodePayload(payload),
        status: waitingSince === null ? "pending" : "deferred",
        defer_reason: waitingSince === null ? null : "threshold",
        not_before: notBefore,
        batch_id: null,
        created_at: createdAt,
      };
    });
    yield* noteInjected(ids, event);
    // A due waiting row raises its question card on promotion, as the clock would.
    if (fresh.some((row) => row.status === "deferred" && row.not_before <= createdAt)) {
      yield* reactor.promoteDue(now);
    }
    for (const row of fresh) if (row.status === "pending") yield* delivery.wake(row.squire_id);
    return ids;
  });

  const targetSquire = Effect.fn("SquireDevFixtures.targetSquire")(function* (
    name: string | undefined,
  ) {
    if (name === undefined) {
      const main = yield* Ref.get(mainSquire);
      if (Option.isNone(main)) return yield* fail("inject before loadSetup names no Squire");
      return main.value;
    }
    const row = yield* squireNamed(name);
    if (Option.isSome(row)) return row.value.id;
    const lead = yield* repository.getLead;
    if (Option.isSome(lead) && (name === "lead" || lead.value.name === name)) {
      return lead.value.id;
    }
    return yield* fail(`no fixture Squire named ${name}`);
  });

  const injectOtherEvent = Effect.fn("SquireDevFixtures.injectOtherEvent")(function* (
    event: OtherEvent,
    options: SquireFixtureInjectOptions,
  ) {
    const squireId = yield* targetSquire(options.squire);
    const row = yield* repository.getSquire(squireId);
    if (Option.isNone(row)) return yield* fail(`Squire ${squireId} vanished`);
    const createdAt = yield* nowIso;
    const { ids, fresh } = yield* writeRows([row.value], (squire) => ({
      squire_id: squire.id,
      thread_id: null,
      kind: event.type,
      state_key: otherStateKey(event),
      payload_json: encodeEventJson(event),
      status: "pending",
      defer_reason: null,
      not_before: createdAt,
      batch_id: null,
      created_at: createdAt,
    }));
    yield* noteInjected(ids, event);
    if (fresh.length > 0) yield* delivery.wake(squireId);
    return ids;
  });

  const inject: SquireDevFixtures["Service"]["inject"] = Effect.fn("SquireDevFixtures.inject")(
    function* (input, options = {}) {
      const event = yield* decodeEvent(input);
      if (isUnknownUnionMember(event)) return yield* fail("unknown event type");
      const ids = isThreadEvent(event)
        ? yield* injectThreadEvent(event)
        : yield* injectOtherEvent(event, options);
      const sequence = ids[0];
      if (sequence === undefined) return yield* fail("the event wrote no row");
      yield* Ref.update(injected, (current) => {
        const known = current.get(sequence) ?? [];
        return new Map(current).set(sequence, [...new Set([...known, ...ids])]);
      });
      return sequence;
    },
    asFixtureError("inject"),
  );

  // ── drainThrough ──

  const settleAll = Effect.fn("SquireDevFixtures.settleAll")(function* (head: number) {
    yield* drainWorker;
    yield* reactor.drainThrough(head);
    yield* delivery.drain;
  });

  const drainThrough: SquireDevFixtures["Service"]["drainThrough"] = (sequence) =>
    Effect.scoped(
      Effect.gen(function* () {
        const ids = (yield* Ref.get(injected)).get(sequence) ?? [sequence];
        // Subscribed before the first check, so no change between check and wait is lost.
        const changes = yield* repository.subscribeChanges;
        for (;;) {
          const head = yield* events.latestApplicationSequence;
          yield* settleAll(head);
          const rows = yield* repository.listEvents({
            ids,
            statuses: ["deferred", "pending", "batched", "delivered", "dropped"],
          });
          if (rows.length === 0) return yield* fail(`no Squire event row ${sequence}`);
          if (rows.every((row) => SETTLED_ROW_STATUSES.has(row.status))) {
            yield* settleAll(yield* events.latestApplicationSequence);
            return;
          }
          yield* Stream.merge(
            changes,
            events.streamApplicationEvents({ afterSequence: head }).pipe(Stream.as(undefined)),
          ).pipe(Stream.runHead);
        }
      }),
    ).pipe(asFixtureError("drainThrough"));

  // ── Timeline ──

  /** Only a test clock can be moved; the dev route has none. */
  const advance = (seconds: number) =>
    Effect.withFiber((fiber) => {
      const clock = fiber.getRef(Clock.Clock) as Partial<TestClock.TestClock>;
      return typeof clock.adjust === "function"
        ? clock.adjust(Duration.seconds(seconds))
        : Effect.fail(
            new SquireFixtureActionUnavailable({
              action: "advance",
              phase: 8,
              detail: "the server's clock is real; only the B2 harness can advance time",
            }),
          );
    });

  const moveHead = Effect.fn("SquireDevFixtures.moveHead")(function* (
    threadId: ThreadId,
    headSha: string,
  ) {
    yield* requireFixtureThread(threadId);
    const links = (yield* projections.getThreadsWithPullRequests(threadId))
      .flatMap((thread) => thread.pullRequests ?? [])
      .filter((link) => link.host === FIXTURE_PULL_REQUEST_HOST && link.snapshot !== null);
    if (links.length === 0) return yield* fail(`thread ${threadId} has no fixture PR link`);
    const syncedAt = yield* nowIso;
    for (const link of links) {
      const prKey = threadPullRequestKeyOf(link);
      yield* orchestrator.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: CommandId.make(`fixture:pr-head:${threadId}:${prKey}:${headSha}`),
        threadId,
        host: link.host,
        repository: link.repository,
        number: link.number,
        snapshot: { ...link.snapshot!, headSha, syncedAt, updatedAt: syncedAt },
        stack: link.stack,
      } satisfies OrchestrationV2ServerCommand);
    }
  });

  const seedUsage = Effect.fn("SquireDevFixtures.seedUsage")(function* (
    action: Extract<SquireFixtureTimelineAction, { action: "seedUsage" }>,
  ) {
    const squireId = yield* targetSquire(undefined);
    const executedAt = yield* nowIso;
    yield* repository.transaction(
      Effect.forEach(
        Array.from({ length: action.count }),
        () =>
          repository.insertBudgetUsage({
            squire_id: squireId,
            thread_id: action.threadId ?? null,
            kind: action.kind,
            room_id: null,
            executed_at: executedAt,
            execution_key: null,
          }),
        { discard: true },
      ),
    );
  });

  const timeline: SquireDevFixtures["Service"]["timeline"] = Effect.fn(
    "SquireDevFixtures.timeline",
  )(function* (action) {
    switch (action.action) {
      case "advance":
        return yield* advance(action.seconds);
      case "seedUsage":
        return yield* seedUsage(action);
      case "moveHead":
        return yield* moveHead(action.threadId, action.headSha);
      case "undo":
        return yield* new SquireFixtureActionUnavailable({
          action: "undo",
          phase: 5,
          detail: "Auto holds and Undo arrive with the Squire tools",
        });
      case "restart":
        return yield* new SquireFixtureActionUnavailable({
          action: "restart",
          phase: 5,
          detail: "the B2 harness restarts the server layer around held actions",
        });
    }
  }, asFixtureError("timeline"));

  const reset: SquireDevFixtures["Service"]["reset"] = Effect.fn("SquireDevFixtures.reset")(
    function* (name) {
      const row = yield* repository.getSquireByCreateRequestId(fixtureRequestId(name));
      if (Option.isNone(row)) return;
      const squireId = row.value.id;
      const entry = (yield* Ref.get(fakeBySquire)).get(squireId);
      if (entry !== undefined && Option.isSome(fakes)) yield* fakes.value.clear(entry.homeThreadId);
      yield* Ref.update(fakeBySquire, (current) => {
        const next = new Map(current);
        next.delete(squireId);
        return next;
      });
      yield* Ref.update(
        mainSquire,
        Option.filter((id) => id !== squireId),
      );
      yield* service.delete({ requestId: `fixture:reset:${squireId}`, squireId });
    },
    asFixtureError("reset"),
  );

  const pauseLeadForHarness: SquireDevFixtures["Service"]["pauseLeadForHarness"] = Effect.gen(
    function* () {
      const lead = yield* repository.getLead;
      if (Option.isNone(lead) || lead.value.status === "paused") return;
      yield* service.setStatus({
        requestId: `fixture:pause-lead:${lead.value.id}`,
        squireId: lead.value.id,
        status: "paused",
      });
    },
  ).pipe(asFixtureError("pauseLeadForHarness"));

  return SquireDevFixtures.of({
    loadSetup,
    inject,
    drainThrough,
    timeline,
    reset,
    pauseLeadForHarness,
  });
});

export const layer = Layer.effect(SquireDevFixtures, make);
