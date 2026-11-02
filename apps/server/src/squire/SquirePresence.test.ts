import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  type ClientActivityReportInput,
  type HostPowerSnapshot,
  RpcClientId,
  SquireCardId,
  SquireId,
  type SquirePhoneAlertsWhileDesktop,
  ThreadId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SquireClock from "./SquireClock.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquirePresence from "./SquirePresence.ts";
import * as SquireReactor from "./SquireReactor.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireTriggers from "./SquireTriggers.ts";
import * as SquireWorkspace from "./SquireWorkspace.ts";
import { squireRow } from "./testkit/scopeHarness.ts";

const release = SquireId.make("squire:release");
const thread = ThreadId.make("thread-1");
const START = Date.parse("2026-11-02T08:00:00.000Z");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const hostPower: HostPowerSnapshot = {
  source: "unknown",
  idle: "unknown",
  idleSeconds: null,
  locked: "unknown",
  suspended: false,
  onBattery: "unknown",
  lowPowerMode: "unknown",
  thermalState: "unknown",
  stale: true,
  updatedAt: DateTime.makeUnsafe(START),
};

const layerHost = Layer.succeed(
  HostPowerMonitor.HostPowerMonitor,
  HostPowerMonitor.HostPowerMonitor.of({
    snapshot: Effect.succeed(hostPower),
    report: () => Effect.void,
    streamChanges: Stream.never,
  }),
);

/** A fresh BackgroundPolicy and SquirePresence: what a server start builds. */
const layerPresenceOnly = SquirePresence.layer.pipe(
  Layer.provideMerge(BackgroundPolicy.layer.pipe(Layer.provide(layerHost))),
);

const layerStorage = (phoneAlerts: SquirePhoneAlertsWhileDesktop) =>
  Layer.mergeAll(
    SquireRepository.layer,
    ServerSettings.layerTest({ squire: { phoneAlertsWhileDesktop: phoneAlerts } }),
  ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory), Layer.provideMerge(NodeServices.layer));

const layerFor = (phoneAlerts: SquirePhoneAlertsWhileDesktop = "after-3-min") =>
  layerPresenceOnly.pipe(Layer.provideMerge(layerStorage(phoneAlerts)));

const report = (overrides: Partial<ClientActivityReportInput> = {}): ClientActivityReportInput => ({
  clientId: "client-1",
  clientKind: "desktop-renderer",
  visible: true,
  focused: true,
  recentlyInteracted: true,
  scopes: [],
  ttlMs: 45_000,
  observedAt: DateTime.makeUnsafe(START),
  ...overrides,
});

const heartbeat = (overrides: Partial<ClientActivityReportInput> = {}) =>
  Effect.gen(function* () {
    const policy = yield* BackgroundPolicy.BackgroundPolicy;
    yield* policy.reportClientActivity(
      AuthSessionId.make("session-1"),
      RpcClientId.make(1),
      report(overrides),
    );
  });

/** Lets the subscription fiber record the latest snapshot. */
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
  discard: true,
});

const cardRow = (
  id: string,
  kind: SquireRepository.SquireCardRow["kind"],
  createdAt: number,
): SquireRepository.SquireCardRow => ({
  id: SquireCardId.make(id),
  squire_id: release,
  owner_squire_id: release,
  kind,
  status: "open",
  target_thread_id: thread,
  project_id: null,
  title: id,
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
  created_at: iso(createdAt),
  updated_at: iso(createdAt),
});

/** Writes a card and offers its intent to presence, as `SquireTools.writeCard` does. */
const raise = (id: string, kind: SquireRepository.SquireCardRow["kind"] = "steer") =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const presence = yield* SquirePresence.SquirePresence;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const card = cardRow(id, kind, now);
    yield* repository.insertCard(card);
    const heldBack = yield* presence.holdIntent({
      squireId: release,
      cardId: card.id,
      kind,
      threadId: thread,
      runId: "run-1",
      now: card.created_at,
    });
    return { cardId: card.id, heldBack };
  });

const deliveries = (cardId: SquireCardId) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const rows = yield* repository.listActionLog({
      squireId: release,
      kinds: ["notification.delivery"],
      limit: 100,
    });
    return rows
      .filter((row) => row.card_id === cardId)
      .map((row) => (JSON.parse(row.data_json) as { outcome: string }).outcome);
  });

const card = (cardId: SquireCardId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    Effect.map(repository.getCard(cardId), Option.getOrThrow),
  );

const setup = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  yield* repository.createSquire(squireRow(release));
});

/**
 * The clock moves to START before the layer is built: jumping there afterwards
 * would replay every 15 s lease sweep since the epoch.
 */
const atStart =
  (phoneAlerts: SquirePhoneAlertsWhileDesktop = "after-3-min") =>
  <A, E, R>(body: Effect.Effect<A, E, R>) =>
    TestClock.setTime(START).pipe(
      Effect.andThen(body.pipe(Effect.provide(layerFor(phoneAlerts)))),
      Effect.scoped,
    );

describe("SquirePresence.desktopActive", () => {
  it.effect("never counts a mobile lease, however present it is", () =>
    Effect.gen(function* () {
      yield* setup;
      const presence = yield* SquirePresence.SquirePresence;
      yield* heartbeat({ clientKind: "mobile" });
      yield* settle;
      assert.isFalse(yield* presence.desktopActive);
      yield* heartbeat({ clientId: "desktop", clientKind: "web" });
      yield* settle;
      assert.isTrue(yield* presence.desktopActive);
    }).pipe(atStart()),
  );

  it.effect("counts a focused desktop for 2 min after its last interaction, not after", () =>
    Effect.gen(function* () {
      yield* setup;
      const presence = yield* SquirePresence.SquirePresence;
      yield* heartbeat();
      yield* settle;
      // Focused and visible, but the user stopped touching it: reports keep the lease alive.
      for (let elapsed = 25 * SECOND; elapsed < 2 * MINUTE; elapsed += 25 * SECOND) {
        yield* TestClock.adjust(25 * SECOND);
        yield* heartbeat({ recentlyInteracted: false });
        yield* settle;
        assert.isTrue(yield* presence.desktopActive, `active at ${elapsed / SECOND}s`);
      }
      yield* TestClock.adjust(25 * SECOND);
      yield* heartbeat({ recentlyInteracted: false });
      yield* settle;
      assert.isFalse(yield* presence.desktopActive);

      // An unfocused window never counts, even right after input.
      yield* heartbeat({ focused: false, recentlyInteracted: true });
      yield* settle;
      assert.isFalse(yield* presence.desktopActive);
    }).pipe(atStart()),
  );

  it.effect("stops counting when the lease expires without a report", () =>
    Effect.gen(function* () {
      yield* setup;
      const presence = yield* SquirePresence.SquirePresence;
      yield* heartbeat();
      yield* settle;
      yield* TestClock.adjust(45 * SECOND);
      assert.isFalse(yield* presence.desktopActive);
    }).pipe(atStart()),
  );
});

describe("SquirePresence escalation", () => {
  it.effect("with no active desktop an intent goes to the phone at once", () =>
    Effect.gen(function* () {
      yield* setup;
      const raised = yield* raise("card:a");
      assert.isFalse(raised.heldBack);
      assert.isNull((yield* card(raised.cardId)).escalate_at);
      assert.deepEqual(yield* deliveries(raised.cardId), []);
    }).pipe(atStart()),
  );

  it.effect("holds a decision back while a desktop is active, then escalates once at 3 min", () =>
    Effect.gen(function* () {
      yield* setup;
      const presence = yield* SquirePresence.SquirePresence;
      yield* heartbeat();
      yield* settle;
      const raised = yield* raise("card:a");
      assert.isTrue(raised.heldBack);
      const held = yield* card(raised.cardId);
      assert.equal(held.escalate_at, iso(START + 3 * MINUTE));
      assert.isTrue(SquirePresence.isHeldBackByPresence(held));
      assert.deepEqual(
        yield* presence.nextEscalationAt,
        Option.some(DateTime.makeUnsafe(START + 3 * MINUTE)),
      );

      // The desktop going quiet does not shorten the timer.
      yield* TestClock.adjust(2 * MINUTE + 59 * SECOND);
      assert.isFalse(yield* presence.desktopActive);
      yield* presence.escalateDue;
      assert.deepEqual(yield* deliveries(raised.cardId), ["deferred_desktop_active"]);

      yield* TestClock.adjust(SECOND);
      yield* presence.escalateDue;
      yield* presence.escalateDue;
      assert.deepEqual(yield* deliveries(raised.cardId), ["deferred_desktop_active", "escalated"]);
      assert.isFalse(SquirePresence.isHeldBackByPresence(yield* card(raised.cardId)));
      assert.isTrue(Option.isNone(yield* presence.nextEscalationAt));
    }).pipe(atStart()),
  );

  it.effect("escalates at 3 min even while the desktop is still in use", () =>
    Effect.gen(function* () {
      yield* setup;
      const presence = yield* SquirePresence.SquirePresence;
      yield* heartbeat();
      yield* settle;
      const raised = yield* raise("card:a", "proposal");
      yield* TestClock.adjust(3 * MINUTE);
      yield* heartbeat();
      yield* settle;
      assert.isTrue(yield* presence.desktopActive);
      yield* presence.escalateDue;
      assert.deepEqual(yield* deliveries(raised.cardId), ["deferred_desktop_active", "escalated"]);
    }).pipe(atStart()),
  );

  it.effect("opening before 3 min cancels the escalation, once per card", () =>
    Effect.gen(function* () {
      yield* setup;
      const presence = yield* SquirePresence.SquirePresence;
      yield* heartbeat();
      yield* settle;
      const raised = yield* raise("card:a");
      yield* TestClock.adjust(MINUTE);
      const input = { requestId: "open-1", cardIds: [raised.cardId] };
      yield* presence.markOpened(input);
      yield* presence.markOpened(input);
      // A Squire view opening names no cards.
      yield* presence.markOpened({ requestId: "open-2", cardIds: [] });
      assert.equal((yield* card(raised.cardId)).opened_at, iso(START + MINUTE));

      yield* TestClock.adjust(5 * MINUTE);
      yield* presence.escalateDue;
      assert.deepEqual(yield* deliveries(raised.cardId), [
        "deferred_desktop_active",
        "opened_before_escalation",
      ]);
      // Opened first, it never joins the phone's attention set.
      assert.isTrue(SquirePresence.isHeldBackByPresence(yield* card(raised.cardId)));
    }).pipe(atStart()),
  );

  it.effect("acting on a held card before 3 min cancels the escalation", () =>
    Effect.gen(function* () {
      yield* setup;
      const presence = yield* SquirePresence.SquirePresence;
      const repository = yield* SquireRepository.SquireRepository;
      yield* heartbeat();
      yield* settle;
      const raised = yield* raise("card:a");
      yield* TestClock.adjust(MINUTE);
      yield* repository.updateCard({
        id: raised.cardId,
        fromStatuses: ["open"],
        patch: { status: "dismissed" },
        updatedAt: iso(START + MINUTE),
      });
      yield* TestClock.adjust(2 * MINUTE);
      yield* presence.escalateDue;
      yield* presence.escalateDue;
      assert.deepEqual(yield* deliveries(raised.cardId), [
        "deferred_desktop_active",
        "opened_before_escalation",
      ]);
    }).pipe(atStart()),
  );

  it.effect("an FYI skips the phone while a desktop is active and never escalates", () =>
    Effect.gen(function* () {
      yield* setup;
      const presence = yield* SquirePresence.SquirePresence;
      yield* heartbeat();
      yield* settle;
      const raised = yield* raise("fyi:a", "fyi");
      assert.isTrue(raised.heldBack);
      assert.isTrue(Option.isNone(yield* presence.nextEscalationAt));
      yield* TestClock.adjust(30 * MINUTE);
      yield* presence.escalateDue;
      assert.deepEqual(yield* deliveries(raised.cardId), ["deferred_desktop_active"]);
      assert.isTrue(SquirePresence.isHeldBackByPresence(yield* card(raised.cardId)));
    }).pipe(atStart()),
  );

  it.effect("Immediately holds nothing back", () =>
    Effect.gen(function* () {
      yield* setup;
      yield* heartbeat();
      yield* settle;
      const decision = yield* raise("card:a");
      const fyi = yield* raise("fyi:a", "fyi");
      assert.isFalse(decision.heldBack);
      assert.isFalse(fyi.heldBack);
      assert.deepEqual(yield* deliveries(decision.cardId), []);
    }).pipe(atStart("immediately")),
  );

  it.effect("Never escalates a due, unopened decision only once no desktop is active", () =>
    Effect.gen(function* () {
      yield* setup;
      const presence = yield* SquirePresence.SquirePresence;
      yield* heartbeat();
      yield* settle;
      const raised = yield* raise("card:a");
      assert.isTrue(raised.heldBack);
      // The user keeps working at the desktop well past 3 min.
      for (let step = 0; step < 12; step += 1) {
        yield* TestClock.adjust(25 * SECOND);
        yield* heartbeat();
        yield* settle;
      }
      yield* presence.escalateDue;
      assert.deepEqual(yield* deliveries(raised.cardId), ["deferred_desktop_active"]);
      const now = START + 12 * 25 * SECOND;
      // The clock re-arms for when the desktop stops counting.
      assert.deepEqual(
        yield* presence.nextEscalationAt,
        Option.some(DateTime.makeUnsafe(now + 45 * SECOND)),
      );

      yield* TestClock.adjust(45 * SECOND);
      yield* presence.escalateDue;
      assert.deepEqual(yield* deliveries(raised.cardId), ["deferred_desktop_active", "escalated"]);
    }).pipe(atStart("never")),
  );
});

describe("SquirePresence across a restart", () => {
  const restart = Effect.gen(function* () {
    const context = yield* Layer.build(Layer.fresh(layerPresenceOnly));
    return Context.get(context, SquirePresence.SquirePresence);
  });

  it.effect("no desktop is active until a heartbeat arrives", () =>
    Effect.gen(function* () {
      yield* setup;
      yield* heartbeat();
      yield* settle;
      const restarted = yield* restart;
      assert.isFalse(yield* restarted.desktopActive);
    }).pipe(atStart()),
  );

  it.effect("the clock re-arms from escalate_at and escalates on time", () =>
    Effect.gen(function* () {
      yield* setup;
      yield* heartbeat();
      yield* settle;
      const raised = yield* raise("card:a");
      yield* TestClock.adjust(MINUTE);

      // A new process: fresh presence and its clock over the same table.
      const context = yield* Layer.build(
        SquireClock.layer.pipe(
          Layer.provideMerge(Layer.fresh(layerPresenceOnly)),
          Layer.provide(layerClockMocks),
        ),
      );
      const clock = Context.get(context, SquireClock.SquireClock);
      yield* Effect.forkScoped(clock.start);
      yield* settle;
      yield* TestClock.adjust(2 * MINUTE - SECOND);
      yield* settle;
      assert.deepEqual(yield* deliveries(raised.cardId), ["deferred_desktop_active"]);
      yield* TestClock.adjust(SECOND);
      yield* settle;
      assert.deepEqual(yield* deliveries(raised.cardId), ["deferred_desktop_active", "escalated"]);
    }).pipe(atStart()),
  );
});

const layerClockMocks = Layer.mergeAll(
  Layer.mock(SquireReactor.SquireReactor)({ promoteDue: () => Effect.succeed([]) }),
  Layer.mock(SquireTriggers.SquireTriggers)({
    fireDueSlots: () => Effect.succeed(0),
    earliestSlotAt: Effect.succeedNone,
  }),
  Layer.mock(SquireDelivery.SquireDelivery)({ wake: () => Effect.void }),
  Layer.mock(SquireWorkspace.SquireWorkspace)({ pathFor: () => Effect.succeed("/nonexistent") }),
  Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
  VcsProcess.layer,
);

describe("SquirePresence.markAlerted", () => {
  it.effect("records one alerted row per pushed card, and refuses unknown or foreign ones", () =>
    Effect.gen(function* () {
      yield* setup;
      const repository = yield* SquireRepository.SquireRepository;
      const presence = yield* SquirePresence.SquirePresence;
      const raised = yield* raise("card:alerted");
      yield* repository.insertActionLog({
        squire_id: release,
        kind: "notification.pushed",
        room_id: null,
        post_id: null,
        trigger_id: null,
        task_id: null,
        thread_id: thread,
        card_id: raised.cardId,
        event_id: null,
        run_id: null,
        invocation_key: null,
        execution_key: null,
        data_json: JSON.stringify({ kind: "steer", source: "card" }),
        created_at: iso(START),
      });
      const input = {
        requestId: "alert-1",
        squireId: release,
        cardId: raised.cardId,
        surface: "desktop" as const,
      };
      yield* presence.markAlerted(input);
      yield* presence.markAlerted({ ...input, requestId: "alert-2" });
      assert.deepEqual(
        (yield* deliveries(raised.cardId)).filter((outcome) => outcome === "alerted"),
        ["alerted"],
      );

      const unknown = yield* Effect.flip(
        presence.markAlerted({ ...input, cardId: SquireCardId.make("card:missing") }),
      );
      assert.equal(unknown.code, "not_found");
      const foreign = yield* Effect.flip(
        presence.markAlerted({ ...input, squireId: SquireId.make("sq_other") }),
      );
      assert.equal(foreign.code, "not_found");
      // A card that never pushed is not an intent.
      const quiet = yield* raise("card:quiet", "fyi");
      const unpushed = yield* Effect.flip(presence.markAlerted({ ...input, cardId: quiet.cardId }));
      assert.equal(unpushed.code, "not_found");
    }).pipe(atStart()),
  );
});
