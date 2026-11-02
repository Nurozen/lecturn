// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Run files go to the repo-root artifacts folder; action-log data is stored JSON.
/**
 * The gold-scenario bar harness: the Squire stack as the server builds
 * it (`phase4Layer`: real orchestrator, switch-on `layerSquire`, the fixture
 * seam) plus the production `/mcp` route on a test HTTP port, with the real
 * `McpSessionRegistry` the provider session manager issues home-thread
 * credentials from. A Squire turn's tool calls therefore go provider ->
 * HTTP -> gate -> `SquireToolInterceptor` -> `SquireTools`, as a real
 * provider's do. Each run gets a fresh layer in a fresh temp Lecturn home.
 *
 * The Squire's provider is an option: `scripted` (`squireFake`) or, for
 * live runs, a real `claudeAgent` or `codex` adapter launched from a temp
 * provider home (`barProviders.ts`). Only the Squire's home thread runs the
 * live provider; fixture worker threads stay scripted.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type ProjectId,
  type SquireFakeScript,
  type SquireFixtureEffect,
  type SquireFixtureExpected,
  type SquireFixtureScenario,
  type SquireFixtureTimelineAction,
  type OrchestrationV2ConversationMessage,
  SquireCardId,
  type SquireId,
  type ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter } from "effect/http";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as DeviceService from "../../device/DeviceService.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import * as AppToolInterceptor from "../../mcp/toolkits/app/AppToolInterceptor.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as PullRequestReviewGuideService from "../../pullRequest/PullRequestReviewGuideService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as SourceControlRepositoryService from "../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as SquireActions from "../SquireActions.ts";
import * as SquireClock from "../SquireClock.ts";
import * as SquireDelivery from "../SquireDelivery.ts";
import * as SquireDevFixtures from "../SquireDevFixtures.ts";
import * as SquireReactor from "../SquireReactor.ts";
import * as SquireRepository from "../SquireRepository.ts";
import {
  type BarLiveProvider,
  type BarProviderHome,
  type BarProviderRecorder,
  barInstanceId,
  barModel,
  liveBarAdapters,
  makeBarProviderRecorder,
} from "./barProviders.ts";
import { tempRoot } from "./lifecycleHarness.ts";
import { type Phase4Options, type Phase4Services, phase4Layer } from "./phase4Harness.ts";

// ── Layer ──

/** The Squire's provider under test. */
export type BarProvider = "scripted" | BarLiveProvider;

export interface BarHarnessOptions {
  /** Defaults to `scripted`, which runs the scenario's `fake/<id>.json`. */
  readonly provider?: BarProvider;
  /** A live provider's temp home; required unless `provider` is `scripted`. */
  readonly providerHome?: BarProviderHome;
  /** A live provider's model; the product default when absent. */
  readonly model?: string;
  /** Collects what a live provider was started with and listed. */
  readonly recorder?: BarProviderRecorder;
  /** Wraps the real thread service, so a control can land a change inside a held dispatch. */
  readonly wrapThreadManagement?: Phase4Options["wrapThreadManagement"];
}

const liveOptions = (options: BarHarnessOptions) => {
  const provider = options.provider ?? "scripted";
  if (provider === "scripted") return {};
  const home = options.providerHome;
  if (home === undefined || home.provider !== provider) {
    throw new Error(`The ${provider} bar harness needs a ${provider} provider home.`);
  }
  return {
    extraAdapters: liveBarAdapters(home, options.recorder ?? makeBarProviderRecorder()),
    instanceModels: { [barInstanceId(provider)]: barModel(provider, options.model) },
  };
};

const layerEnvironment = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-squire-bar")),
    getDescriptor: Effect.die("unused"),
  }),
);

// Services the `/mcp` route's other toolkits need and the Squire stack does
// not build. A Squire credential's gate refuses them before dispatch.
const layerRouteStubs = Layer.mergeAll(
  Layer.mock(DeviceService.DeviceService)({}),
  McpToolAccessTestkit.liveThreadsLayer,
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(PreviewBrowser.PreviewBrowser)({ installed: Effect.succeed(Option.none()) }),
);

/**
 * The Squire stack over a Lecturn home at `baseDir`, with the gated `/mcp`
 * route served on a test port and one session registry shared by the route
 * and the provider session manager.
 */
export const barLayer = (baseDir: string, options: BarHarnessOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.__testing
        .make()
        .pipe(Effect.provide(Layer.merge(layerEnvironment, NodeServices.layer)));
      const registryLayer = Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry);
      const squire = phase4Layer(baseDir, {
        mcpSessionRegistry: registryLayer,
        ...liveOptions(options),
        ...(options.wrapThreadManagement === undefined
          ? {}
          : { wrapThreadManagement: options.wrapThreadManagement }),
      });
      const routes = McpHttpServer.layer.pipe(
        Layer.provide(registryLayer),
        Layer.provide(AppToolInterceptor.layerNoAppTools),
      );
      const served = HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provide(PreviewAutomationBroker.layer),
        Layer.provide(layerRouteStubs),
        Layer.provide(layerEnvironment),
      );
      // The registry is exposed too, so a test can issue or resolve credentials.
      return Layer.merge(served.pipe(Layer.provideMerge(squire)), registryLayer);
    }),
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

export type BarServices = Phase4Services;

/**
 * `BarServices` plus the switch-on Squire services `layerSquire` builds at
 * runtime but cannot name in its type (the switch decides).
 */
export type BarSquireServices =
  | BarServices
  | SquireActions.SquireActions
  | SquireClock.SquireClock
  | SquireDelivery.SquireDelivery
  | SquireReactor.SquireReactor;

const required = <I, S>(tag: Context.Key<I, S>) =>
  Effect.flatMap(Effect.serviceOption(tag), (found) =>
    Option.isSome(found)
      ? Effect.succeed(found.value)
      : Effect.die(new Error(`the bar harness needs ${tag.key}; is the Squire switch on?`)),
  );

/** Names the switch-on services for `body`, so its type can ask for them. */
const withSquireServices = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const actions = yield* required(SquireActions.SquireActions);
    const clock = yield* required(SquireClock.SquireClock);
    const delivery = yield* required(SquireDelivery.SquireDelivery);
    const reactor = yield* required(SquireReactor.SquireReactor);
    return yield* body.pipe(
      Effect.provideService(SquireActions.SquireActions, actions),
      Effect.provideService(SquireClock.SquireClock, clock),
      Effect.provideService(SquireDelivery.SquireDelivery, delivery),
      Effect.provideService(SquireReactor.SquireReactor, reactor),
    );
  });

/** Runs `body` against a fresh bar layer in a fresh temp Lecturn home. */
export const withBarHarness = <A, E>(
  body: Effect.Effect<A, E, BarSquireServices | Scope.Scope>,
  options: BarHarnessOptions = {},
) =>
  Effect.gen(function* () {
    const { baseDir } = yield* tempRoot;
    return yield* withSquireServices(body).pipe(
      Effect.scoped,
      Effect.provide(barLayer(baseDir, options)),
    );
  }).pipe(Effect.scoped, Effect.orDie);

// ── Running a scenario ──

export interface BarRunOptions {
  /** The main Squire's script; the scripted provider runs it. */
  readonly fake?: SquireFakeScript;
  /** Pauses the Lead after setup, so a decision card does not wake it. */
  readonly pauseLead?: boolean;
  /** The Squire's provider; `scripted` when absent. */
  readonly provider?: BarProvider;
}

export interface BarLoaded {
  readonly squireId: SquireId;
  readonly homeThreadId: ThreadId;
  readonly projects: Readonly<Record<string, ProjectId>>;
}

const fixturesService = Effect.map(
  Effect.serviceOption(SquireDevFixtures.SquireDevFixtures),
  Option.getOrThrow,
);

/** One gold scenario: start the server's reactors, `loadSetup`, `inject` each event, then `drainThrough` each. */
export const runBarScenario = (scenario: SquireFixtureScenario, options: BarRunOptions = {}) =>
  Effect.gen(function* () {
    yield* ServerRuntimeStartup.startLecturnReactors;
    const fixtures = yield* fixturesService;
    const loaded = yield* fixtures.loadSetup(scenario.setup, {
      ...(options.fake === undefined ? {} : { fake: options.fake }),
      ...(options.provider === undefined || options.provider === "scripted"
        ? {}
        : { providerInstanceId: barInstanceId(options.provider) }),
    });
    if (options.pauseLead === true) yield* fixtures.pauseLeadForHarness;
    const sequences: Array<number> = [];
    for (const event of scenario.events) sequences.push(yield* fixtures.inject(event));
    for (const sequence of sequences) yield* fixtures.drainThrough(sequence);
    return {
      squireId: loaded.squireId,
      homeThreadId: loaded.homeThreadId!,
      projects: loaded.projects,
    } satisfies BarLoaded;
  });

// ── Timeline ──

/** A hold as it stood at a mark; `executes_at` is cleared once it runs. */
export interface BarHeld {
  readonly cardId: string;
  readonly executesAt: string;
}

export interface BarTimelineMark {
  /** The step's index in the timeline; -1 for the drained events before it. */
  readonly index: number;
  readonly action: SquireFixtureTimelineAction["action"] | "events";
  /** The test clock once the step settled. */
  readonly at: string;
  /** Messages Squire actions sent into the threads this Squire's cards target. */
  readonly actionMessages: number;
  readonly held: ReadonlyArray<BarHeld>;
}

export interface BarTimelineRun {
  readonly loaded: BarLoaded;
  readonly marks: ReadonlyArray<BarTimelineMark>;
}

export interface BarTimelineOptions extends BarRunOptions {
  /** Replaces the scenario's timeline, as a negative control does. */
  readonly timeline?: ReadonlyArray<SquireFixtureTimelineAction>;
}

/** `squireActionMessageId`'s prefix: every message a held action or accept sends. */
const ACTION_MESSAGE_PREFIX = "message:squire-action:";

const actionMessagesIn = (threadIds: Iterable<ThreadId>) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sent: Array<OrchestrationV2ConversationMessage> = [];
    for (const threadId of threadIds) {
      const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["user"],
      });
      sent.push(...messages.filter((message) => message.id.startsWith(ACTION_MESSAGE_PREFIX)));
    }
    return sent;
  });

const cardTargets = (cards: ReadonlyArray<SquireRepository.SquireCardRow>) =>
  new Set(cards.flatMap((card) => (card.target_thread_id === null ? [] : [card.target_thread_id])));

/** A mark at the current test or live clock: sends so far and pending holds. */
export const barMark = (loaded: BarLoaded, index: number, action: BarTimelineMark["action"]) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const cards = yield* repository.listCards({ squireId: loaded.squireId });
    return {
      index,
      action,
      at: DateTime.formatIso(yield* DateTime.now),
      actionMessages: (yield* actionMessagesIn(cardTargets(cards))).length,
      held: cards.flatMap((card) =>
        card.status === "held" && card.executes_at !== null
          ? [{ cardId: card.id, executesAt: card.executes_at }]
          : [],
      ),
    } satisfies BarTimelineMark;
  });

/**
 * Lets everything the clock and the last step started finish, without
 * sleeping: the clock's `runDue` (due holds through `executeDue`, due rows,
 * slots), then the effect worker, the reactor, delivery, and every in-flight
 * row of the Squire under test, until no new application event appears.
 * The server's own clock fiber may run the same hold concurrently; the
 * action locks and status compare-and-set make that one execution.
 */
export const barSettle = (squireId: SquireId) =>
  Effect.gen(function* () {
    const clock = yield* SquireClock.SquireClock;
    const reactor = yield* SquireReactor.SquireReactor;
    const delivery = yield* SquireDelivery.SquireDelivery;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const worker = yield* Effect.serviceOption(EffectWorker.OrchestrationEffectWorkerV2);
    const repository = yield* SquireRepository.SquireRepository;
    const fixtures = yield* fixturesService;
    const drainWorker = Option.isSome(worker) ? Effect.asVoid(worker.value.drain()) : Effect.void;
    yield* clock.runDue;
    for (;;) {
      const head = yield* events.latestApplicationSequence;
      yield* drainWorker;
      yield* reactor.drainThrough(head);
      yield* delivery.drain;
      // Deferred rows wait for the clock; only rows already on their way are awaited.
      const inFlight = yield* repository.listEventsByStatus({
        squireId,
        statuses: ["pending", "batched"],
      });
      for (const row of inFlight) yield* fixtures.drainThrough(row.id);
      if (inFlight.length === 0 && (yield* events.latestApplicationSequence) === head) return;
    }
  });

/**
 * One timeline step in the current server lifetime, then `barSettle`.
 * `advance` moves the test clock (a live clock refuses it); `undo` presses
 * Undo on every pending hold as the user would (`squire.items.act`, a
 * request id derived from the step); `seedUsage` and `moveHead` are the
 * fixture's own. `restart` needs the lifetime boundary `withBarTimeline` owns.
 */
export const applyBarTimelineStep = (
  loaded: BarLoaded,
  step: SquireFixtureTimelineAction,
  index: number,
) =>
  Effect.gen(function* () {
    const fixtures = yield* fixturesService;
    switch (step.action) {
      case "restart":
        return yield* Effect.die(new Error("restart is a lifetime boundary: use withBarTimeline"));
      case "undo": {
        const repository = yield* SquireRepository.SquireRepository;
        const actions = yield* SquireActions.SquireActions;
        const held = yield* repository.listCards({
          squireId: loaded.squireId,
          statuses: ["held"],
        });
        if (held.length === 0) return yield* Effect.die(new Error("undo: no pending hold"));
        const undone = yield* actions.act({
          requestId: `bar:undo:${index}`,
          cardIds: held.map((card) => card.id),
          action: "undo",
        });
        const refused = undone.results.filter((result) => result.error !== null);
        if (refused.length > 0) {
          return yield* Effect.die(new Error(`undo refused: ${JSON.stringify(refused)}`));
        }
        break;
      }
      default:
        yield* fixtures.timeline(step);
    }
    yield* barSettle(loaded.squireId);
  });

/** What the server does at startup for held actions: reconcile, then arm the clock. */
const barRestart = (loaded: BarLoaded) =>
  Effect.gen(function* () {
    // Forks reconcile-then-clock as the server does; the explicit calls make it deterministic.
    yield* ServerRuntimeStartup.startLecturnReactors;
    yield* (yield* SquireActions.SquireActions).reconcileStartup;
    yield* barSettle(loaded.squireId);
  });

/**
 * A gold scenario with a timeline: `runBarScenario`, then each timeline step on the
 * test clock, with a mark after the events and after every step. A
 * `restart` closes the server lifetime (every Squire fiber and the `/mcp`
 * route), moves the test clock by the downtime, and builds a fresh bar layer
 * over the same Lecturn home and database, which reconciles and re-arms as
 * the server does. `observe` runs in the last lifetime. Holds that come due
 * run through the server's clock, `executeDue`, the real thread services,
 * and the command hook.
 *
 * After a restart the in-memory fake script and the fixture's main-Squire
 * pointer are gone, so a step after a restart cannot deliver a scripted turn
 * or `seedUsage` (none of 08-11 does).
 */
export const withBarTimeline = <A, E>(
  scenario: SquireFixtureScenario,
  observe: (run: BarTimelineRun) => Effect.Effect<A, E, BarSquireServices | Scope.Scope>,
  options: BarTimelineOptions = {},
  harness: BarHarnessOptions = {},
) =>
  Effect.gen(function* () {
    const { baseDir } = yield* tempRoot;
    const timeline = options.timeline ?? scenario.timeline ?? [];
    const marks: Array<BarTimelineMark> = [];
    const state: { loaded: BarLoaded | undefined } = { loaded: undefined };
    let index = 0;
    for (;;) {
      const restart = timeline.findIndex((step, at) => at >= index && step.action === "restart");
      const end = restart === -1 ? timeline.length : restart;
      const from = index;
      const done = yield* withSquireServices(
        Effect.gen(function* () {
          let loaded = state.loaded;
          if (loaded === undefined) {
            loaded = yield* runBarScenario(scenario, options);
            state.loaded = loaded;
            marks.push(yield* barMark(loaded, -1, "events"));
          } else {
            yield* barRestart(loaded);
            marks.push(yield* barMark(loaded, from - 1, "restart"));
          }
          for (let at = from; at < end; at++) {
            const step = timeline[at]!;
            yield* applyBarTimelineStep(loaded, step, at);
            marks.push(yield* barMark(loaded, at, step.action));
          }
          return restart === -1 ? Option.some(yield* observe({ loaded, marks })) : Option.none<A>();
        }),
      ).pipe(Effect.scoped, Effect.provide(barLayer(baseDir, harness)));
      if (Option.isSome(done)) return done.value;
      const step = timeline[restart]!;
      if (step.action === "restart")
        yield* TestClock.adjust(Duration.seconds(step.downtimeSeconds));
      index = restart + 1;
    }
  }).pipe(Effect.scoped, Effect.orDie);

// ── Effects ──

const BAR_EFFECTS = [
  "card_created",
  "proposal_created",
  "action_held",
  "steer_sent",
  "thread_created",
  "notification_pushed",
  "quiet_recorded",
] as const satisfies ReadonlyArray<SquireFixtureEffect>;

export interface BarCard {
  readonly kind: "steer" | "proposal";
  /** A steer's thread title; a proposal's `{ newThread, project, provider }`. */
  readonly target:
    | string
    | { readonly newThread: true; readonly project: string; readonly provider: string };
  readonly caption: string | null;
  readonly text: string;
  readonly origin: string;
}

export type BarEffectCounts = Record<SquireFixtureEffect, number>;

export interface BarObserved {
  readonly effects: BarEffectCounts & { readonly cards: ReadonlyArray<BarCard> };
  readonly deliveredEvents: number;
  /** `decision.recorded` rows: the tool and the reason it recorded. */
  readonly decisions: ReadonlyArray<{ readonly tool: string; readonly reason: string | null }>;
  readonly logKinds: ReadonlyArray<string>;
  readonly homeThreadId: string | null;
  /** Titles of the threads held actions targeted; an Auto steer that runs leaves no card. */
  readonly heldTargets: ReadonlyArray<string>;
  /** `action.executed` rows: what ran, how it was dispatched, and its key. */
  readonly executions: ReadonlyArray<BarExecution>;
  /** Budget rows an execution wrote; seeded usage carries no execution key. */
  readonly executionBudgetRows: ReadonlyArray<{
    readonly kind: string;
    readonly threadId: string | null;
    readonly executionKey: string;
  }>;
  /** Messages Squire actions sent into the threads this Squire's cards target. */
  readonly actionMessages: ReadonlyArray<{
    readonly id: string;
    readonly threadId: string;
    readonly createdBy: string | undefined;
    readonly senderThreadId: string | undefined;
    readonly createdAt: string;
  }>;
  /** Per target thread: the steer mode its provider session allows, and its interrupted runs. */
  readonly targets: ReadonlyArray<{
    readonly threadId: string;
    readonly d12Mode: "auto" | "queue";
    readonly interruptedRuns: number;
  }>;
}

export interface BarExecution {
  readonly cardId: string | null;
  readonly action: string;
  readonly threadId: string | null;
  readonly dispatchMode: string | null;
  readonly attempt: number | null;
  readonly executionKey: string | null;
}

type LogData = Readonly<Record<string, unknown>>;

const dataOf = (row: SquireRepository.SquireActionLogRow): LogData => {
  const parsed: unknown = JSON.parse(row.data_json);
  return typeof parsed === "object" && parsed !== null ? (parsed as LogData) : {};
};

const stringOr = (value: unknown, fallback: string) =>
  typeof value === "string" ? value : fallback;

/**
 * Effect counts from the action log of the Squire under test only.
 * `card.created` counts toward `card_created` or `proposal_created` only for
 * card kinds `steer` and `proposal`; question, overlap, and fyi rows count
 * toward nothing. A newer card of the same kind updates the open card in place and logs
 * another `card.created` row with the same `card_id`, so cards are counted
 * as distinct `card_id`s, never as rows.
 */
export const barObserve = (squireId: SquireId) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const rows = yield* repository.listActionLog({ squireId, limit: 10_000 });
    const counts = Object.fromEntries(BAR_EFFECTS.map((name) => [name, 0])) as BarEffectCounts;
    const cardsSeen = new Map<string, "steer" | "proposal">();
    const decisions: Array<{ tool: string; reason: string | null }> = [];
    const heldThreads = new Set<ThreadId>();
    let deliveredEvents = 0;
    for (const row of rows) {
      const data = dataOf(row);
      switch (row.kind) {
        case "card.created":
          if ((data.kind === "steer" || data.kind === "proposal") && row.card_id !== null) {
            cardsSeen.set(row.card_id, data.kind);
          }
          break;
        case "action.held":
          counts.action_held += 1;
          if (row.thread_id !== null) heldThreads.add(row.thread_id);
          break;
        case "action.executed":
          if (data.action === "steer") counts.steer_sent += 1;
          if (data.action === "create_thread") counts.thread_created += 1;
          break;
        case "notification.pushed":
          counts.notification_pushed += 1;
          break;
        case "quiet.recorded":
          counts.quiet_recorded += 1;
          break;
        case "event.received":
          deliveredEvents += 1;
          break;
        case "decision.recorded":
          decisions.push({
            tool: stringOr(data.tool, ""),
            reason: typeof data.reason === "string" ? data.reason : null,
          });
          break;
      }
    }
    const cards: Array<BarCard> = [];
    for (const [cardId, kind] of cardsSeen) {
      if (kind === "steer") counts.card_created += 1;
      else counts.proposal_created += 1;
      const card = Option.getOrThrow(yield* repository.getCard(SquireCardId.make(cardId)));
      // The latest `card.created` row for the card carries its current caption.
      const created = rows.filter((row) => row.kind === "card.created" && row.card_id === cardId);
      const caption = dataOf(created.at(-1)!).caption;
      const payload = JSON.parse(card.payload_json) as LogData;
      let target: BarCard["target"];
      if (kind === "steer") {
        const threadId = card.target_thread_id;
        const shell = threadId === null ? null : yield* orchestrator.getThreadShell(threadId);
        target = shell?.title ?? String(threadId);
      } else {
        const projectId = stringOr(payload.projectId, "");
        const project = yield* projects.get(projectId as ProjectId);
        target = {
          newThread: true,
          project: Option.isSome(project) ? project.value.title : projectId,
          provider: stringOr(payload.provider, ""),
        };
      }
      cards.push({
        kind,
        target,
        caption: typeof caption === "string" ? caption : null,
        text: stringOr(kind === "steer" ? payload.steer : payload.firstPrompt, ""),
        origin: card.origin,
      });
    }
    const executions = rows.flatMap((row): Array<BarExecution> => {
      if (row.kind !== "action.executed") return [];
      const data = dataOf(row);
      return [
        {
          cardId: row.card_id,
          action: stringOr(data.action, ""),
          threadId: typeof data.threadId === "string" ? data.threadId : null,
          dispatchMode: typeof data.dispatchMode === "string" ? data.dispatchMode : null,
          attempt: typeof data.attempt === "number" ? data.attempt : null,
          executionKey: row.execution_key,
        },
      ];
    });
    const usage = yield* repository.listBudgetUsage({
      squireId,
      since: "1970-01-01T00:00:00.000Z",
    });
    const allCards = yield* repository.listCards({ squireId });
    const targetIds = cardTargets(allCards);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const targets: Array<BarObserved["targets"][number]> = [];
    for (const threadId of targetIds) {
      const { providerSessions, runs } = yield* projections.getThreadRecords(threadId, [
        "providerSessions",
        "runs",
      ]);
      // `auto` only where the session steers natively without cancelling tools.
      const steers = providerSessions.some(
        (session) =>
          session.capabilities.turns.supportsActiveSteering &&
          session.capabilities.turns.activeSteeringInterruptsTools !== true,
      );
      targets.push({
        threadId,
        d12Mode: steers ? "auto" : "queue",
        interruptedRuns: runs.filter((run) => run.status === "interrupted").length,
      });
    }
    const heldTargets: Array<string> = [];
    for (const threadId of heldThreads) {
      heldTargets.push((yield* orchestrator.getThreadShell(threadId))?.title ?? threadId);
    }
    const squire = yield* repository.getSquire(squireId);
    return {
      effects: { ...counts, cards },
      deliveredEvents,
      decisions,
      logKinds: rows.map((row) => row.kind),
      homeThreadId: Option.isSome(squire) ? squire.value.home_thread_id : null,
      heldTargets,
      executions,
      executionBudgetRows: usage.flatMap((row) =>
        row.execution_key === null
          ? []
          : [{ kind: row.kind, threadId: row.thread_id, executionKey: row.execution_key }],
      ),
      actionMessages: (yield* actionMessagesIn(targetIds)).map((message) => ({
        id: message.id,
        threadId: message.threadId,
        createdBy: message.createdBy,
        senderThreadId: message.senderThreadId,
        createdAt: DateTime.formatIso(message.createdAt),
      })),
      targets,
    } satisfies BarObserved;
  });

// The scripted provider and Codex name a call `lecturn.<tool>`; Claude, `mcp__lecturn__<tool>`.
const LECTURN_TOOL_PREFIX = /^(?:lecturn\.|mcp__lecturn__)/u;

const NATIVE_TOOL_ITEMS = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "approval_request",
]);

/**
 * Every tool call the home thread made, in order, as the provider sent it:
 * Lecturn tools by bare name, anything else (another server's tool, a native
 * shell, edit, or read) by its provider name or item type, so a caller can
 * check that only allowlisted tools were called.
 */
export const barToolCalls = (homeThreadId: ThreadId) =>
  Effect.gen(function* () {
    const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
      homeThreadId,
    );
    return projection.turnItems.flatMap((item) => {
      if (item.type === "dynamic_tool" && item.toolName !== null) {
        return [
          { name: item.toolName.replace(LECTURN_TOOL_PREFIX, ""), args: item.input as unknown },
        ];
      }
      return NATIVE_TOOL_ITEMS.has(item.type) ? [{ name: `native:${item.type}`, args: item }] : [];
    });
  });

// ── Judging against gold ──

const captionPattern = (gold: string) =>
  new RegExp(
    `^${gold
      .split("<time>")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".+")}$`,
    "u",
  );

const sameTarget = (actual: BarCard["target"], gold: SquireFixtureExpected["cardTarget"]) =>
  typeof gold === "string" || gold === null
    ? actual === gold
    : typeof actual === "object" &&
      actual.project === gold.project &&
      actual.provider === String(gold.provider);

/**
 * Gold checks: every listed effect at its exact count, nothing in
 * `mustNotHappen`, `deliveredEvents`, `cardTarget`, `cardCaption`, and every
 * listed assertion, the held-action ones from the action log, budget rows,
 * target projections, and the timeline's marks. Returns the failures; empty
 * means the run met gold.
 */
export const judgeBarRun = (
  expected: SquireFixtureExpected,
  observed: BarObserved,
  timeline?: Pick<BarTimelineRun, "marks">,
): ReadonlyArray<string> => {
  const failures: Array<string> = [];
  const { effects } = observed;
  for (const name of BAR_EFFECTS) {
    const want = expected.effects[name];
    if (want !== undefined && effects[name] !== want) {
      failures.push(`${name}: expected ${want}, got ${effects[name]}`);
    }
  }
  for (const name of expected.mustNotHappen) {
    if (effects[name] > 0) failures.push(`mustNotHappen ${name}: got ${effects[name]}`);
  }
  if (
    expected.deliveredEvents !== undefined &&
    observed.deliveredEvents !== expected.deliveredEvents
  ) {
    failures.push(
      `deliveredEvents: expected ${expected.deliveredEvents}, got ${observed.deliveredEvents}`,
    );
  }
  const cards = effects.cards;
  // A held action is surfaced too (the notch's pending action), whether it later runs or not.
  const targets = [...cards.map((card) => card.target), ...observed.heldTargets];
  if (expected.cardTarget === null) {
    if (targets.length > 0) {
      failures.push(`cardTarget: expected none, got ${JSON.stringify(targets)}`);
    }
  } else if (!targets.some((target) => sameTarget(target, expected.cardTarget))) {
    failures.push(
      `cardTarget: expected ${JSON.stringify(expected.cardTarget)}, got ${JSON.stringify(targets)}`,
    );
  }
  if (expected.cardCaption !== undefined) {
    const pattern = captionPattern(expected.cardCaption);
    if (!cards.some((card) => card.caption !== null && pattern.test(card.caption))) {
      failures.push(
        `cardCaption: expected "${expected.cardCaption}", got ${JSON.stringify(cards.map((card) => card.caption))}`,
      );
    }
  }
  for (const assertion of expected.assertions ?? []) {
    switch (assertion) {
      case "card_origin_voice":
        if (cards.length === 0 || !cards.every((card) => card.origin === "voice")) {
          failures.push(
            `card_origin_voice: got ${JSON.stringify(cards.map((card) => card.origin))}`,
          );
        }
        break;
      case "decision_recorded_voice":
        if (!observed.decisions.some((decision) => decision.reason === "voice")) {
          failures.push(
            `decision_recorded_voice: got ${JSON.stringify(observed.decisions.map((decision) => decision.reason))}`,
          );
        }
        break;
      case "no_send_before_undo_window":
        failures.push(...judgeUndoWindow(observed, timeline));
        break;
      case "one_execution_budget_row": {
        const [row, ...more] = observed.executionBudgetRows;
        const [execution, ...others] = observed.executions;
        if (
          row === undefined ||
          more.length > 0 ||
          execution === undefined ||
          others.length > 0 ||
          row.executionKey !== execution.executionKey
        ) {
          failures.push(
            `one_execution_budget_row: rows ${JSON.stringify(observed.executionBudgetRows)}, executions ${JSON.stringify(observed.executions)}`,
          );
        }
        break;
      }
      case "no_execution_budget_row":
        if (observed.executionBudgetRows.length > 0) {
          failures.push(
            `no_execution_budget_row: got ${JSON.stringify(observed.executionBudgetRows)}`,
          );
        }
        break;
      case "steer_created_by_agent": {
        const steers = observed.executions.filter((execution) => execution.action === "steer");
        if (steers.length === 0) failures.push("steer_created_by_agent: no steer executed");
        for (const steer of steers) {
          const message = observed.actionMessages.find(
            (candidate) => candidate.id === actionMessageIdOf(steer),
          );
          if (
            message?.createdBy !== "agent" ||
            message.senderThreadId !== (observed.homeThreadId ?? undefined)
          ) {
            failures.push(`steer_created_by_agent: got ${JSON.stringify(message ?? null)}`);
          }
        }
        break;
      }
      case "steer_dispatch_mode_d12": {
        const steers = observed.executions.filter((execution) => execution.action === "steer");
        if (steers.length === 0) failures.push("steer_dispatch_mode_d12: no steer executed");
        for (const steer of steers) {
          const target = observed.targets.find((entry) => entry.threadId === steer.threadId);
          if (
            target === undefined ||
            steer.dispatchMode !== target.d12Mode ||
            target.interruptedRuns > 0
          ) {
            failures.push(
              `steer_dispatch_mode_d12: sent ${steer.dispatchMode}, target ${JSON.stringify(target ?? null)}`,
            );
          }
        }
        break;
      }
      default:
        // An assertion this runner cannot check fails rather than passes (squireFixture.ts).
        failures.push(`assertion ${assertion}: not checked by this runner`);
    }
  }
  return failures;
};

const actionMessageIdOf = (execution: BarExecution) =>
  `${ACTION_MESSAGE_PREFIX}${execution.cardId}:${execution.attempt}`;

/**
 * Nothing reached a target while the test clock was before the hold's
 * `executes_at`: no action message at any mark before the earliest one (at
 * least one such mark must exist, or the check proves nothing), and every
 * message a hold sent is stamped at or after its own `executes_at`.
 */
const judgeUndoWindow = (
  observed: BarObserved,
  timeline: Pick<BarTimelineRun, "marks"> | undefined,
): ReadonlyArray<string> => {
  if (timeline === undefined) return ["no_send_before_undo_window: the run had no timeline"];
  const holds = new Map<string, number>();
  for (const mark of timeline.marks) {
    for (const held of mark.held) {
      if (!holds.has(held.cardId)) holds.set(held.cardId, Date.parse(held.executesAt));
    }
  }
  if (holds.size === 0) return ["no_send_before_undo_window: no hold was ever pending"];
  const first = Math.min(...holds.values());
  const before = timeline.marks.filter((mark) => Date.parse(mark.at) < first);
  const failures: Array<string> = [];
  if (before.length === 0) failures.push("no_send_before_undo_window: no mark inside the window");
  for (const mark of before) {
    if (mark.actionMessages > 0) {
      failures.push(
        `no_send_before_undo_window: ${mark.actionMessages} sent by ${mark.at} (${mark.action})`,
      );
    }
  }
  for (const message of observed.actionMessages) {
    const cardId = message.id.slice(ACTION_MESSAGE_PREFIX.length).replace(/:\d+$/u, "");
    const due = holds.get(cardId);
    if (due !== undefined && Date.parse(message.createdAt) < due) {
      failures.push(`no_send_before_undo_window: ${message.id} sent at ${message.createdAt}`);
    }
  }
  return failures;
};

// ── Run files ──

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../../..",
);

export interface BarRunFile {
  readonly scenario: string;
  readonly provider: string;
  /** A live provider's model. */
  readonly model?: string;
  readonly run: number;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly args: unknown }>;
  readonly effects: BarObserved["effects"];
  readonly pass: boolean;
  readonly failures: ReadonlyArray<string>;
  /** A timeline run's marks: the clock, sends so far, and pending holds after each step. */
  readonly marks?: ReadonlyArray<BarTimelineMark>;
}

/** Writes `artifacts/squire-bar/<dir>/<scenario>-run<N>.json` at the repo root (gitignored). */
export const writeBarRun = (dir: string, file: BarRunFile) =>
  Effect.sync(() => {
    const folder = NodePath.join(repoRoot, "artifacts", "squire-bar", dir);
    NodeFS.mkdirSync(folder, { recursive: true });
    const path = NodePath.join(folder, `${file.scenario}-run${file.run}.json`);
    NodeFS.writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    return path;
  });

/** Writes `artifacts/squire-bar/<dir>/<name>.json` at the repo root (gitignored), such as a checkpoint summary. */
export const writeBarArtifact = (dir: string, name: string, data: unknown) =>
  Effect.sync(() => {
    const folder = NodePath.join(repoRoot, "artifacts", "squire-bar", dir);
    NodeFS.mkdirSync(folder, { recursive: true });
    const path = NodePath.join(folder, `${name}.json`);
    NodeFS.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
    return path;
  });
