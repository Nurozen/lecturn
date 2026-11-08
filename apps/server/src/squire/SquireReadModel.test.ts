import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SquireCardId,
  SquireId,
  SquireSnapshot,
  SquireSubscribeEvent,
  SquireTriggerId,
  ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SquireContainers from "./SquireContainers.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import * as SquireReadModel from "./SquireReadModel.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRules from "./SquireRules.ts";
import * as SquireScope from "./SquireScope.ts";
import { createThread, grantRow, orchestratorLayer, squireRow } from "./testkit/scopeHarness.ts";

const nowIso = "2026-11-01T12:00:00.000Z";
const nowMs = Date.parse(nowIso);
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(nowMs + offsetMs));

type KnownEvent = Extract<SquireSubscribeEvent, { readonly type: string }>;
const isKnown = (event: SquireSubscribeEvent): event is KnownEvent => "type" in event;
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(SquireSubscribeEvent));
const encodeData = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const release = SquireId.make("squire:release");
const billing = SquireId.make("squire:billing");
const lead = SquireId.make("squire:lead");
const projectA = ProjectId.make("project:a");
const threadA = ThreadId.make("thread:a");

const withReadModel = <A, E, R, RO = never>(
  effect: Effect.Effect<A, E, R>,
  extra: Layer.Layer<RO> = Layer.empty as Layer.Layer<never> as Layer.Layer<RO>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    return yield* effect;
  }).pipe(
    Effect.scoped,
    Effect.provide(
      SquireReadModel.layer.pipe(
        Layer.provideMerge(extra),
        Layer.provideMerge(SquireScope.layer),
        Layer.provideMerge(SquireRepository.layer),
        Layer.provideMerge(SquireContainers.layerTest({ spaces: [], unknownProjectIds: [] })),
        Layer.provideMerge(SquireContainers.layerFixtureStave),
        // The orchestrator's own event store, so the read model follows its commits.
        Layer.provideMerge(RuntimeLayer.layerEventInfrastructure),
        Layer.provideMerge(orchestratorLayer),
      ),
    ),
  );

const squire = (id: SquireId, overrides: Partial<SquireRepository.SquireRow> = {}) =>
  squireRow(id, { name: id.slice("squire:".length), model_selection_json: null, ...overrides });

let cardSeq = 0;
const card = (
  overrides: Partial<SquireRepository.SquireCardRow> = {},
): SquireRepository.SquireCardRow => {
  cardSeq += 1;
  return {
    id: SquireCardId.make(`card-${cardSeq}`),
    squire_id: release,
    owner_squire_id: release,
    kind: "steer",
    status: "open",
    target_thread_id: ThreadId.make(`thread:card-${cardSeq}`),
    project_id: null,
    title: "Rerun the tests",
    why: "CI failed",
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
    expires_at: null,
    attempt: 0,
    command_id: null,
    execution_key: null,
    dedupe_key: null,
    replaced_count: 0,
    ask_json: null,
    resolution: null,
    created_at: at(cardSeq),
    updated_at: at(cardSeq),
    ...overrides,
  };
};

const logRow = (
  overrides: Partial<Omit<SquireRepository.SquireActionLogRow, "id">> = {},
): Omit<SquireRepository.SquireActionLogRow, "id"> => ({
  squire_id: release,
  kind: "tool.called",
  room_id: null,
  post_id: null,
  trigger_id: null,
  task_id: null,
  thread_id: null,
  card_id: null,
  event_id: null,
  run_id: null,
  invocation_key: null,
  execution_key: null,
  data_json: "{}",
  created_at: nowIso,
  ...overrides,
});

const encodeSnapshot = Schema.encodeEffect(SquireSnapshot);
const repo = SquireRepository.SquireRepository;
const readModel = SquireReadModel.SquireReadModel;

const seedSquires = (...rows: ReadonlyArray<SquireRepository.SquireRow>) =>
  Effect.gen(function* () {
    const repository = yield* repo;
    for (const row of rows) yield* repository.createSquire(row);
  });

const snapshot = Effect.gen(function* () {
  const model = yield* readModel;
  const [first] = yield* model.subscribe.pipe(
    Stream.filter(isKnown),
    Stream.take(1),
    Stream.runCollect,
  );
  assert.strictEqual(first?.type, "snapshot");
  return (first as Extract<KnownEvent, { type: "snapshot" }>).snapshot;
});

const entryOf = (id: SquireId) =>
  snapshot.pipe(
    Effect.map((env) => {
      const entry = env.squires.find((candidate) => candidate.squire.id === id);
      assert.isDefined(entry);
      return entry as SquireSnapshot;
    }),
  );

const revisionsOf = (id: SquireId) =>
  entryOf(id).pipe(
    Effect.map((entry) => ({ items: entry.itemsRevision, decision: entry.decisionRevision })),
  );

describe("SquireReadModel", () => {
  it.effect(
    "lastMessageAt is the newest reply a quiet run did not write, refreshed when a home run ends",
    () =>
      withReadModel(
        Effect.gen(function* () {
          const repository = yield* repo;
          const sink = yield* EventSink.EventSinkV2;
          const homeThread = ThreadId.make("thread:home");
          yield* seedSquires(squire(release, { home_thread_id: homeThread }));
          yield* withSquireDispatchOrigin(createThread(homeThread, projectA, release));
          const reply = (id: string, runId: string, ms: number) => {
            const stamp = DateTime.makeUnsafe(nowMs + ms);
            return {
              id: EventId.make(`event:${id}`),
              type: "message.updated" as const,
              threadId: homeThread,
              runId: RunId.make(runId),
              occurredAt: stamp,
              payload: {
                createdBy: "agent" as const,
                creationSource: "server" as const,
                id: MessageId.make(id),
                threadId: homeThread,
                runId: RunId.make(runId),
                nodeId: null,
                role: "assistant" as const,
                text: "Done.",
                attachments: [],
                streaming: false,
                createdAt: stamp,
                updatedAt: stamp,
              },
            };
          };
          yield* sink.write({ events: [reply("m:spoke", "run:spoke", 1_000)] });
          // One batch notified and stayed quiet on another thread: it spoke.
          yield* repository.insertActionLog(
            logRow({ kind: "quiet.recorded", run_id: "run:spoke" }),
          );
          yield* repository.insertActionLog(
            logRow({
              kind: "tool.called",
              run_id: "run:spoke",
              data_json: '{"tool":"squire_notify"}',
            }),
          );
          yield* sink.write({ events: [reply("m:quiet", "run:quiet", 2_000)] });
          yield* repository.insertActionLog(
            logRow({ kind: "quiet.recorded", run_id: "run:quiet" }),
          );
          assert.strictEqual((yield* entryOf(release)).lastMessageAt, at(1_000));

          // The user steers this later run, so its stay-quiet cannot hide the reply.
          yield* repository.insertActionLog(logRow({ kind: "quiet.recorded", run_id: "run:new" }));
          const model = yield* readModel;
          const events = yield* Queue.unbounded<KnownEvent>();
          yield* model.subscribe.pipe(
            Stream.filter(isKnown),
            Stream.runForEach((event) => Queue.offer(events, event)),
            Effect.forkScoped,
          );
          assert.strictEqual((yield* Queue.take(events)).type, "snapshot");
          yield* sink.write({ events: [reply("m:new", "run:new", 3_000)] });
          yield* sink.write({
            events: [
              {
                ...reply("m:steer", "run:new", 2_900),
                payload: {
                  ...reply("m:steer", "run:new", 2_900).payload,
                  createdBy: "user" as const,
                  creationSource: "web" as const,
                  role: "user" as const,
                },
              },
            ],
          });
          yield* sink.write({
            events: [
              {
                id: EventId.make("event:home-run-ended"),
                type: "run.updated",
                threadId: homeThread,
                runId: RunId.make("run:new"),
                occurredAt: DateTime.makeUnsafe(nowMs + 3_000),
                payload: {
                  id: RunId.make("run:new"),
                  threadId: homeThread,
                  ordinal: 1,
                  providerInstanceId: ProviderInstanceId.make("codex-work"),
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex-work"),
                    model: "gpt-5.4",
                  },
                  providerThreadId: null,
                  userMessageId: MessageId.make("message:run:new"),
                  rootNodeId: null,
                  activeAttemptId: null,
                  status: "completed",
                  requestedAt: DateTime.makeUnsafe(nowMs),
                  startedAt: DateTime.makeUnsafe(nowMs),
                  completedAt: DateTime.makeUnsafe(nowMs),
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
            ],
          });
          const update = yield* Queue.take(events);
          assert.strictEqual(update.type, "squire");
          if (update.type !== "squire") return;
          assert.strictEqual(update.entry.lastMessageAt, at(3_000));
        }),
      ),
  );

  it.effect("offers Always allow only where a row can still act on it", () => {
    const offer = {
      effect: "allow",
      actionClass: "steer",
      targetKind: "thread",
      targetId: "thread:a",
      text: "Always allow",
      capReached: false,
    } as const;
    return withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        const model = yield* readModel;
        yield* seedSquires(squire(release));
        const open = card();
        const expired = card({ status: "outdated", resolution: "expired" });
        const denied = card({ status: "dismissed", resolution: "denied" });
        for (const row of [open, expired, denied]) yield* repository.insertCard(row);
        const { items } = yield* model.itemsList({ squireId: release, scope: "all" });
        const offerOf = (id: SquireCardId) =>
          items.find((item) => item.id === id)?.allowRuleOffer?.text;
        assert.strictEqual(offerOf(open.id), offer.text);
        assert.strictEqual(offerOf(expired.id), offer.text);
        assert.isUndefined(offerOf(denied.id));
      }),
      Layer.mock(SquireRules.SquireRules)({ offerFor: () => Effect.succeedSome(offer) }),
    );
  });

  it.effect("carries open rooms and rooms closed in the last week, not older ones", () =>
    withReadModel(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const room = (id: string, status: "open" | "closed", updatedAt: string) =>
          sql`INSERT INTO squire_room ${sql.insert({
            id,
            topic: id,
            about_json: "[]",
            status,
            bot_messaging: "on",
            idle_ttl_seconds: 3600,
            creator_kind: "user",
            last_post_at: updatedAt,
            created_at: at(-30 * DAY_MS),
            updated_at: updatedAt,
          })}`;
        yield* room("room:open-quiet", "open", at(-30 * DAY_MS));
        yield* room("room:closed-yesterday", "closed", at(-DAY_MS));
        yield* room("room:closed-eight-days-ago", "closed", at(-8 * DAY_MS));
        const env = yield* snapshot;
        assert.deepStrictEqual(env.rooms.map((row) => row.id).toSorted(), [
          "room:closed-yesterday",
          "room:open-quiet",
        ]);
      }),
    ),
  );

  it.effect("reports a compact snapshot per Squire", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        yield* seedSquires(squire(release, { brief: "Keep billing green. ".repeat(190) }));
        yield* repository.insertGrant(grantRow(release, "project", projectA));
        yield* createThread(threadA, projectA);
        yield* repository.insertCard(card({ kind: "steer" }));
        yield* repository.insertCard(card({ kind: "question" }));
        yield* repository.insertCard(card({ kind: "fyi" }));
        yield* repository.insertCard(card({ kind: "steer", status: "dismissed" }));
        yield* repository.insertCard(
          card({
            kind: "steer",
            status: "held",
            executes_at: at(7_000),
            target_thread_id: threadA,
          }),
        );
        yield* repository.insertBudgetUsage({
          squire_id: release,
          thread_id: threadA,
          kind: "steer",
          room_id: null,
          executed_at: at(-60_000),
          execution_key: "exec-1",
        });

        const env = yield* snapshot;
        assert.isNull(env.lead);
        assert.deepStrictEqual(env.rooms, []);
        const entry = yield* entryOf(release);
        assert.strictEqual(entry.squire.name, "release");
        // The brief is fetched on demand, so a 4 KB brief adds nothing to the stream.
        assert.notProperty(entry.squire, "brief");
        const wire = JSON.stringify(yield* encodeSnapshot(entry));
        assert.isBelow(wire.length, 1_600);
        // Open decision items only: the FYI, the hold, and the dismissed card are not counted.
        assert.strictEqual(entry.openDecisionCount, 2);
        assert.deepStrictEqual(entry.countsByKind, {
          steer: 2,
          question: 1,
          overlap: 0,
          proposal: 0,
          fyi: 1,
        });
        assert.strictEqual(entry.held.length, 1);
        assert.strictEqual(entry.held[0]?.executesInMs, 7_000);
        assert.strictEqual(entry.held[0]?.targetThreadId, threadA);
        assert.strictEqual(entry.budget.steersLeft, entry.squire.budgets.steersPerDay - 1);
        assert.strictEqual(entry.budget.threadsLeft, entry.squire.budgets.threadsPerDay);
        assert.isUndefined(entry.budget.recommendingUntil);
        assert.strictEqual(entry.trackedCount, 1);
        // The harness has no project shell, so the id must not leak as a name.
        assert.deepStrictEqual(entry.containerNames, ["Removed project"]);
        assert.deepStrictEqual(entry.conflicts, []);
      }),
    ),
  );

  it.effect("counts held time down from executes_at", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        yield* seedSquires(squire(release));
        yield* repository.insertCard(card({ status: "held", executes_at: at(10_000) }));
        assert.strictEqual((yield* entryOf(release)).held[0]?.executesInMs, 10_000);
        yield* TestClock.adjust("4 seconds");
        assert.strictEqual((yield* entryOf(release)).held[0]?.executesInMs, 6_000);
        yield* TestClock.adjust("1 minute");
        assert.strictEqual((yield* entryOf(release)).held[0]?.executesInMs, 0);
      }),
    ),
  );

  it.effect("pairs a hold with the open card of the same raiser, thread, and kind", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        yield* seedSquires(squire(release), squire(billing));
        const open = card({ target_thread_id: threadA });
        yield* repository.insertCard(open);
        // Another kind and another raiser on the same thread never pair.
        yield* repository.insertCard(card({ kind: "question", target_thread_id: threadA }));
        yield* repository.insertCard(
          card({ squire_id: billing, owner_squire_id: billing, target_thread_id: threadA }),
        );
        const hold = card({ status: "held", executes_at: at(5_000), target_thread_id: threadA });
        yield* repository.insertCard(hold);
        const loneHold = card({ status: "held", executes_at: at(5_000) });
        yield* repository.insertCard(loneHold);

        const held = (yield* entryOf(release)).held;
        assert.strictEqual(held.find((entry) => entry.cardId === hold.id)?.heldOverCardId, open.id);
        assert.notProperty(
          held.find((entry) => entry.cardId === loneHold.id),
          "heldOverCardId",
        );
        assert.isUndefined(
          (yield* entryOf(billing)).held.find((entry) => entry.cardId === hold.id),
        );

        // The pairing follows the open card: once it settles, the hold stands alone.
        yield* repository.updateCard({
          id: open.id,
          fromStatuses: ["open"],
          patch: { status: "dismissed" },
          updatedAt: at(1_000),
        });
        const after = (yield* entryOf(release)).held.find((entry) => entry.cardId === hold.id);
        assert.isDefined(after);
        assert.notProperty(after, "heldOverCardId");
      }),
    ),
  );

  it.effect("bumps itemsRevision for FYI writes and both revisions for decisions, per Squire", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        yield* seedSquires(squire(release), squire(billing));
        const releaseStart = yield* revisionsOf(release);
        const billingStart = yield* revisionsOf(billing);

        yield* repository.insertCard(card({ kind: "fyi" }));
        const afterFyi = yield* revisionsOf(release);
        assert.notStrictEqual(afterFyi.items, releaseStart.items);
        assert.strictEqual(afterFyi.decision, releaseStart.decision);

        const decision = card({ kind: "steer" });
        yield* repository.insertCard(decision);
        const afterDecision = yield* revisionsOf(release);
        assert.notStrictEqual(afterDecision.items, afterFyi.items);
        assert.notStrictEqual(afterDecision.decision, afterFyi.decision);

        yield* repository.updateCard({
          id: decision.id,
          fromStatuses: ["open"],
          patch: { status: "dismissed" },
          updatedAt: at(1_000),
        });
        const afterDismiss = yield* revisionsOf(release);
        assert.notStrictEqual(afterDismiss.decision, afterDecision.decision);

        // Unrelated reads and writes leave revisions alone.
        yield* repository.insertActionLog(logRow());
        assert.deepStrictEqual(yield* revisionsOf(release), afterDismiss);
        assert.deepStrictEqual(yield* revisionsOf(billing), billingStart);
      }),
    ),
  );

  it.effect(
    "a Squire's badge counts its view's Needs a decision group, Lead-raised items included",
    () =>
      withReadModel(
        Effect.gen(function* () {
          const repository = yield* repo;
          const model = yield* readModel;
          yield* seedSquires(squire(release), squire(lead, { role: "lead" }));
          yield* repository.insertCard(card());
          yield* repository.insertCard(card({ status: "accepting" }));
          yield* repository.insertCard(card({ status: "held", executes_at: at(5_000) }));
          const leadOverlap = card({ squire_id: lead, owner_squire_id: release, kind: "overlap" });
          yield* repository.insertCard(leadOverlap);
          yield* repository.insertCard(
            card({
              squire_id: lead,
              owner_squire_id: release,
              status: "held",
              executes_at: at(5_000),
            }),
          );

          // What the view's header counts from the same rows the view lists.
          const listed = yield* model.itemsList({ squireId: release, scope: "open" });
          const decisions = listed.items.filter(
            (item) => item.kind !== "fyi" && item.status !== "held",
          );
          const releaseEntry = yield* entryOf(release);
          assert.strictEqual(
            releaseEntry.openDecisionCount,
            decisions.filter((item) => item.squireId === release).length,
          );
          assert.strictEqual(releaseEntry.openDecisionCount, 2);
          assert.notProperty(releaseEntry, "leadRaisedDecisionCount");
          // An approval counts only where it renders; the Lead-raised hold sits in the Lead's chat.
          assert.strictEqual(releaseEntry.held.length, 1);

          // The Lead's badge keeps only what the Lead raised, holds apart.
          const leadEntry = yield* entryOf(lead);
          assert.strictEqual(leadEntry.openDecisionCount, 1);
          assert.strictEqual(leadEntry.held.length, 1);

          // Settling the Lead's item on Release's thread refreshes Release's badge.
          const before = yield* revisionsOf(release);
          yield* repository.updateCard({
            id: leadOverlap.id,
            fromStatuses: ["open"],
            patch: { status: "dismissed" },
            updatedAt: at(2_000),
          });
          const after = yield* entryOf(release);
          assert.notStrictEqual(after.decisionRevision, before.decision);
          assert.strictEqual(after.openDecisionCount, 2);
        }),
      ),
  );

  it.effect("lists the last 8 activity rows oldest first, with their gestures", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        yield* seedSquires(squire(release));
        const ids: Array<number> = [];
        for (let index = 0; index < 10; index++) {
          ids.push(yield* repository.insertActionLog(logRow({ created_at: at(index) })));
        }
        ids.push(
          yield* repository.insertActionLog(
            logRow({
              kind: "event.received",
              data_json: '{"batchId":"b1","kind":"turn-finished"}',
            }),
          ),
          yield* repository.insertActionLog(
            logRow({
              kind: "event.received",
              data_json: '{"batchId":"b1","kind":"turn-finished"}',
            }),
          ),
          yield* repository.insertActionLog(logRow({ kind: "action.held" })),
        );
        const entry = yield* entryOf(release);
        assert.deepStrictEqual(
          entry.recentActivity.map((activity) => activity.sequence),
          ids.slice(-8),
        );
        assert.deepStrictEqual(
          entry.recentActivity.slice(-3).map((activity) => activity.gesture),
          ["ponder", undefined, "glance"],
        );
      }),
    ),
  );

  it("maps log rows to gestures", () => {
    const gesture = SquireReadModel.squireActivityGesture;
    const row = (kind: string, data: Record<string, unknown> = {}) => ({
      kind,
      data_json: encodeData(data),
    });
    assert.strictEqual(
      gesture(row("event.received", { batchId: "b", kind: "voice-note" })),
      "listen",
    );
    assert.strictEqual(
      gesture(row("event.received", { batchId: "b", kind: "pr-merged" })),
      "ponder",
    );
    assert.isUndefined(
      gesture(
        row("event.received", { batchId: "b", kind: "pr-merged" }),
        row("event.received", { batchId: "b", kind: "turn-finished" }),
      ),
    );
    assert.strictEqual(
      gesture(row("event.received", { batchId: "c" }), row("event.received", { batchId: "b" })),
      "ponder",
    );
    assert.strictEqual(gesture(row("action.held")), "glance");
    assert.strictEqual(gesture(row("action.executed", { action: "steer", verb: "accept" })), "nod");
    assert.isUndefined(gesture(row("action.executed", { action: "steer", verb: "execute" })));
    assert.strictEqual(
      gesture(row("action.executed", { action: "create_thread", verb: "execute" })),
      "flourish",
    );
    assert.strictEqual(gesture(row("action.executed", { action: "create_squire" })), "flourish");
    assert.isUndefined(gesture(row("tool.called")));
  });

  it.effect("names every container, never by its id", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        const fixtureStave = yield* SquireContainers.SquireFixtureStave;
        yield* seedSquires(squire(release));
        yield* repository.insertGrant(grantRow(release, "staveSaga", "fixture-saga:v2-5-release"));
        yield* repository.insertGrant(grantRow(release, "staveSpace", "space:unnamed"));
        yield* fixtureStave.setName("fixture-saga:v2-5-release", "v2.5 release");
        const entry = yield* entryOf(release);
        assert.deepStrictEqual(entry.containerNames, ["v2.5 release", "Stave space"]);
      }),
    ),
  );

  it.effect("counts a thread created in a granted project without any Squire write", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        const model = yield* readModel;
        yield* seedSquires(squire(release));
        yield* repository.insertGrant(grantRow(release, "project", projectA));
        const events = yield* Queue.unbounded<KnownEvent>();
        yield* model.subscribe.pipe(
          Stream.filter(isKnown),
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const first = yield* Queue.take(events);
        assert.strictEqual(first.type, "snapshot");
        if (first.type !== "snapshot") return;
        assert.strictEqual(first.snapshot.squires[0]?.trackedCount, 0);

        yield* createThread(threadA, projectA);
        const update = yield* Queue.take(events);
        assert.strictEqual(update.type, "squire");
        if (update.type !== "squire") return;
        assert.strictEqual(update.entry.trackedCount, 1);
      }),
    ),
  );

  it.effect("streams the snapshot, then only the Squires that changed", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        const model = yield* readModel;
        yield* seedSquires(squire(release), squire(billing));
        const events = yield* Queue.unbounded<KnownEvent>();
        yield* model.subscribe.pipe(
          Stream.filter(isKnown),
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );

        const first = yield* Queue.take(events);
        assert.strictEqual(first.type, "snapshot");
        if (first.type !== "snapshot") return;
        assert.strictEqual(first.snapshot.squires.length, 2);
        const before = first.snapshot.squires.find((entry) => entry.squire.id === release);

        yield* repository.insertCard(
          card({ kind: "steer", evidence_json: '{"marker":"EVIDENCE-SECRET"}', why: "WHY-BODY" }),
        );
        const update = yield* Queue.take(events);
        assert.strictEqual(update.type, "squire");
        if (update.type !== "squire") return;
        assert.strictEqual(update.entry.squire.id, release);
        assert.strictEqual(update.entry.openDecisionCount, 1);
        assert.notStrictEqual(update.entry.decisionRevision, before?.decisionRevision);

        // Card bodies and evidence never ride the stream.
        for (const event of [first, update]) {
          const text = yield* encodeEvent(event);
          assert.notInclude(text, "EVIDENCE-SECRET");
          assert.notInclude(text, "WHY-BODY");
        }

        yield* repository.deleteSquireRows(billing);
        const removed = yield* Queue.take(events);
        assert.deepStrictEqual(removed, { type: "squire-removed", squireId: billing });
      }),
    ),
  );

  it.effect("reports no Lead until one exists, then announces it", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        const model = yield* readModel;
        yield* seedSquires(squire(release));
        const events = yield* Queue.unbounded<KnownEvent>();
        yield* model.subscribe.pipe(
          Stream.filter(isKnown),
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const first = yield* Queue.take(events);
        assert.isTrue(first.type === "snapshot" && first.snapshot.lead === null);

        yield* repository.createSquire(squire(lead, { role: "lead" }));
        const entry = yield* Queue.take(events);
        assert.isTrue(entry.type === "squire" && entry.entry.squire.id === lead);
        assert.deepStrictEqual(yield* Queue.take(events), { type: "lead", lead });
      }),
    ),
  );

  it.effect("a thread proposal's row names who would run the new thread", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        const model = yield* readModel;
        yield* seedSquires(squire(release));
        yield* repository.insertCard(
          card({
            kind: "proposal",
            target_thread_id: null,
            payload_json: JSON.stringify({
              type: "thread-proposal",
              projectId: "project-billing",
              provider: "codex",
              providerInstanceId: "codex-work",
              model: null,
              firstPrompt: "Add a CHANGELOG entry",
            }),
          }),
        );
        yield* repository.insertCard(card());
        const { items } = yield* model.itemsList({ squireId: release, scope: "open" });
        assert.deepStrictEqual(
          items.map((item) => item.proposalProvider),
          [
            undefined,
            {
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: ProviderInstanceId.make("codex-work"),
            },
          ],
        );
      }),
    ),
  );

  it.effect("pages a Squire's items and gives the Lead the combined queue", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        const model = yield* readModel;
        yield* seedSquires(squire(release), squire(billing), squire(lead, { role: "lead" }));
        const releaseCards = [
          card(),
          card({ kind: "fyi", payload_json: '{"type":"fyi","source":"inactivity"}' }),
          card(),
          card({ status: "dismissed" }),
        ];
        for (const row of releaseCards) yield* repository.insertCard(row);
        const billingCard = card({ squire_id: billing, owner_squire_id: billing });
        const leadOnRelease = card({ squire_id: lead, owner_squire_id: release, kind: "overlap" });
        yield* repository.insertCard(billingCard);
        yield* repository.insertCard(leadOnRelease);

        const page1 = yield* model.itemsList({ squireId: release, scope: "open", limit: 2 });
        assert.deepStrictEqual(
          page1.items.map((item) => item.id),
          [leadOnRelease.id, releaseCards[2]!.id],
        );
        assert.isNotNull(page1.nextBefore);
        const page2 = yield* model.itemsList({
          squireId: release,
          scope: "open",
          limit: 2,
          before: page1.nextBefore!,
        });
        assert.deepStrictEqual(
          page2.items.map((item) => item.id),
          [releaseCards[1]!.id, releaseCards[0]!.id],
        );
        assert.isNull(page2.nextBefore);
        // An FYI row names its source, so clients never key actions off its title.
        assert.strictEqual(page2.items[0]?.fyiSource, "inactivity");
        assert.notProperty(page2.items[1], "fyiSource");
        assert.strictEqual(page1.itemsRevision, (yield* revisionsOf(release)).items);

        const all = yield* model.itemsList({ squireId: release, scope: "all" });
        assert.strictEqual(all.items.length, 5);
        const fyi = yield* model.itemsList({ squireId: release, scope: "open", kinds: ["fyi"] });
        assert.deepStrictEqual(
          fyi.items.map((item) => item.id),
          [releaseCards[1]!.id],
        );

        const combined = yield* model.itemsList({ squireId: lead, scope: "open" });
        assert.sameMembers(
          combined.items.map((item) => item.id),
          [
            releaseCards[0]!.id,
            releaseCards[1]!.id,
            releaseCards[2]!.id,
            billingCard.id,
            leadOnRelease.id,
          ],
        );

        // An approval counts only in the chat it renders in, the raiser's, so a team total
        // needs no correction. The Lead's overlap still appears in Release's list.
        assert.strictEqual((yield* entryOf(lead)).openDecisionCount, 1);
        const releaseEntry = yield* entryOf(release);
        assert.strictEqual(releaseEntry.openDecisionCount, 2);
        assert.notProperty(releaseEntry, "leadRaisedDecisionCount");
        assert.strictEqual(releaseEntry.countsByKind.overlap, 1);

        const missing = yield* model
          .itemsList({ squireId: SquireId.make("squire:gone"), scope: "open" })
          .pipe(Effect.flip);
        assert.strictEqual(missing.code, "not_found");
      }),
    ),
  );

  it.effect("pages the action log back by id", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        const model = yield* readModel;
        yield* seedSquires(squire(release));
        const ids: Array<number> = [];
        for (let index = 0; index < 5; index++) {
          ids.push(yield* repository.insertActionLog(logRow({ data_json: `{"n":${index}}` })));
        }
        const page1 = yield* model.actionLogList({ squireId: release, limit: 3 });
        assert.deepStrictEqual(
          page1.entries.map((entry) => entry.id),
          ids.toReversed().slice(0, 3),
        );
        assert.deepStrictEqual(page1.entries[0]?.data, { n: 4 });
        const page2 = yield* model.actionLogList({
          squireId: release,
          limit: 3,
          before: page1.nextBefore!,
        });
        assert.deepStrictEqual(
          page2.entries.map((entry) => entry.id),
          ids.toReversed().slice(3),
        );
        assert.isNull(page2.nextBefore);
      }),
    ),
  );

  it.effect("lists trigger runs from the trigger log rows", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        const model = yield* readModel;
        yield* seedSquires(squire(release));
        const triggerId = SquireTriggerId.make("trigger-1");
        yield* repository.insertTrigger({
          id: triggerId,
          squire_id: release,
          name: "Nightly",
          kind: "schedule",
          instruction: "Check the release",
          status: "active",
          schedule_json: null,
          next_slot_at: null,
          secret_ref: null,
          secret_generation: 0,
          last_payload_excerpt: null,
          created_at: nowIso,
        });
        const eventId = yield* repository.insertTriggerEvent({
          squire_id: release,
          thread_id: null,
          kind: "schedule-due",
          state_key: "trigger-1:slot",
          payload_json: null,
          status: "pending",
          defer_reason: null,
          not_before: nowIso,
          batch_id: null,
          created_at: nowIso,
        });
        yield* repository.insertActionLog(
          logRow({
            kind: "trigger.received",
            trigger_id: triggerId,
            event_id: eventId._tag === "Some" ? eventId.value : null,
            data_json: '{"origin":"schedule"}',
          }),
        );
        yield* repository.insertActionLog(
          logRow({
            kind: "trigger.rate-limited",
            trigger_id: triggerId,
            data_json: '{"origin":"test","limit":"hour","until":"2026-11-01T13:00:00.000Z"}',
            created_at: at(1),
          }),
        );
        const { runs } = yield* model.triggerRuns({ triggerId });
        assert.deepStrictEqual(runs, [
          { at: at(1), origin: "test", outcome: "rate-limited", itemCount: 0 },
          { at: nowIso, origin: "event", outcome: "pending", itemCount: 0 },
        ]);
        const missing = yield* model
          .triggerRuns({ triggerId: SquireTriggerId.make("trigger-gone") })
          .pipe(Effect.flip);
        assert.strictEqual(missing.code, "not_found");
      }),
    ),
  );

  it.effect("returns no summary for a thread without one, and builds the vocabulary", () =>
    withReadModel(
      Effect.gen(function* () {
        const repository = yield* repo;
        const model = yield* readModel;
        yield* seedSquires(squire(release), squire(billing, { name: "Release" }));
        yield* repository.insertGrant(grantRow(release, "thread", threadA));
        yield* createThread(threadA, projectA);
        assert.deepStrictEqual(yield* model.summaryGet({ threadId: threadA }), { summary: null });
        const { terms } = yield* model.vocabulary;
        // Case-insensitive dedupe keeps the first spelling.
        assert.deepStrictEqual(terms, ["release", "Thread"]);
      }),
    ),
  );
});
