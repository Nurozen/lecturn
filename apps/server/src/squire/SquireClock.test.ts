import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SquireId, ThreadId } from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SquireActions from "./SquireActions.ts";
import * as SquireClock from "./SquireClock.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquireReactor from "./SquireReactor.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireTriggers from "./SquireTriggers.ts";
import * as SquireWorkspace from "./SquireWorkspace.ts";
import { git, initRepo, tempRoot } from "./testkit/lifecycleHarness.ts";
import { squireRow } from "./testkit/scopeHarness.ts";

const release = SquireId.make("squire:release");
const thread = ThreadId.make("thread-1");
const START = Date.parse("2026-11-02T08:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

interface Probe {
  readonly promoted: Array<number>;
  readonly fired: Array<number>;
  readonly woken: Array<SquireId>;
  readonly executed: Array<number>;
  slotAt: number | null;
  heldAt: number | null;
}

/** The clock over real Squire SQL, with the reactor, triggers, and delivery recorded. */
const layerClock = (probe: Probe, workspaceDir = "/nonexistent") =>
  SquireClock.layer.pipe(
    Layer.provideMerge(SquireRepository.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(SquireReactor.SquireReactor)({
          promoteDue: (now) =>
            Effect.sync(() => {
              probe.promoted.push(DateTime.toEpochMillis(now));
              return [];
            }),
        }),
        Layer.mock(SquireTriggers.SquireTriggers)({
          fireDueSlots: (now) =>
            Effect.sync(() => {
              probe.fired.push(DateTime.toEpochMillis(now));
              return 0;
            }),
          earliestSlotAt: Effect.sync(() =>
            probe.slotAt === null ? Option.none() : Option.some(DateTime.makeUnsafe(probe.slotAt)),
          ),
          checkInactivity: () => Effect.void,
        }),
        Layer.mock(SquireDelivery.SquireDelivery)({
          wake: (squireId) => Effect.sync(() => void probe.woken.push(squireId)),
        }),
        Layer.mock(SquireWorkspace.SquireWorkspace)({
          pathFor: () => Effect.succeed(workspaceDir),
        }),
        Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
        Layer.mock(SquireActions.SquireActions)({
          executeDue: Effect.flatMap(DateTime.now, (now) =>
            Effect.sync(() => {
              probe.executed.push(DateTime.toEpochMillis(now));
              if (probe.heldAt !== null && probe.heldAt <= DateTime.toEpochMillis(now)) {
                probe.heldAt = null;
              }
            }),
          ),
          nextDueAt: Effect.sync(() =>
            probe.heldAt === null ? Option.none() : Option.some(DateTime.makeUnsafe(probe.heldAt)),
          ),
        }),
        VcsProcess.layer,
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const newProbe = (): Probe => ({
  promoted: [],
  fired: [],
  woken: [],
  executed: [],
  slotAt: null,
  heldAt: null,
});

const eventRow = (
  overrides: Partial<SquireRepository.SquireEventRow>,
): Omit<SquireRepository.SquireEventRow, "id"> => ({
  squire_id: release,
  thread_id: thread,
  kind: "waiting-on-user",
  state_key: "request-1",
  payload_json: null,
  status: "deferred",
  defer_reason: "threshold",
  not_before: iso(START),
  batch_id: null,
  created_at: iso(START),
  ...overrides,
});

/** Lets the clock fiber run up to its next sleep. */
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
  discard: true,
});

describe("SquireClock", () => {
  it.effect("fires a deferred row and a schedule slot at their times, re-arming on insert", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const clock = yield* SquireClock.SquireClock;
      const repository = yield* SquireRepository.SquireRepository;
      yield* repository.createSquire(squireRow(release));
      yield* Effect.forkScoped(clock.start);
      yield* settle;
      // Startup runs once; with nothing due it sleeps until a change.
      assert.deepEqual(probe.promoted, [START]);

      const due = START + 30 * MINUTE;
      yield* repository.insertEvent(eventRow({ not_before: iso(due) }));
      yield* settle;
      yield* TestClock.adjust(29 * MINUTE);
      yield* settle;
      assert.isTrue(probe.promoted.every((at) => at < due));

      yield* TestClock.adjust(MINUTE);
      yield* settle;
      assert.include(probe.promoted, due);

      // A schedule slot arms the same fiber; the pending row's Squire is woken.
      probe.slotAt = due + 2 * 60 * MINUTE;
      yield* repository.insertEvent(
        eventRow({
          kind: "turn-finished",
          state_key: "run-1",
          status: "pending",
          defer_reason: null,
        }),
      );
      yield* repository.dropDeferredEvents(release);
      yield* settle;
      yield* TestClock.adjust(2 * 60 * MINUTE);
      yield* settle;
      assert.include(probe.fired, probe.slotAt);
      assert.include(probe.woken, release);
    }).pipe(Effect.provide(layerClock(probe)), Effect.scoped);
  });

  it.effect("arms on a held action's executes_at and runs it then", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const clock = yield* SquireClock.SquireClock;
      const repository = yield* SquireRepository.SquireRepository;
      yield* Effect.forkScoped(clock.start);
      yield* settle;
      const executesAt = START + 10_000;
      probe.heldAt = executesAt;
      // A hold commits a card row, which re-arms the clock.
      yield* repository.createSquire(squireRow(release));
      yield* settle;
      yield* TestClock.adjust(9_000);
      yield* settle;
      assert.isFalse(probe.executed.some((at) => at >= executesAt));
      yield* TestClock.adjust(1_000);
      yield* settle;
      assert.include(probe.executed, executesAt);
    }).pipe(Effect.provide(layerClock(probe)), Effect.scoped);
  });

  it.effect("prunes finished payloads after 30 days once a day, keeping the keys", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const clock = yield* SquireClock.SquireClock;
      const repository = yield* SquireRepository.SquireRepository;
      yield* repository.createSquire(squireRow(release));
      const old = eventRow({
        kind: "pull-request-changed",
        state_key: "github.com/acme/billing#12:abc:checks:failed",
        status: "delivered",
        defer_reason: null,
        payload_json: '{"outcome":null}',
        created_at: iso(START - 31 * DAY),
      });
      yield* repository.insertEvent(old);
      yield* repository.insertEvent({ ...old, state_key: "recent", created_at: iso(START - DAY) });
      yield* repository.insertEvent({
        ...old,
        state_key: "unfinished",
        status: "pending",
        created_at: iso(START - 40 * DAY),
      });

      yield* clock.sweep;
      const rows = yield* repository.listEventsByStatus({
        squireId: release,
        statuses: ["pending", "delivered"],
      });
      assert.deepEqual(
        rows.map((row) => [row.state_key, row.payload_json === null]),
        [
          [old.state_key, true],
          ["recent", false],
          ["unfinished", false],
        ],
      );
      // The key outlives its payload: the same absolute PR state is still a duplicate.
      assert.isFalse(yield* repository.insertEvent({ ...old, status: "pending" }));

      // Once a day: a second sweep the same day leaves a newly old payload alone.
      yield* repository.insertEvent({
        ...old,
        state_key: "later",
        created_at: iso(START - 32 * DAY),
      });
      yield* clock.sweep;
      const later = () =>
        repository
          .listEventsByStatus({ squireId: release, statuses: ["delivered"] })
          .pipe(Effect.map((all) => all.find((row) => row.state_key === "later")!.payload_json));
      assert.isNotNull(yield* later());
      yield* TestClock.adjust(DAY);
      yield* clock.sweep;
      assert.isNull(yield* later());
    }).pipe(Effect.provide(layerClock(probe)), Effect.scoped);
  });

  it.effect("the daily prune keeps each table's history for its own window", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const sql = yield* SqlClient.SqlClient;
      const clock = yield* SquireClock.SquireClock;
      const repository = yield* SquireRepository.SquireRepository;
      yield* repository.createSquire(squireRow(release));
      const HOUR = 60 * MINUTE;
      // One row just past each window and one just inside it.
      const around = (days: number) => [
        iso(START - days * DAY - HOUR),
        iso(START - days * DAY + HOUR),
      ];
      for (const [index, at] of around(30).entries()) {
        yield* repository.insertEvent(
          eventRow({
            state_key: `run-${index}`,
            kind: "turn-finished",
            status: "delivered",
            created_at: at,
          }),
        );
        yield* sql`INSERT INTO squire_card ${sql.insert({
          id: `card-${index}`,
          squire_id: release,
          owner_squire_id: release,
          kind: "fyi",
          status: "outdated",
          target_thread_id: `thread-${index}`,
          title: "Old",
          why: "Old",
          payload_json: "{}",
          evidence_json: "{}",
          trigger_json: "{}",
          origin: "event",
          created_at: at,
          updated_at: at,
        })}`;
        yield* sql`INSERT INTO squire_room ${sql.insert({
          id: `room-${index}`,
          topic: "Old",
          about_json: "[]",
          status: "closed",
          bot_messaging: "on",
          idle_ttl_seconds: 3600,
          creator_kind: "user",
          last_post_at: at,
          created_at: at,
          updated_at: at,
        })}`;
        yield* sql`INSERT INTO squire_room_post ${sql.insert({
          message_key: `post-${index}`,
          room_id: `room-${index}`,
          author_kind: "user",
          body: "Hi",
          refs_json: "[]",
          routing_json: "{}",
          created_at: at,
        })}`;
      }
      for (const at of around(90)) {
        yield* sql`INSERT INTO squire_action_log ${sql.insert({
          squire_id: release,
          kind: "trigger.received",
          data_json: "{}",
          created_at: at,
        })}`;
      }
      for (const at of around(8)) {
        yield* sql`INSERT INTO squire_budget_usage ${sql.insert({
          squire_id: release,
          kind: "steer",
          executed_at: at,
        })}`;
      }

      yield* clock.sweep;
      const count = (table: string) =>
        sql<{ n: number }>`SELECT count(*) AS n FROM ${sql(table)}`.pipe(
          Effect.map((rows) => rows[0]?.n),
        );
      for (const table of [
        "squire_event",
        "squire_card",
        "squire_room_post",
        "squire_action_log",
        "squire_budget_usage",
      ]) {
        assert.equal(yield* count(table), 1, table);
      }
    }).pipe(Effect.provide(layerClock(probe)), Effect.scoped);
  });

  it.live("keeps the newest checkpoint refs in a scratch repo", () =>
    Effect.gen(function* () {
      const { root } = yield* tempRoot;
      const dir = initRepo(`${root}/workspace`);
      const head = git(dir, ["rev-parse", "HEAD"]);
      const total = SquireClock.SQUIRE_SCRATCH_REFS_KEPT + 5;
      for (let index = 0; index < total; index++) {
        git(dir, ["update-ref", `refs/lecturn/checkpoint-${index}`, head]);
      }
      yield* Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        yield* repository.createSquire(squireRow(release));
        yield* (yield* SquireClock.SquireClock).sweep;
      }).pipe(Effect.provide(layerClock(newProbe(), dir)));
      const left = git(dir, ["for-each-ref", "--format=%(refname)", "refs/lecturn/"]).split("\n");
      assert.lengthOf(left, SquireClock.SQUIRE_SCRATCH_REFS_KEPT);
    }).pipe(Effect.scoped),
  );
});
