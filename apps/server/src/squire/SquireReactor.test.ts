import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Actor,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  SquireCardId,
  SquireId,
  ThreadId,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
  SquireCreateInput,
  isUnknownUnionMember,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Context from "effect/Context";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { ASK_USER_QUESTION_ID } from "../orchestration-v2/Adapters/ScriptedAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LecturnOrchestrationHooks from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as SquireCommandHook from "./SquireCommandHook.ts";
import * as SquireContainers from "./SquireContainers.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquireFakeScripts from "./SquireFakeScripts.ts";
import * as SquireItems from "./SquireItems.ts";
import * as SquireLifecycle from "./SquireLifecycle.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquireReactor from "./SquireReactor.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireScope from "./SquireScope.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireSummaries from "./SquireSummaries.ts";
import { squireDeterministicSummary, squireSummaryInputFromRun } from "./SquireSummaryInput.ts";
import { writeLeadItemEvent } from "./squireLeadItems.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import {
  deleteProject,
  initRepo,
  scripted,
  scriptedModel,
  seedProject,
  tempRoot,
} from "./testkit/lifecycleHarness.ts";
import { phase4Layer } from "./testkit/phase4Harness.ts";
import {
  createThread,
  dispatchThread,
  grantRow,
  orchestratorLayer,
  squireRow,
} from "./testkit/scopeHarness.ts";
import { runSnapshot } from "./testkit/summaryRun.ts";

const projectA = ProjectId.make("project:a");
const release = SquireId.make("squire:release");
const billing = SquireId.make("squire:billing");
const lead = SquireId.make("squire:lead");
const worker = ThreadId.make("thread:worker");
const untracked = ThreadId.make("thread:untracked");
const home = ThreadId.make("thread:squire-home");
const instanceId = ProviderInstanceId.make("codex");
const STUB_SUMMARY = squireDeterministicSummary(
  squireSummaryInputFromRun(runSnapshot()),
  "finished",
);

// ── Harness: real orchestration persistence, Squire repository, scope, and
// command hook; recorded delivery, summaries, and lifecycle. ──

interface Calls {
  readonly wakes: Array<SquireId>;
  readonly finalized: Array<{ readonly runId: RunId; readonly status: string }>;
  readonly ensured: Array<string>;
  readonly rehomed: Array<SquireId>;
  readonly driven: Array<SquireId>;
  /** When set, summary generation waits on it. */
  gate: Deferred.Deferred<void> | undefined;
  /** Resolved when a summary generation starts. */
  ensureStarted: Deferred.Deferred<void> | undefined;
  /** When set, summary generation returns it instead of the stub. */
  summary: typeof STUB_SUMMARY | undefined;
}

const makeHarness = () => {
  const calls: Calls = {
    wakes: [],
    finalized: [],
    ensured: [],
    rehomed: [],
    driven: [],
    gate: undefined,
    ensureStarted: undefined,
    summary: undefined,
  };
  const delivery = Layer.succeed(
    SquireDelivery.SquireDelivery,
    SquireDelivery.SquireDelivery.of({
      wake: (squireId) => Effect.sync(() => void calls.wakes.push(squireId)),
      deliverReady: () => Effect.void,
      finalizeRun: ({ runId, status }) =>
        Effect.sync(() => void calls.finalized.push({ runId, status })),
      redispatchBatched: Effect.void,
      drain: Effect.void,
    }),
  );
  const summaries = Layer.succeed(
    SquireSummaries.SquireSummaries,
    SquireSummaries.SquireSummaries.of({
      ensure: (request) =>
        Effect.gen(function* () {
          calls.ensured.push(`${request.threadId}:${request.runId}:${request.stage}`);
          if (calls.ensureStarted) yield* Deferred.succeed(calls.ensureStarted, undefined);
          if (calls.gate) yield* Deferred.await(calls.gate);
          return {
            status: "complete" as const,
            summary: calls.summary ?? STUB_SUMMARY,
            payerSquireId: null,
          };
        }),
      read: () => Effect.succeedNone,
      settleInterrupted: Effect.succeed(0),
    }),
  );
  const lifecycle = Layer.mock(SquireLifecycle.SquireLifecycle)({
    rehome: (squireId) => Effect.sync(() => void calls.rehomed.push(squireId)),
    drive: (squireId) =>
      Effect.sync(() => {
        calls.driven.push(squireId);
        return Option.none();
      }),
  });
  const services = Layer.mergeAll(
    SquireScope.layer.pipe(Layer.provide(SquireContainers.layerTest({ spaces: [] }))),
    // The real command allowlist on marked threads, so auto-decline proves it passes.
    SquireCommandHook.layer.pipe(Layer.provide(LecturnOrchestrationHooks.layer)),
    SquireItems.layer,
    SquirePolicyLock.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-squire-reactor-" }),
    delivery,
    summaries,
    lifecycle,
  ).pipe(
    Layer.provideMerge(SquireRepository.layer),
    Layer.provideMerge(RuntimeLayer.layerEventInfrastructure),
    Layer.provideMerge(orchestratorLayer),
  );
  return { calls, layer: SquireReactor.layer.pipe(Layer.provideMerge(services)) };
};

/**
 * Starts the reactor for an on period and returns a drain through everything
 * committed so far. `turnedOn` as when the period's cursor sync jumped.
 */
const startReactorWith = (input: { readonly turnedOn: boolean }) =>
  Effect.gen(function* () {
    const reactor = yield* SquireReactor.SquireReactor;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const fiber = yield* Effect.forkScoped(reactor.start(input));
    const drain = Effect.flatMap(events.latestApplicationSequence, reactor.drainThrough);
    return { reactor, fiber, drain };
  });
const startReactor = startReactorWith({ turnedOn: false });

// ── Event builders ──

let counter = 0;
const eventId = () => EventId.make(`event:squire-reactor:${++counter}`);

const write = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.flatMap(EventSink.EventSinkV2, (sink) => sink.write({ events }));

const ordinals = new Map<RunId, number>();
const ordinalOf = (runId: RunId) => {
  if (!ordinals.has(runId)) ordinals.set(runId, ordinals.size + 1);
  return ordinals.get(runId)!;
};

const run = (
  threadId: ThreadId,
  runId: RunId,
  status: OrchestrationV2Run["status"],
  now: DateTime.Utc,
): OrchestrationV2Run => ({
  id: runId,
  threadId,
  ordinal: ordinalOf(runId),
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${runId}`),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: now,
  completedAt: status === "running" || status === "starting" ? null : now,
  checkpointId: null,
  contextHandoffId: null,
});

const runEvent = (
  threadId: ThreadId,
  runId: RunId,
  status: OrchestrationV2Run["status"],
  now: DateTime.Utc,
  type: "run.created" | "run.updated" = "run.updated",
): OrchestrationV2DomainEvent => ({
  id: eventId(),
  type,
  threadId,
  runId,
  occurredAt: now,
  payload: run(threadId, runId, status, now),
});

const itemEvent = (
  threadId: ThreadId,
  now: DateTime.Utc,
  item: Record<string, unknown> & { readonly id: string; readonly type: string },
): OrchestrationV2DomainEvent => ({
  id: eventId(),
  type: "turn-item.updated",
  threadId,
  occurredAt: now,
  payload: {
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: counter,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    ...item,
  } as OrchestrationV2TurnItem,
});

const userMessage = (
  threadId: ThreadId,
  runId: RunId,
  createdBy: OrchestrationV2Actor,
  now: DateTime.Utc,
): OrchestrationV2DomainEvent => ({
  id: eventId(),
  type: "message.updated",
  threadId,
  runId,
  occurredAt: now,
  payload: {
    createdBy,
    creationSource: "web",
    id: MessageId.make(`message:${runId}`),
    threadId,
    runId,
    nodeId: null,
    role: "user",
    text: "carry on",
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
  },
});

const requestEvents = (
  threadId: ThreadId,
  runId: RunId,
  requestId: string,
  input: {
    readonly kind: "user_input" | "command";
    readonly status?: "pending" | "resolved";
    readonly now: DateTime.Utc;
  },
): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const nodeId = NodeId.make(`node:${requestId}`);
  const status = input.status ?? "pending";
  const item =
    input.kind === "user_input"
      ? {
          type: "user_input_request",
          requestId,
          questions: [
            {
              id: "q1",
              header: "Deploy",
              question: "Deploy to staging now?",
              options: [
                { label: "Yes", description: "Ship it" },
                { label: "No", description: "Wait for review" },
              ],
            },
          ],
        }
      : {
          type: "approval_request",
          requestId,
          requestKind: "command",
          prompt: "Run rm -rf build?",
        };
  return [
    itemEvent(threadId, input.now, {
      id: `item:${requestId}`,
      runId,
      nodeId,
      status: status === "pending" ? "waiting" : "completed",
      ...item,
    }),
    {
      id: eventId(),
      type: "runtime-request.updated",
      threadId,
      runId,
      occurredAt: input.now,
      payload: {
        id: RuntimeRequestId.make(requestId),
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: input.kind,
        status,
        responseCapability: { type: "message" },
        createdAt: input.now,
        resolvedAt: status === "pending" ? null : input.now,
      },
    },
  ];
};

const secretItem = (
  threadId: ThreadId,
  runId: RunId,
  itemId: string,
  secretStatus: "pending" | "saved" | "declined" | "cancelled",
  now: DateTime.Utc,
) =>
  itemEvent(threadId, now, {
    id: itemId,
    runId,
    type: "secret_request",
    status: secretStatus === "pending" ? "waiting" : "completed",
    label: "STRIPE_KEY",
    reason: "to run the billing tests",
    secretStatus,
  });

const snapshot = (
  headSha: string,
  overrides: Partial<ThreadPullRequestSnapshot> = {},
): ThreadPullRequestSnapshot => ({
  state: "open",
  title: "Fix invoice rounding",
  headBranch: "fix/rounding",
  baseBranch: "main",
  isDraft: false,
  updatedAt: "2026-11-01T11:59:00.000Z",
  syncedAt: "2026-11-01T12:00:00.000Z",
  checksState: "pending",
  mergeability: "unknown",
  headSha,
  ...overrides,
});

const prEvent = (
  threadId: ThreadId,
  snap: ThreadPullRequestSnapshot,
  now: DateTime.Utc,
  number = 321,
): OrchestrationV2DomainEvent => {
  const link: ThreadPullRequestLink = {
    host: "github.com",
    repository: "acme/billing-service",
    number,
    url: `https://github.com/acme/billing-service/pull/${number}`,
    source: "created",
    linkedAt: "2026-11-01T10:00:00.000Z",
    snapshot: snap,
    stack: null,
  };
  return {
    id: eventId(),
    type: "thread.pull-request-link-updated",
    threadId,
    occurredAt: now,
    payload: link,
  };
};

// ── Fixtures ──

/** Only Squire modules may create marked threads. */
const createHome = withSquireDispatchOrigin(createThread(home, projectA, release));

const seedSquires = (squires: ReadonlyArray<SquireRepository.SquireRow>) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    for (const squire of squires) {
      yield* repository.createSquire(squire);
      if (squire.role === "squire") {
        yield* repository.insertGrant(grantRow(squire.id, "project", projectA));
      }
    }
  });

/** One Squire tracking project A, with `worker` (tracked) and `untracked` threads. */
const setup = (squires = [squireRow(release)]) =>
  Effect.gen(function* () {
    yield* seedSquires(squires);
    yield* createThread(worker, projectA);
    yield* createThread(untracked, ProjectId.make("project:elsewhere"));
  });

const rows = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  return yield* repository.listEvents({
    statuses: ["deferred", "pending", "batched", "delivered", "dropped"],
  });
});

const openCard = (
  id: string,
  overrides: Partial<SquireRepository.SquireCardRow> = {},
): SquireRepository.SquireCardRow => ({
  id: SquireCardId.make(id),
  squire_id: release,
  owner_squire_id: release,
  kind: "steer",
  status: "open",
  target_thread_id: worker,
  project_id: projectA,
  title: "Rebase onto main",
  why: "",
  payload_json: "{}",
  evidence_json: "{}",
  trigger_json: "{}",
  intent_json: null,
  origin: "event",
  steer_kind: null,
  routed_task_id: null,
  rule_id: null,
  finding_key: null,
  escalate_at: null,
  opened_at: null,
  executes_at: null,
  attempt: 0,
  command_id: null,
  execution_key: null,
  dedupe_key: null,
  replaced_count: 0,
  ask_json: null,
  resolution: null,
  created_at: "1970-01-01T00:00:00.000Z",
  updated_at: "1970-01-01T00:00:00.000Z",
  ...overrides,
});

const leadItemRows = rows.pipe(
  Effect.map((all) =>
    all
      .filter((row) => row.kind === "item-raised" || row.kind === "item-resolved")
      .map((row) => ({
        squireId: row.squire_id,
        threadId: row.thread_id,
        kind: row.kind,
        stateKey: row.state_key,
        payload: row.payload_json === null ? null : JSON.parse(row.payload_json),
      })),
  ),
);

const cardStatus = (id: string) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    return Option.map(yield* repository.getCard(SquireCardId.make(id)), (card) => card.status);
  });

type HarnessServices = Layer.Success<ReturnType<typeof makeHarness>["layer"]>;

const runIn = <A, E>(
  effect: (calls: Calls) => Effect.Effect<A, E, HarnessServices | Scope.Scope>,
) => {
  const harness = makeHarness();
  return effect(harness.calls).pipe(Effect.scoped, Effect.provide(harness.layer));
};

// ── Tests ──

describe("SquireReactor triggers", () => {
  it.effect(
    "a finished run on a tracked thread is one turn-finished row; its summary promotes it",
    () =>
      runIn((calls) =>
        Effect.gen(function* () {
          yield* setup();
          const { drain } = yield* startReactor;
          const now = yield* DateTime.now;
          const runId = RunId.make("run:finished");
          yield* write([runEvent(worker, runId, "running", now, "run.created")]);
          yield* write([runEvent(worker, runId, "completed", now)]);
          yield* write([runEvent(untracked, RunId.make("run:untracked"), "completed", now)]);
          yield* drain;
          const [row, ...rest] = yield* rows;
          assert.lengthOf(rest, 0);
          assert.include(row, {
            squire_id: release,
            thread_id: worker,
            kind: "turn-finished",
            state_key: runId,
            status: "pending",
            defer_reason: "summary",
          });
          assert.deepStrictEqual(calls.ensured, [`${worker}:${runId}:terminal`]);
          assert.deepStrictEqual(calls.wakes, [release]);
        }),
      ),
  );
});

const interruptItem = (runId: RunId, createdBy: OrchestrationV2Actor, now: DateTime.Utc) =>
  itemEvent(worker, now, {
    id: `item:interrupt:${runId}`,
    runId,
    type: "run_interrupt_request",
    message: "stop",
    createdBy,
  });

const subagentItem = (runId: RunId, status: "running" | "completed", now: DateTime.Utc) =>
  itemEvent(worker, now, {
    id: `item:subagent:${runId}`,
    runId,
    type: "subagent",
    status,
    subagentId: NodeId.make(`node:subagent:${runId}`),
    origin: "provider_native",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: instanceId,
    childThreadId: null,
    prompt: "watch the deploy",
    result: null,
  });

/** A run that started and reached `status`, optionally interrupted by `actor` first. */
const finishRun = (
  runId: RunId,
  status: OrchestrationV2Run["status"],
  now: DateTime.Utc,
  actor?: OrchestrationV2Actor,
  threadId = worker,
) =>
  Effect.gen(function* () {
    yield* write([runEvent(threadId, runId, "running", now, "run.created")]);
    if (actor !== undefined) yield* write([interruptItem(runId, actor, now)]);
    yield* write([runEvent(threadId, runId, status, now)]);
  });

describe("SquireReactor stops and scope", () => {
  it.effect(
    "user stops are silent; agent, system, crash, and failure stops are thread-stopped",
    () =>
      runIn(() =>
        Effect.gen(function* () {
          yield* setup([squireRow(release), squireRow(lead, { role: "lead" })]);
          const { drain } = yield* startReactor;
          const now = yield* DateTime.now;
          yield* finishRun(RunId.make("run:user"), "interrupted", now, "user");
          yield* finishRun(RunId.make("run:agent"), "interrupted", now, "agent");
          yield* finishRun(RunId.make("run:system"), "cancelled", now, "system");
          yield* finishRun(RunId.make("run:crash"), "interrupted", now);
          yield* finishRun(RunId.make("run:failed"), "failed", now);
          yield* drain;
          const all = yield* rows;
          assert.deepStrictEqual(
            all.map((row) => [row.squire_id, row.kind, row.state_key]),
            [
              [release, "thread-stopped", "run:agent"],
              [release, "thread-stopped", "run:system"],
              [release, "thread-stopped", "run:crash"],
              [release, "thread-stopped", "run:failed"],
            ],
          );
        }),
      ),
  );

  it.effect("a Squire with turn-finished off and a paused Squire get no row", () =>
    runIn(() =>
      Effect.gen(function* () {
        yield* setup([
          squireRow(release),
          squireRow(billing, { events_json: '{"turnFinished":false}' }),
          squireRow(SquireId.make("squire:paused"), { status: "paused" }),
        ]);
        const { drain } = yield* startReactor;
        yield* finishRun(RunId.make("run:1"), "completed", yield* DateTime.now);
        yield* drain;
        assert.deepStrictEqual(
          (yield* rows).map((row) => row.squire_id),
          [release],
        );
      }),
    ),
  );

  it.effect("a home thread's runs make no rows; its run end finalizes the batch", () =>
    runIn((calls) =>
      Effect.gen(function* () {
        yield* setup();
        yield* createHome;
        const { drain } = yield* startReactor;
        const runId = RunId.make("run:home");
        yield* finishRun(runId, "completed", yield* DateTime.now, undefined, home);
        yield* drain;
        assert.deepStrictEqual(yield* rows, []);
        assert.deepStrictEqual(calls.finalized, [{ runId, status: "completed" }]);
      }),
    ),
  );
});

describe("SquireReactor PR dedupe", () => {
  it.effect("fail, pass, fail on three heads is three rows even when ingested late", () =>
    runIn(() =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        yield* setup();
        const now = yield* DateTime.now;
        // Committed before the reactor starts, so it classifies each from its own payload.
        yield* write([prEvent(worker, snapshot("sha1", { checksState: "failing" }), now)]);
        yield* write([prEvent(worker, snapshot("sha2", { checksState: "passing" }), now)]);
        yield* write([prEvent(worker, snapshot("sha3", { checksState: "failing" }), now)]);
        const { drain } = yield* startReactor;
        yield* drain;
        const prKey = "github.com/acme/billing-service#321";
        assert.deepStrictEqual(
          (yield* rows).map((row) => row.state_key),
          [
            `${prKey}:sha1:checks:failed`,
            `${prKey}:sha2:checks:passed`,
            `${prKey}:sha3:checks:failed`,
          ],
        );

        // The same state again (only the title moved) is no new row.
        yield* write([
          prEvent(worker, snapshot("sha3", { checksState: "failing", title: "Renamed" }), now),
        ]);
        yield* drain;
        assert.lengthOf(yield* rows, 3);

        // Another PR on the same thread is keyed separately.
        yield* write([prEvent(worker, snapshot("sha3", { checksState: "failing" }), now, 322)]);
        yield* drain;
        assert.lengthOf(yield* rows, 4);

        // Pruned payloads keep their keys, so a recurring absolute state stays deduped.
        const ids = (yield* rows).map((row) => row.id);
        yield* repository.setEventStatus({
          ids,
          fromStatuses: ["deferred", "pending"],
          status: "delivered",
        });
        assert.strictEqual(yield* repository.pruneEventPayloads({ before: "9999-01-01" }), 4);
        yield* write([prEvent(worker, snapshot("sha3", { checksState: "failing" }), now)]);
        yield* drain;
        const after = yield* rows;
        assert.lengthOf(after, 4);
        assert.isTrue(after.every((row) => row.payload_json === null));
      }),
    ),
  );
});

describe("SquireReactor PR without a head sha", () => {
  it.effect("an Azure DevOps snapshot still raises one row per state", () =>
    runIn(() =>
      Effect.gen(function* () {
        yield* setup();
        const { drain } = yield* startReactor;
        const now = yield* DateTime.now;
        const azure = (overrides: Partial<ThreadPullRequestSnapshot>) => {
          const { headSha: _, ...rest } = snapshot("unused", {
            checksState: undefined,
            ...overrides,
          });
          return prEvent(worker, rest, now);
        };
        yield* write([azure({ mergeability: "conflicting" })]);
        yield* write([azure({ mergeability: "conflicting", title: "Renamed" })]);
        yield* drain;
        const prKey = "github.com/acme/billing-service#321";
        assert.deepStrictEqual(
          (yield* rows).map((row) => row.state_key),
          [`${prKey}:updated-20261101115900000:mergeable:conflicting`],
        );
      }),
    ),
  );
});

describe("SquireReactor deferrals", () => {
  it.effect("background work defers turn-finished until it ends; a newer run drops it", () =>
    runIn(() =>
      Effect.gen(function* () {
        yield* setup();
        const { drain } = yield* startReactor;
        const now = yield* DateTime.now;
        const first = RunId.make("run:bg-1");
        yield* write([runEvent(worker, first, "running", now, "run.created")]);
        yield* write([subagentItem(first, "running", now)]);
        yield* write([runEvent(worker, first, "completed", now)]);
        yield* drain;
        assert.deepStrictEqual(
          (yield* rows).map((row) => [row.state_key, row.status, row.defer_reason]),
          [[first, "deferred", "background"]],
        );
        yield* write([subagentItem(first, "completed", now)]);
        yield* drain;
        assert.deepStrictEqual(
          (yield* rows).map((row) => [row.state_key, row.status]),
          [[first, "pending"]],
        );

        const second = RunId.make("run:bg-2");
        yield* write([runEvent(worker, second, "running", now, "run.created")]);
        yield* write([subagentItem(second, "running", now)]);
        yield* write([runEvent(worker, second, "completed", now)]);
        yield* drain;
        yield* write([runEvent(worker, RunId.make("run:bg-3"), "running", now, "run.created")]);
        yield* drain;
        assert.deepStrictEqual(
          (yield* rows).map((row) => [row.state_key, row.status]),
          [
            [first, "pending"],
            [second, "dropped"],
          ],
        );
      }),
    ),
  );

  it.effect("a summary that misses its 20 s wait still delivers, partial", () =>
    runIn((calls) =>
      Effect.gen(function* () {
        const reactorAt = yield* DateTime.now;
        yield* setup();
        const { reactor, drain } = yield* startReactor;
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        calls.gate = gate;
        calls.ensureStarted = started;
        yield* finishRun(RunId.make("run:slow"), "completed", reactorAt);
        yield* Deferred.await(started);
        assert.deepStrictEqual(yield* reactor.promoteDue(reactorAt), []);
        yield* TestClock.adjust("20 seconds");
        assert.deepStrictEqual(yield* reactor.promoteDue(yield* DateTime.now), [release]);
        assert.deepStrictEqual(
          (yield* rows).map((row) => [row.status, row.defer_reason]),
          [["pending", "summary"]],
        );
        yield* Deferred.succeed(gate, undefined);
        yield* drain;
        assert.strictEqual((yield* rows)[0]?.status, "pending");
      }),
    ),
  );

  it.effect("a restart after the cursor advanced re-reads nothing", () =>
    runIn((calls) =>
      Effect.gen(function* () {
        yield* setup();
        yield* createHome;
        const first = yield* startReactor;
        const now = yield* DateTime.now;
        yield* finishRun(RunId.make("run:before"), "completed", now);
        yield* finishRun(RunId.make("run:home"), "completed", now, undefined, home);
        yield* first.drain;
        yield* Fiber.interrupt(first.fiber);
        const before = {
          rows: yield* rows,
          wakes: calls.wakes.length,
          ensured: calls.ensured.length,
        };
        assert.lengthOf(calls.finalized, 1);

        yield* Effect.gen(function* () {
          const second = yield* startReactor;
          yield* second.drain;
        }).pipe(Effect.scoped, Effect.provide(Layer.fresh(SquireReactor.layer)));
        assert.deepStrictEqual(yield* rows, before.rows);
        assert.strictEqual(calls.wakes.length, before.wakes);
        assert.strictEqual(calls.ensured.length, before.ensured);
        assert.lengthOf(calls.finalized, 1);
      }),
    ),
  );
});

describe("SquireReactor question cards", () => {
  it.effect(
    "a waiting request raises one card after the threshold; the item reads live options",
    () =>
      runIn((calls) =>
        Effect.gen(function* () {
          const repository = yield* SquireRepository.SquireRepository;
          const items = yield* SquireItems.SquireItems;
          yield* setup([squireRow(release), squireRow(lead, { role: "lead" })]);
          const { reactor, drain } = yield* startReactor;
          const now = yield* DateTime.now;
          const runId = RunId.make("run:asks");
          yield* write([runEvent(worker, runId, "running", now, "run.created")]);
          yield* write(requestEvents(worker, runId, "req-1", { kind: "user_input", now }));
          yield* drain;
          assert.deepStrictEqual(
            (yield* rows).map((row) => [row.kind, row.status, row.defer_reason, row.not_before]),
            [["waiting-on-user", "deferred", "threshold", "1970-01-01T00:30:00.000Z"]],
          );
          assert.deepStrictEqual(yield* reactor.promoteDue(now), []);

          yield* TestClock.adjust("30 minutes");
          yield* reactor.promoteDue(yield* DateTime.now);
          yield* reactor.promoteDue(yield* DateTime.now);
          yield* drain;
          const cards = yield* repository.listCards({ kinds: ["question"] });
          assert.lengthOf(cards, 1);
          const card = cards[0]!;
          assert.include(card, { squire_id: release, status: "open", target_thread_id: worker });
          assert.strictEqual(card.title, "Deploy to staging now?");
          assert.notInclude(card.payload_json, "Deploy to staging");
          assert.notInclude(card.payload_json, "Ship it");
          assert.deepStrictEqual(JSON.parse(card.trigger_json), { runId, requestId: "req-1" });
          assert.deepStrictEqual(calls.ensured, [`${worker}:${runId}:request:req-1`]);
          assert.deepStrictEqual(
            (yield* rows).map((row) => [row.squire_id, row.kind, row.status]),
            [
              [release, "waiting-on-user", "pending"],
              [lead, "item-raised", "pending"],
            ],
          );
          // A question card never pushes.
          assert.deepStrictEqual(
            yield* repository.listActionLog({
              squireId: release,
              kinds: ["notification.pushed"],
              limit: 10,
            }),
            [],
          );

          const item = Option.getOrThrow(yield* items.get(card.id));
          assert.deepStrictEqual(item.payload, {
            type: "question",
            threadId: worker,
            requestKind: "runtime",
            requestId: "req-1",
            question: "Deploy to staging now?",
            options: [
              { label: "Yes", description: "Ship it" },
              { label: "No", description: "Wait for review" },
            ],
            // The thread's own request shape, so the card answers by question id.
            request: {
              type: "user-input",
              questions: [
                {
                  id: "q1",
                  header: "Deploy",
                  question: "Deploy to staging now?",
                  options: [
                    { label: "Yes", description: "Ship it" },
                    { label: "No", description: "Wait for review" },
                  ],
                },
              ],
              canRespond: true,
            },
            // The card was raised 30 minutes after the ask; its age counts from the ask.
            requestedAt: DateTime.formatIso(now),
          });
          assert.strictEqual(item.requestedAt, DateTime.formatIso(now));

          // Resolving the request elsewhere resolves the card.
          yield* write(
            requestEvents(worker, runId, "req-1", { kind: "user_input", status: "resolved", now }),
          );
          yield* drain;
          assert.deepStrictEqual(yield* cardStatus(card.id), Option.some("resolved"));
          const resolvedRow = {
            squireId: lead,
            threadId: null,
            kind: "item-resolved",
            stateKey: `${card.id}:resolved`,
            payload: {
              type: "item-resolved",
              cardId: card.id,
              squireId: release,
              cardKind: "question",
              title: "Deploy to staging now?",
              targetThreadId: worker,
              resolution: "answered",
            },
          };
          assert.deepStrictEqual((yield* leadItemRows).slice(1), [resolvedRow]);
          assert.strictEqual(calls.wakes.at(-1), lead);

          // A replayed resolution moves no card and writes no second row.
          yield* write(
            requestEvents(worker, runId, "req-1", { kind: "user_input", status: "resolved", now }),
          );
          yield* drain;
          assert.deepStrictEqual((yield* leadItemRows).slice(1), [resolvedRow]);
        }),
      ),
  );

  it.effect("a question's Why waits for the summary, then yields to the Squire's own note", () =>
    runIn((calls) =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        yield* setup();
        const { reactor, drain } = yield* startReactor;
        const runId = RunId.make("run:why");
        const whyOf = Effect.map(repository.listCards({ kinds: ["question"] }), (cards) =>
          cards.map((card) => card.why),
        );
        const gate = yield* Deferred.make<void>();
        calls.gate = gate;
        calls.summary = {
          ...STUB_SUMMARY,
          goal: "Ship the billing fix before the freeze",
          suggestedNextStep: "Answer Yes: the migration is reversible.",
        };
        yield* write([runEvent(worker, runId, "running", yield* DateTime.now, "run.created")]);
        yield* write(
          requestEvents(worker, runId, "req-why-1", {
            kind: "user_input",
            now: yield* DateTime.now,
          }),
        );
        yield* drain;
        yield* TestClock.adjust("30 minutes");
        yield* reactor.promoteDue(yield* DateTime.now);
        // Raised before its provisional summary exists, the card quotes who asked what, and when.
        assert.deepStrictEqual(yield* whyOf, ["Thread asked 30m ago: 'Deploy to staging now?'"]);
        yield* Deferred.succeed(gate, undefined);
        yield* drain;
        assert.deepStrictEqual(yield* whyOf, ["Ship the billing fix before the freeze"]);
        // The suggested step is the card's recommendation, not part of the Why.
        const [raised] = yield* repository.listCards({ kinds: ["question"] });
        assert.strictEqual(
          (JSON.parse(raised!.payload_json) as { recommendation?: string }).recommendation,
          "Answer Yes: the migration is reversible.",
        );

        yield* repository.insertCard(
          openCard("card:note", {
            kind: "fyi",
            title: "Staging is frozen",
            payload_json: JSON.stringify({
              type: "fyi",
              source: "notify",
              text: "Staging is frozen until 5pm; answer No unless it is urgent.",
              threadId: worker,
            }),
          }),
        );
        yield* write(
          requestEvents(worker, runId, "req-why-2", {
            kind: "user_input",
            now: yield* DateTime.now,
          }),
        );
        yield* drain;
        yield* TestClock.adjust("30 minutes");
        yield* reactor.promoteDue(yield* DateTime.now);
        yield* drain;
        assert.deepStrictEqual(yield* whyOf, [
          "Staging is frozen until 5pm; answer No unless it is urgent.",
        ]);
      }),
    ),
  );

  it.effect(
    "a question's Why skips a summary goal that only restates the thread title, quoting the ask",
    () =>
      runIn((calls) =>
        Effect.gen(function* () {
          const repository = yield* SquireRepository.SquireRepository;
          yield* setup();
          const { reactor, drain } = yield* startReactor;
          const runId = RunId.make("run:why-title");
          const gate = yield* Deferred.make<void>();
          calls.gate = gate;
          // The worker thread is titled "Thread".
          calls.summary = { ...STUB_SUMMARY, goal: "  thread " };
          yield* write([runEvent(worker, runId, "running", yield* DateTime.now, "run.created")]);
          yield* write(
            requestEvents(worker, runId, "req-why-title", {
              kind: "user_input",
              now: yield* DateTime.now,
            }),
          );
          yield* drain;
          yield* TestClock.adjust("30 minutes");
          yield* reactor.promoteDue(yield* DateTime.now);
          yield* Deferred.succeed(gate, undefined);
          yield* drain;
          const cards = yield* repository.listCards({ kinds: ["question"] });
          assert.deepStrictEqual(
            cards.map((card) => card.why),
            ["Thread asked 30m ago: 'Deploy to staging now?'"],
          );
        }),
      ),
  );

  it.effect("a request answered before its threshold raises nothing", () =>
    runIn(() =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        yield* setup();
        const { reactor, drain } = yield* startReactor;
        const now = yield* DateTime.now;
        const runId = RunId.make("run:quick");
        yield* write(requestEvents(worker, runId, "req-quick", { kind: "user_input", now }));
        yield* write(
          requestEvents(worker, runId, "req-quick", {
            kind: "user_input",
            status: "resolved",
            now,
          }),
        );
        yield* drain;
        yield* TestClock.adjust("1 hour");
        assert.deepStrictEqual(yield* reactor.promoteDue(yield* DateTime.now), []);
        assert.deepStrictEqual(
          (yield* rows).map((row) => row.status),
          ["dropped"],
        );
        assert.deepStrictEqual(yield* repository.listCards({}), []);
      }),
    ),
  );

  it.effect("a request answered after its threshold but before delivery is not delivered", () =>
    runIn(() =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        yield* setup();
        const { reactor, drain } = yield* startReactor;
        const now = yield* DateTime.now;
        const runId = RunId.make("run:late-answer");
        yield* write([runEvent(worker, runId, "running", now, "run.created")]);
        yield* write(requestEvents(worker, runId, "req-late", { kind: "user_input", now }));
        yield* drain;
        yield* TestClock.adjust("30 minutes");
        yield* reactor.promoteDue(yield* DateTime.now);
        yield* drain;
        assert.deepStrictEqual(
          (yield* rows).map((row) => row.status),
          ["pending"],
        );
        const [card] = yield* repository.listCards({ kinds: ["question"] });

        yield* write(
          requestEvents(worker, runId, "req-late", {
            kind: "user_input",
            status: "resolved",
            now,
          }),
        );
        yield* drain;
        assert.deepStrictEqual(
          (yield* rows).map((row) => row.status),
          ["dropped"],
        );
        assert.deepStrictEqual(yield* cardStatus(card!.id), Option.some("resolved"));
      }),
    ),
  );

  it.effect("a pending secret yields a secret question card that stores no secret", () =>
    runIn(() =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const items = yield* SquireItems.SquireItems;
        yield* setup();
        const { reactor, drain } = yield* startReactor;
        const now = yield* DateTime.now;
        const runId = RunId.make("run:secret");
        yield* write([secretItem(worker, runId, "item:secret-1", "pending", now)]);
        yield* drain;
        yield* TestClock.adjust("30 minutes");
        yield* reactor.promoteDue(yield* DateTime.now);
        yield* drain;
        const [card] = yield* repository.listCards({ kinds: ["question"] });
        assert.isDefined(card);
        assert.deepStrictEqual(JSON.parse(card!.trigger_json), {
          runId,
          requestId: "item:secret-1",
          secretTurnItemId: "item:secret-1",
        });
        assert.strictEqual(card!.title, "STRIPE_KEY: to run the billing tests");
        for (const json of [card!.payload_json, card!.evidence_json]) {
          assert.notInclude(json, "billing tests");
        }
        const item = Option.getOrThrow(yield* items.get(card!.id));
        assert.deepInclude(item.payload, {
          requestKind: "secret",
          question: "STRIPE_KEY: to run the billing tests",
          options: [],
        });

        yield* write([secretItem(worker, runId, "item:secret-1", "saved", now)]);
        yield* drain;
        assert.deepStrictEqual(yield* cardStatus(card!.id), Option.some("resolved"));
      }),
    ),
  );
});

describe("SquireReactor outdating", () => {
  it.effect(
    "an agent turn outdates cards of earlier runs; a user turn outdates all and holds",
    () =>
      runIn(() =>
        Effect.gen(function* () {
          const repository = yield* SquireRepository.SquireRepository;
          yield* setup();
          yield* repository.insertCard(openCard("card:steer"));
          yield* repository.insertCard(openCard("card:held", { status: "held" }));
          yield* repository.insertCard(
            openCard("card:old-run", { kind: "question", trigger_json: '{"runId":"run:old"}' }),
          );
          const { drain } = yield* startReactor;
          const now = yield* DateTime.now;
          const agentRun = RunId.make("run:agent-turn");
          yield* write([
            userMessage(worker, agentRun, "agent", now),
            runEvent(worker, agentRun, "running", now, "run.created"),
          ]);
          yield* drain;
          assert.deepStrictEqual(
            [
              yield* cardStatus("card:steer"),
              yield* cardStatus("card:held"),
              yield* cardStatus("card:old-run"),
            ],
            [Option.some("open"), Option.some("held"), Option.some("outdated")],
          );

          const userRun = RunId.make("run:user-turn");
          yield* write([
            userMessage(worker, userRun, "user", now),
            runEvent(worker, userRun, "running", now, "run.created"),
          ]);
          yield* drain;
          assert.deepStrictEqual(
            [yield* cardStatus("card:steer"), yield* cardStatus("card:held")],
            [Option.some("outdated"), Option.some("outdated")],
          );
          // No Lead, so nothing to wake.
          assert.deepStrictEqual(yield* leadItemRows, []);
        }),
      ),
  );

  it.effect(
    "outdating a Squire's decision card writes one Lead item-resolved row; FYI and the Lead's own write none",
    () =>
      runIn((calls) =>
        Effect.gen(function* () {
          const repository = yield* SquireRepository.SquireRepository;
          yield* setup([squireRow(release), squireRow(lead, { role: "lead" })]);
          yield* repository.insertCard(openCard("card:steer"));
          yield* repository.insertCard(openCard("card:fyi", { kind: "fyi" }));
          yield* repository.insertCard(
            openCard("card:overlap", { kind: "overlap", squire_id: lead, owner_squire_id: lead }),
          );
          const { drain } = yield* startReactor;
          const now = yield* DateTime.now;
          const userRun = RunId.make("run:user-turn");
          yield* write([
            userMessage(worker, userRun, "user", now),
            runEvent(worker, userRun, "running", now, "run.created"),
          ]);
          yield* drain;
          assert.deepStrictEqual(
            [
              yield* cardStatus("card:steer"),
              yield* cardStatus("card:fyi"),
              yield* cardStatus("card:overlap"),
            ],
            [Option.some("outdated"), Option.some("outdated"), Option.some("outdated")],
          );
          const resolvedRow = {
            squireId: lead,
            threadId: null,
            kind: "item-resolved",
            stateKey: "card:steer:resolved",
            payload: {
              type: "item-resolved",
              cardId: "card:steer",
              squireId: release,
              cardKind: "steer",
              title: "Rebase onto main",
              targetThreadId: worker,
              resolution: "outdated",
            },
          };
          assert.deepStrictEqual(yield* leadItemRows, [resolvedRow]);
          assert.deepStrictEqual(calls.wakes, [lead]);

          // A retried transition (same card, same resolution) writes nothing more.
          const steer = Option.getOrThrow(
            yield* repository.getCard(SquireCardId.make("card:steer")),
          );
          assert.isTrue(
            Option.isNone(
              yield* writeLeadItemEvent(repository, {
                transition: "resolved",
                card: steer,
                now: DateTime.formatIso(now),
              }),
            ),
          );
          assert.deepStrictEqual(yield* leadItemRows, [resolvedRow]);
        }),
      ),
  );

  it.effect("a paused Lead gets no item-resolved row", () =>
    runIn(() =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        yield* setup([squireRow(release), squireRow(lead, { role: "lead", status: "paused" })]);
        yield* repository.insertCard(openCard("card:steer"));
        const { drain } = yield* startReactor;
        const now = yield* DateTime.now;
        const userRun = RunId.make("run:user-turn");
        yield* write([
          userMessage(worker, userRun, "user", now),
          runEvent(worker, userRun, "running", now, "run.created"),
        ]);
        yield* drain;
        assert.deepStrictEqual(yield* cardStatus("card:steer"), Option.some("outdated"));
        assert.deepStrictEqual(yield* leadItemRows, []);
      }),
    ),
  );

  it.effect("a new state for the same PR outdates its card; another PR's card stays", () =>
    runIn(() =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        yield* setup();
        const trigger = (number: number) =>
          JSON.stringify({
            prKey: `github.com/acme/billing-service#${number}`,
            headSha: "sha1",
            transition: "checks:failed",
          });
        yield* repository.insertCard(openCard("card:pr-321", { trigger_json: trigger(321) }));
        yield* repository.insertCard(
          openCard("card:pr-322", { kind: "question", trigger_json: trigger(322) }),
        );
        const { drain } = yield* startReactor;
        const now = yield* DateTime.now;
        yield* write([
          prEvent(
            worker,
            snapshot("sha1", { checksState: "failing", reviewDecision: "approved" }),
            now,
          ),
        ]);
        yield* drain;
        assert.deepStrictEqual(yield* cardStatus("card:pr-321"), Option.some("open"));
        yield* write([prEvent(worker, snapshot("sha2"), now)]);
        yield* drain;
        assert.deepStrictEqual(
          [yield* cardStatus("card:pr-321"), yield* cardStatus("card:pr-322")],
          [Option.some("outdated"), Option.some("open")],
        );
      }),
    ),
  );
});

describe("SquireReactor rerun-checks hold", () => {
  it.effect("a hold for a failing check is outdated when the check passes on the same head", () =>
    runIn(() =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        yield* setup();
        yield* repository.insertCard(
          openCard("card:rerun", {
            status: "held",
            executes_at: "2999-01-01T00:00:00.000Z",
            trigger_json: JSON.stringify({
              prKey: "github.com/acme/billing-service#321",
              headSha: "sha1",
              transition: "checks:failed",
            }),
          }),
        );
        const { drain } = yield* startReactor;
        const now = yield* DateTime.now;
        yield* write([prEvent(worker, snapshot("sha1", { checksState: "passing" }), now)]);
        yield* drain;
        assert.deepStrictEqual(yield* cardStatus("card:rerun"), Option.some("outdated"));
        const cancelled = yield* repository.listActionLog({
          squireId: release,
          kinds: ["action.cancelled"],
          limit: 10,
        });
        assert.deepStrictEqual(
          cancelled.map((row) => [row.card_id, JSON.parse(row.data_json)]),
          [["card:rerun", { reason: "the pull request changed", to: "outdated" }]],
        );
      }),
    ),
  );
});

describe("SquireReactor Squire threads and cascades", () => {
  it.effect("an approval on a home thread is declined through the command hook and logged", () =>
    runIn(() =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* setup();
        yield* createHome;
        const { drain } = yield* startReactor;
        const now = yield* DateTime.now;
        const runId = RunId.make("run:home-approval");
        yield* write(requestEvents(home, runId, "req-approve", { kind: "command", now }));
        yield* write(requestEvents(home, runId, "req-question", { kind: "user_input", now }));
        yield* drain;
        const declined = yield* projections.getRuntimeRequest(
          home,
          RuntimeRequestId.make("req-approve"),
        );
        assert.include(declined, { status: "resolved", decision: "decline" });
        const question = yield* projections.getRuntimeRequest(
          home,
          RuntimeRequestId.make("req-question"),
        );
        assert.strictEqual(question?.status, "pending");
        const log = yield* repository.listActionLog({
          squireId: release,
          kinds: ["decision.recorded"],
          limit: 10,
        });
        assert.deepStrictEqual(
          log.map((row) => [row.thread_id, JSON.parse(row.data_json).requestId]),
          [[home, "req-approve"]],
        );
        assert.deepStrictEqual(yield* rows, []);
      }),
    ),
  );

  it.effect(
    "deleting a tracked thread drops its grants, exclusions, and rows and outdates its cards",
    () =>
      runIn(() =>
        Effect.gen(function* () {
          const repository = yield* SquireRepository.SquireRepository;
          yield* setup([squireRow(release), squireRow(billing)]);
          yield* repository.insertGrant(grantRow(release, "thread", worker));
          yield* repository.insertGrant(grantRow(billing, "exclusion", worker));
          yield* repository.insertCard(openCard("card:doomed"));
          const { drain } = yield* startReactor;
          yield* finishRun(RunId.make("run:doomed"), "completed", yield* DateTime.now);
          yield* drain;
          assert.lengthOf(yield* rows, 1);
          yield* repository.insertSummary({
            thread_id: worker,
            run_id: RunId.make("run:doomed"),
            stage: "terminal",
            status: "complete",
            summary_json: "{}",
            payer_squire_id: null,
            created_at: DateTime.formatIso(yield* DateTime.now),
            updated_at: DateTime.formatIso(yield* DateTime.now),
          });
          yield* dispatchThread("thread.delete", worker);
          yield* drain;
          assert.deepStrictEqual(
            yield* repository.listRunSummaries({
              thread_id: worker,
              run_id: RunId.make("run:doomed"),
            }),
            [],
          );
          assert.deepStrictEqual(
            [
              ...(yield* repository.listGrantsForTarget({ kind: "thread", targetId: worker })),
              ...(yield* repository.listGrantsForTarget({ kind: "exclusion", targetId: worker })),
            ],
            [],
          );
          assert.lengthOf(yield* repository.listGrants(release), 1);
          assert.deepStrictEqual(yield* rows, []);
          assert.deepStrictEqual(yield* cardStatus("card:doomed"), Option.some("outdated"));
        }),
      ),
  );

  it.effect("a deleted home thread re-homes its Squire once", () =>
    runIn((calls) =>
      Effect.gen(function* () {
        yield* setup([squireRow(release, { home_thread_id: home })]);
        yield* createHome;
        const { drain } = yield* startReactor;
        yield* withSquireDispatchOrigin(dispatchThread("thread.delete", home));
        yield* drain;
        assert.deepStrictEqual(calls.rehomed, [release]);
      }),
    ),
  );

  it.effect("a new project moves on a Squire whose re-home was waiting for one", () =>
    runIn((calls) =>
      Effect.gen(function* () {
        yield* setup([
          squireRow(release, { lifecycle: "rehoming" }),
          squireRow(billing, { lifecycle: "ready" }),
        ]);
        const { drain } = yield* startReactor;
        yield* seedProject(ProjectId.make("project:new"), process.cwd());
        yield* drain;
        assert.deepStrictEqual(calls.driven, [release]);
      }),
    ),
  );

  it.effect("the start that turns the switch on applies the deletes its cursor jump skipped", () =>
    runIn((calls) =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const events = yield* OrchestrationEventStore.OrchestrationEventStore;
        const gone = ThreadId.make("thread:gone");
        const goneProject = ProjectId.make("project:gone");
        yield* seedProject(projectA, process.cwd());
        yield* seedProject(goneProject, process.cwd());
        yield* setup([
          squireRow(release, { home_project_id: projectA }),
          squireRow(billing, { home_project_id: goneProject }),
        ]);
        yield* createThread(gone, projectA);
        yield* repository.insertGrant(grantRow(release, "thread", gone));
        yield* repository.insertGrant(grantRow(billing, "project", goneProject));
        yield* repository.insertCard(openCard("card:gone", { target_thread_id: gone }));
        yield* repository.insertCard(openCard("card:live"));
        yield* repository.insertEvent({
          squire_id: release,
          thread_id: gone,
          kind: "turn-finished",
          state_key: "run:gone",
          payload_json: null,
          status: "pending",
          defer_reason: null,
          not_before: "2026-11-01T00:00:00.000Z",
          batch_id: null,
          created_at: "2026-11-01T00:00:00.000Z",
        });
        // The off period: both deletes commit, then the turn-on start jumps past them.
        yield* dispatchThread("thread.delete", gone);
        yield* deleteProject(goneProject);
        yield* repository.writeCursor({
          sequence: yield* events.latestApplicationSequence,
          enabled: true,
        });

        const { drain } = yield* startReactorWith({ turnedOn: true });
        yield* drain;
        assert.deepStrictEqual(
          (yield* repository.listGrants(release)).map((grant) => grant.kind),
          ["project"],
        );
        assert.deepStrictEqual(
          (yield* repository.listGrants(billing)).map((grant) => grant.target_id),
          [projectA],
        );
        assert.deepStrictEqual(yield* cardStatus("card:gone"), Option.some("outdated"));
        assert.deepStrictEqual(yield* cardStatus("card:live"), Option.some("open"));
        assert.deepStrictEqual(yield* rows, []);
        assert.deepStrictEqual(calls.rehomed, [billing]);
      }),
    ),
  );

  it.effect("a fixture-owned thread gets no row but its request still resolves cards", () =>
    runIn(() =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const config = yield* ServerConfig.ServerConfig;
        const fixtureProject = ProjectId.make("project:fixture");
        const fixtureThread = ThreadId.make("thread:fixture");
        yield* seedProject(fixtureProject, `${config.baseDir}/squire-fixtures/observatory`);
        yield* seedSquires([squireRow(release)]);
        yield* repository.insertGrant(grantRow(release, "project", fixtureProject));
        yield* createThread(fixtureThread, fixtureProject);
        assert.isTrue(yield* SquireReactor.isFixtureOwnedThread(fixtureThread));
        yield* repository.insertCard(
          openCard("card:fixture", {
            kind: "question",
            target_thread_id: fixtureThread,
            trigger_json: '{"requestId":"req-fx"}',
          }),
        );
        const { drain } = yield* startReactor;
        const now = yield* DateTime.now;
        yield* finishRun(RunId.make("run:fixture"), "completed", now, undefined, fixtureThread);
        yield* write(
          requestEvents(fixtureThread, RunId.make("run:fixture"), "req-fx", {
            kind: "user_input",
            status: "resolved",
            now,
          }),
        );
        yield* drain;
        assert.deepStrictEqual(yield* rows, []);
        assert.deepStrictEqual(yield* cardStatus("card:fixture"), Option.some("resolved"));
      }),
    ),
  );
});

describe("SquireReactor question resolution", () => {
  const SECRET_VALUE = "sk_live_squire_never_stores_this";

  /** Every row of every Squire table, as JSON, so a value can be searched for anywhere. */
  const dumpSquireTables = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'squire%'`;
    assert.isAtLeast(tables.length, 10);
    const all = yield* Effect.forEach(tables, ({ name }) => sql`SELECT * FROM ${sql(name)}`);
    return JSON.stringify(all);
  });

  const card = (id: SquireCardId) =>
    Effect.flatMap(SquireRepository.SquireRepository, (repository) => repository.getCard(id)).pipe(
      Effect.map(Option.getOrThrow),
      Effect.map((row) => [row.status, row.resolution] as const),
    );

  /** Raises the question card for a pending request past its threshold. */
  const raise = <E>(
    reactor: SquireReactor.SquireReactor["Service"],
    drain: Effect.Effect<void, E>,
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) =>
    Effect.gen(function* () {
      yield* write(events);
      yield* drain;
      yield* TestClock.adjust("30 minutes");
      yield* reactor.promoteDue(yield* DateTime.now);
      yield* drain;
      const repository = yield* SquireRepository.SquireRepository;
      const cards = yield* repository.listCards({ kinds: ["question"], statuses: ["open"] });
      assert.lengthOf(cards, 1);
      return cards[0]!;
    });

  it.effect("a request answered in the thread resolves its card; the card then refuses", () =>
    runIn(() =>
      Effect.gen(function* () {
        const items = yield* SquireItems.SquireItems;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* setup();
        const { reactor, drain } = yield* startReactor;
        const now = yield* DateTime.now;
        const runId = RunId.make("run:ask-thread");
        const question = yield* raise(reactor, drain, [
          runEvent(worker, runId, "running", now, "run.created"),
          ...requestEvents(worker, runId, "req-thread", { kind: "command", now }),
        ]);
        const requestOf = Effect.map(items.get(question.id), (item) => {
          const payload = Option.getOrThrow(item).payload;
          return !isUnknownUnionMember(payload) && payload.type === "question"
            ? payload.request
            : undefined;
        });
        // The thread's own approval shape: its default options, and the thread's own rule
        // that only a live session takes an approval.
        assert.deepStrictEqual(yield* requestOf, { type: "approval", canRespond: false });

        yield* orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("client:respond:req-thread"),
          threadId: worker,
          requestId: RuntimeRequestId.make("req-thread"),
          decision: "decline",
        });
        // Answered before the reactor caught up, the card dispatches nothing.
        const stale = yield* items.answer({
          cardId: question.id,
          requestId: "client-late",
          answer: { decision: "accept" },
        });
        assert.deepStrictEqual(stale.error, {
          code: "outdated",
          message: "This question was already answered in the thread.",
        });
        yield* drain;
        assert.deepStrictEqual(yield* card(question.id), ["resolved", "answered"]);
        // A settled request offers nothing to answer.
        assert.isUndefined(yield* requestOf);
      }),
    ),
  );

  it.effect("an expired request outdates its question card", () =>
    runIn(() =>
      Effect.gen(function* () {
        yield* setup();
        const { reactor, drain } = yield* startReactor;
        const now = yield* DateTime.now;
        const runId = RunId.make("run:ask-expired");
        const pending = requestEvents(worker, runId, "req-expired", { kind: "user_input", now });
        const question = yield* raise(reactor, drain, [
          runEvent(worker, runId, "running", now, "run.created"),
          ...pending,
        ]);
        const request = pending[1]!;
        assert.strictEqual(request.type, "runtime-request.updated");
        if (request.type !== "runtime-request.updated") return;
        yield* write([
          {
            ...request,
            id: eventId(),
            payload: { ...request.payload, status: "expired", resolvedAt: now },
          },
        ]);
        yield* drain;
        assert.deepStrictEqual(yield* card(question.id), ["outdated", "expired"]);
      }),
    ),
  );

  it.effect.each([
    { secretStatus: "saved", expected: ["resolved", "answered"] },
    { secretStatus: "declined", expected: ["resolved", "declined"] },
    { secretStatus: "cancelled", expected: ["outdated", "cancelled"] },
  ] as const)(
    "a $secretStatus secret settles its card and no Squire row holds the secret",
    ({ secretStatus, expected }) =>
      runIn(() =>
        Effect.gen(function* () {
          const items = yield* SquireItems.SquireItems;
          yield* setup();
          const { reactor, drain } = yield* startReactor;
          const now = yield* DateTime.now;
          const runId = RunId.make(`run:secret-${secretStatus}`);
          const itemId = `item:secret-${secretStatus}`;
          const question = yield* raise(reactor, drain, [
            secretItem(worker, runId, itemId, "pending", now),
          ]);

          // The card never takes the secret; it points at the thread's own prompt.
          const refused = yield* items.answer({
            cardId: question.id,
            requestId: "client-secret",
            answer: { answers: { value: SECRET_VALUE } },
          });
          assert.deepStrictEqual(refused, {
            cardId: question.id,
            status: "open",
            error: { code: "invalid_request", message: SquireItems.SECRET_CARD_ANSWER_MESSAGE },
          });

          yield* write([secretItem(worker, runId, itemId, secretStatus, now)]);
          yield* drain;
          assert.deepStrictEqual(yield* card(question.id), expected);
          assert.notInclude(yield* dumpSquireTables, SECRET_VALUE);
        }),
      ),
  );

  it.effect("a live answer on a fixture-owned thread resolves its card and writes no row", () =>
    runIn(() =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const items = yield* SquireItems.SquireItems;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const config = yield* ServerConfig.ServerConfig;
        const fixtureProject = ProjectId.make("project:fixture-answer");
        const fixtureThread = ThreadId.make("thread:fixture-answer");
        yield* seedProject(fixtureProject, `${config.baseDir}/squire-fixtures/answer`);
        yield* seedSquires([squireRow(release)]);
        yield* repository.insertGrant(grantRow(release, "project", fixtureProject));
        yield* createThread(fixtureThread, fixtureProject);
        const runId = RunId.make("run:fixture-answer");
        const cardId = SquireCardId.make("card:fixture-answer");
        // `inject` owns this card's row; only its resolution is live.
        yield* repository.insertCard(
          openCard(cardId, {
            kind: "question",
            target_thread_id: fixtureThread,
            trigger_json: JSON.stringify({ runId, requestId: "req-fx-live" }),
          }),
        );
        const { drain } = yield* startReactor;
        const now = yield* DateTime.now;
        yield* write(requestEvents(fixtureThread, runId, "req-fx-live", { kind: "command", now }));
        yield* drain;
        const result = yield* items.answer({
          cardId,
          requestId: "client-fx",
          answer: { decision: "decline" },
        });
        assert.isNull(result.error);
        assert.include(
          yield* projections.getRuntimeRequest(fixtureThread, RuntimeRequestId.make("req-fx-live")),
          { status: "resolved" },
        );
        yield* drain;
        assert.deepStrictEqual(yield* card(cardId), ["resolved", "answered"]);
        assert.deepStrictEqual(yield* rows, []);
      }),
    ),
  );
});

const decodeCreateInput = Schema.decodeSync(SquireCreateInput);

describe("SquireReactor question answers with the scripted provider", () => {
  const asksProject = ProjectId.make("project-asks");
  const asking = ThreadId.make("thread-asks");
  const need = <I, S>(tag: Context.Key<I, S>) =>
    Effect.map(Effect.serviceOption(tag), Option.getOrThrow);

  /** Drives the effect worker until the thread holds a pending request. */
  const awaitPendingRequest = Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    let afterSequence = 0;
    for (;;) {
      yield* worker.drain();
      const projection = yield* orchestrator.getThreadProjection(asking);
      const pending = projection.runtimeRequests.find((request) => request.status === "pending");
      if (pending !== undefined) return pending.id;
      const next = yield* orchestrator
        .streamStoredEventsFrom({ threadId: asking, afterSequence })
        .pipe(Stream.runHead);
      afterSequence = Option.getOrThrow(next).sequence;
    }
  });

  /** Drives the effect worker until the thread's run ends. */
  const awaitRunEnd = Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    let afterSequence = 0;
    for (;;) {
      yield* worker.drain();
      const run = (yield* orchestrator.getThreadProjection(asking)).runs[0];
      if (run !== undefined && ["completed", "failed", "interrupted"].includes(run.status)) {
        return run;
      }
      const next = yield* orchestrator
        .streamStoredEventsFrom({ threadId: asking, afterSequence, eventType: "run.updated" })
        .pipe(Stream.runHead);
      afterSequence = Option.getOrThrow(next).sequence;
    }
  });

  const settle = Effect.gen(function* () {
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const reactor = yield* need(SquireReactor.SquireReactor);
    yield* reactor.drainThrough(yield* events.latestApplicationSequence);
    yield* (yield* need(SquireDelivery.SquireDelivery)).drain;
  });

  it.effect(
    "a scripted askUser request answered through the card resolves the request, then the card",
    () =>
      Effect.gen(function* () {
        const { root, baseDir } = yield* tempRoot;
        yield* Effect.gen(function* () {
          yield* seedProject(asksProject, initRepo(`${root}/asks`));
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${asking}:create`),
            threadId: asking,
            projectId: asksProject,
            title: "Deploy the invoice fix",
            modelSelection: scriptedModel,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          const squire = yield* (yield* need(SquireService.SquireService)).create(
            decodeCreateInput({
              requestId: "release",
              homeProjectId: asksProject,
              providerInstanceId: scripted,
              modelSelection: scriptedModel,
              name: "Release",
              brief: "Release brief.",
              grants: [{ kind: "project", targetId: asksProject }],
              events: {},
              permissions: {},
              budgets: {},
            }),
          );
          yield* (yield* SquireFakeScripts.SquireFakeScripts).set(squire.homeThreadId!, {
            [SquireFakeScripts.ANY_KIND]: [{ assistantText: "Noted." }],
          });
          yield* ServerRuntimeStartup.startLecturnReactors;
          const script = [
            { askUser: { question: "Deploy to staging now?", options: ["Yes", "No"] } },
            { assistantText: "Deployed." },
          ];
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${asking}:turn`),
            threadId: asking,
            messageId: MessageId.make(`message:${asking}:turn`),
            text: `Ship it.\n\`\`\`scripted\n${JSON.stringify(script)}\n\`\`\``,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const requestId = yield* awaitPendingRequest;
          yield* settle;
          yield* TestClock.adjust("30 minutes");
          yield* (yield* need(SquireReactor.SquireReactor)).promoteDue(yield* DateTime.now);
          yield* settle;
          const repository = yield* SquireRepository.SquireRepository;
          const [question, ...others] = yield* repository.listCards({ kinds: ["question"] });
          assert.lengthOf(others, 0);
          assert.include(question, { status: "open", title: "Deploy to staging now?" });

          const items = yield* need(SquireItems.SquireItems);
          // The answer is built from the card's own copy of the request, as the web card does.
          const { payload } = Option.getOrThrow(yield* items.get(question!.id));
          assert.isFalse(isUnknownUnionMember(payload));
          const request =
            !isUnknownUnionMember(payload) && payload.type === "question"
              ? payload.request
              : undefined;
          const questionId =
            request !== undefined && !isUnknownUnionMember(request) && request.type === "user-input"
              ? request.questions[0]?.id
              : undefined;
          assert.strictEqual(questionId, ASK_USER_QUESTION_ID);
          const result = yield* items.answer({
            cardId: question!.id,
            requestId: "client-1",
            answer: { answers: { [questionId!]: "Yes" } },
          });
          // The card resolves from the request, not from the dispatch.
          assert.deepStrictEqual(result, { cardId: question!.id, status: "open", error: null });
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          assert.include(yield* projections.getRuntimeRequest(asking, requestId), {
            status: "resolved",
          });
          assert.strictEqual((yield* awaitRunEnd).status, "completed");
          yield* settle;
          const resolved = Option.getOrThrow(yield* repository.getCard(question!.id));
          assert.include(resolved, { status: "resolved", resolution: "answered" });

          const again = yield* items.answer({
            cardId: question!.id,
            requestId: "client-2",
            answer: { answers: { [ASK_USER_QUESTION_ID]: "No" } },
          });
          assert.strictEqual(again.error?.code, "outdated");
        }).pipe(Effect.scoped, Effect.provide(phase4Layer(baseDir)), Effect.orDie);
      }).pipe(Effect.scoped),
  );
});
