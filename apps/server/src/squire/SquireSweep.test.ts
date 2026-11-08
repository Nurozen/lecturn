import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SQUIRE_BUDGETS,
  DEFAULT_SQUIRE_PERMISSIONS,
  ProjectId,
  SquireCardId,
  SquireId,
  ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { decide } from "./squirePolicy.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireSweep from "./SquireSweep.ts";
import { grantRow, squireRow } from "./testkit/scopeHarness.ts";
import { PROJECT, prLink, setShells, shell, sweepLayer } from "./testkit/sweepHarness.ts";

const lead = SquireId.make("squire:lead");
const release = SquireId.make("squire:release");
const idle = ThreadId.make("thread:idle");
const failing = ThreadId.make("thread:failing");
const busy = ThreadId.make("thread:busy");
const merged = ThreadId.make("thread:merged");
const fresh = ThreadId.make("thread:fresh");
const untracked = ThreadId.make("thread:untracked");
// 07:00 in New York (EST); the digest and the daily sweep run at 08:00 there.
const NOW = "2026-11-02T12:00:00.000Z";
const HOUR = 60 * 60 * 1000;
const hoursAgo = (hours: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(NOW) - hours * HOUR));

let requests = 0;
const requestId = () => `find-work-${++requests}`;

const seed = (leadOverrides: Partial<SquireRepository.SquireRow> = {}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const repository = yield* SquireRepository.SquireRepository;
    yield* repository.createSquire(
      squireRow(lead, {
        role: "lead",
        home_thread_id: ThreadId.make("thread:lead-home"),
        digest_json: JSON.stringify({ time: "08:00", push: false }),
        timezone: "America/New_York",
        ...leadOverrides,
      }),
    );
    yield* repository.createSquire(
      squireRow(release, { home_thread_id: ThreadId.make("thread:release-home") }),
    );
    yield* repository.insertGrant(grantRow(release, "project", PROJECT));
  });

const standardShells = () =>
  setShells([
    shell(idle, {
      lastRunAt: hoursAgo(30),
      pullRequests: [prLink({ number: 1, headSha: "aaa1" })],
    }),
    shell(failing, {
      lastRunAt: hoursAgo(3),
      pullRequests: [
        prLink({ number: 2, headSha: "bbb2", checks: "failing", syncedAt: hoursAgo(1) }),
      ],
    }),
    shell(merged, {
      lastRunAt: hoursAgo(48),
      pullRequests: [prLink({ number: 3, headSha: "ccc3", state: "merged" })],
    }),
    shell(fresh, {
      lastRunAt: hoursAgo(2),
      pullRequests: [prLink({ number: 4, headSha: "ddd4" })],
    }),
  ]);

const cardRow = (
  id: string,
  overrides: Partial<SquireRepository.SquireCardRow>,
): SquireRepository.SquireCardRow => ({
  id: SquireCardId.make(id),
  squire_id: release,
  owner_squire_id: release,
  kind: "steer",
  status: "open",
  target_thread_id: null,
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
  expires_at: null,
  attempt: 0,
  command_id: null,
  execution_key: null,
  dedupe_key: null,
  replaced_count: 0,
  ask_json: null,
  resolution: null,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const sweepEvents = Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
  repository.listEvents({ statuses: ["pending", "delivered"], kinds: ["sweep-due"] }),
);
const ranRows = Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
  repository.listActionLog({ squireId: lead, kinds: ["sweep.ran"], limit: 100 }),
);
const candidatesOf = (row: SquireRepository.SquireEventRow | undefined) =>
  (JSON.parse(row?.payload_json ?? "{}") as { candidates?: ReadonlyArray<unknown> }).candidates ??
  [];
const leadRow = Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
  Effect.map(repository.getSquire(lead), Option.getOrThrow),
);

const isoFar = "2999-01-01T00:00:00.000Z";

const findWork = Effect.flatMap(SquireSweep.SquireSweep, (sweep) =>
  sweep.request({ requestId: requestId() }),
);

/** The sweep turn's batch: the newest sweep-due row. */
const admit = (threadId: ThreadId | null, kind: "steer" | "proposal" = "steer") =>
  Effect.gen(function* () {
    const sweep = yield* SquireSweep.SquireSweep;
    const events = yield* sweepEvents;
    return yield* sweep.admitFinding({
      lead: yield* leadRow,
      batchEvents: events.slice(-1),
      threadId,
      kind,
      now: DateTime.formatIso(yield* DateTime.now),
    });
  });

/** What SquireTools writes for an admitted finding. */
const raise = (id: string, threadId: ThreadId) =>
  Effect.gen(function* () {
    const admission = yield* admit(threadId);
    if (!admission.ok) return yield* Effect.die(`refused: ${admission.reason}`);
    const repository = yield* SquireRepository.SquireRepository;
    yield* repository.insertCard(
      cardRow(id, {
        squire_id: lead,
        target_thread_id: threadId,
        origin: "sweep",
        finding_key: admission.findingKey,
        trigger_json: JSON.stringify(admission.trigger),
        created_at: DateTime.formatIso(yield* DateTime.now),
      }),
    );
    return admission;
  });

describe("SquireSweep", () => {
  it.effect("offers idle unmerged and failing-head threads, and skips the rest (D59)", () =>
    Effect.gen(function* () {
      yield* seed();
      const repository = yield* SquireRepository.SquireRepository;
      yield* setShells([
        shell(idle, {
          lastRunAt: hoursAgo(30),
          pullRequests: [prLink({ number: 1, headSha: "aaa1" })],
        }),
        shell(failing, {
          lastRunAt: hoursAgo(3),
          pullRequests: [
            prLink({ number: 2, headSha: "bbb2", checks: "failing", syncedAt: hoursAgo(1) }),
          ],
        }),
        shell(merged, {
          lastRunAt: hoursAgo(48),
          pullRequests: [prLink({ number: 3, headSha: "ccc3", state: "merged" })],
        }),
        shell(fresh, {
          lastRunAt: hoursAgo(2),
          pullRequests: [prLink({ number: 4, headSha: "ddd4" })],
        }),
        // An open decision item (here a hold) keeps a thread out.
        shell(busy, {
          lastRunAt: hoursAgo(40),
          pullRequests: [prLink({ number: 5, headSha: "eee5" })],
        }),
        {
          ...shell(untracked, {
            lastRunAt: hoursAgo(40),
            pullRequests: [prLink({ number: 6, headSha: "fff6" })],
          }),
          projectId: ProjectId.make("project:other"),
        },
      ]);
      yield* repository.insertCard(
        cardRow("card:hold", { status: "held", target_thread_id: busy }),
      );

      assert.deepStrictEqual(yield* findWork, { outcome: "queued", retryAt: null });
      const [event] = yield* sweepEvents;
      assert.deepStrictEqual(candidatesOf(event), [
        {
          threadId: failing,
          kind: "failing-checks-no-turn",
          pullRequestNumber: 2,
          headSha: "bbb2",
        },
        { threadId: idle, kind: "idle-unmerged-pr", pullRequestNumber: 1, headSha: "aaa1" },
      ]);
      assert.strictEqual(event?.squire_id, lead);
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("remembers a dismissal per thread, kind, and head", () =>
    Effect.gen(function* () {
      yield* seed();
      yield* standardShells();
      const repository = yield* SquireRepository.SquireRepository;
      yield* findWork;
      const admission = yield* raise("card:finding-idle", idle);
      assert.isTrue(admission.ok);
      yield* repository.updateCard({
        id: SquireCardId.make("card:finding-idle"),
        fromStatuses: ["open"],
        patch: { status: "dismissed", resolution: "dismissed" },
        updatedAt: NOW,
      });
      yield* findWork;
      const second = (yield* sweepEvents).at(-1);
      assert.deepStrictEqual(
        candidatesOf(second).map((candidate) => (candidate as { threadId: string }).threadId),
        [failing],
      );
      // A new head is a new finding.
      yield* setShells([
        shell(idle, {
          lastRunAt: hoursAgo(30),
          pullRequests: [prLink({ number: 1, headSha: "aaa9" })],
        }),
      ]);
      yield* findWork;
      assert.deepStrictEqual(
        candidatesOf((yield* sweepEvents).at(-1)).map(
          (candidate) => (candidate as { headSha: string }).headSha,
        ),
        ["aaa9"],
      );
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("an empty sweep logs one row and queues no Lead turn", () =>
    Effect.gen(function* () {
      yield* seed();
      const id = requestId();
      const sweep = yield* SquireSweep.SquireSweep;
      assert.deepStrictEqual(yield* sweep.request({ requestId: id }), {
        outcome: "empty",
        retryAt: null,
      });
      // A retried request is the same sweep.
      assert.strictEqual((yield* sweep.request({ requestId: id })).outcome, "empty");
      assert.lengthOf(yield* sweepEvents, 0);
      const rows = yield* ranRows;
      assert.lengthOf(rows, 1);
      assert.include(rows[0]?.data_json ?? "", '"outcome":"empty"');
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("stops at the sweep budget and says until when", () =>
    Effect.gen(function* () {
      yield* seed();
      yield* standardShells();
      for (let index = 0; index < 4; index += 1) {
        assert.strictEqual((yield* findWork).outcome, "queued");
        yield* TestClock.adjust(HOUR);
      }
      // The first sweep ran at NOW, so a fifth fits again 24 h after it.
      assert.deepStrictEqual(yield* findWork, {
        outcome: "budget-reached",
        retryAt: "2026-11-03T12:00:00.000Z",
      });
      assert.lengthOf(yield* sweepEvents, 4);
      yield* TestClock.setTime(Date.parse("2026-11-03T12:00:01.000Z"));
      assert.strictEqual((yield* findWork).outcome, "queued");
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("a lapsed finding for the same head stays lapsed", () =>
    Effect.gen(function* () {
      yield* seed();
      yield* standardShells();
      const repository = yield* SquireRepository.SquireRepository;
      yield* findWork;
      const admission = yield* raise("card:finding-lapsed", idle);
      assert.isTrue(admission.ok);
      yield* repository.updateCard({
        id: SquireCardId.make("card:finding-lapsed"),
        fromStatuses: ["open"],
        patch: { status: "outdated", resolution: "expired" },
        updatedAt: NOW,
      });
      const again = yield* admit(idle);
      assert.strictEqual(!again.ok && again.reason, "finding-outdated");
      // Not offered again either, so it costs no Lead turn and frees its slot.
      yield* findWork;
      assert.notInclude(
        candidatesOf((yield* sweepEvents).at(-1)).map(
          (candidate) => (candidate as { threadId: string }).threadId,
        ),
        idle,
      );

      // The 30-day purge keeps it, or it would become raisable again.
      yield* repository.pruneHistory({
        eventsBefore: isoFar,
        cardsBefore: isoFar,
        actionLogBefore: isoFar,
        budgetUsageBefore: isoFar,
        closedRoomPostsBefore: isoFar,
      });
      assert.isTrue(
        Option.isSome(yield* repository.getCard(SquireCardId.make("card:finding-lapsed"))),
      );
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("admits at most 3 findings per sweep and 6 per day, only for candidates", () =>
    Effect.gen(function* () {
      yield* seed({ sweep_json: JSON.stringify({ findingsPerSweep: 1, findingsPerDay: 2 }) });
      yield* standardShells();
      yield* findWork;
      const outside = yield* admit(fresh);
      assert.isFalse(outside.ok);
      assert.strictEqual(!outside.ok && outside.reason, "not-a-candidate");

      const first = yield* raise("card:f1", failing);
      assert.deepStrictEqual(first.ok && first.trigger, {
        requestId: (
          JSON.parse((yield* sweepEvents)[0]?.payload_json ?? "{}") as { sweepKey: string }
        ).sweepKey,
        headSha: "bbb2",
        transition: "checks:failed",
        prKey: "github.com/acme/app#2",
      });
      const again = yield* admit(failing);
      assert.strictEqual(!again.ok && again.reason, "already-raised");
      const overSweep = yield* admit(idle);
      assert.strictEqual(!overSweep.ok && overSweep.reason, "sweep-findings-reached");

      yield* TestClock.adjust(HOUR);
      yield* findWork;
      yield* raise("card:f2", idle);
      // Accepting the first frees its thread for the next sweep, but not the day's count.
      yield* SquireRepository.SquireRepository.pipe(
        Effect.flatMap((repository) =>
          repository.updateCard({
            id: SquireCardId.make("card:f1"),
            fromStatuses: ["open"],
            patch: { status: "resolved", resolution: "accepted" },
            updatedAt: NOW,
          }),
        ),
      );
      yield* TestClock.adjust(HOUR);
      yield* findWork;
      const overDay = yield* admit(failing, "proposal");
      assert.strictEqual(!overDay.ok && overDay.reason, "daily-findings-reached");
      assert.include(!overDay.ok ? overDay.text : "", "until 2026-11-03T12:00:00.000Z");
    }).pipe(Effect.provide(sweepLayer())),
  );

  it("findings are recommend-only under Auto, never push, and skip the steer budget", () => {
    const auto = {
      id: release,
      role: "squire" as const,
      status: "active" as const,
      permissions: { ...DEFAULT_SQUIRE_PERMISSIONS, steer: "auto" as const, notify: "on" as const },
      budgets: { ...DEFAULT_SQUIRE_BUDGETS, steersPerDay: 1 },
      createdAt: "2026-11-01T00:00:00.000Z",
    };
    const target = { threadId: idle, projectId: PROJECT, staveSpaceId: null, staveSagaId: null };
    const spent = [{ kind: "steer" as const, threadId: idle, executedAt: hoursAgo(1) }];
    const base = { squire: auto, rules: [], target, trackers: [], budgetRows: spent, now: NOW };
    assert.deepStrictEqual(decide({ ...base, actionClass: "steer", origin: "sweep" }), {
      level: "recommend",
      reason: "origin",
    });
    assert.strictEqual(decide({ ...base, actionClass: "notify", origin: "sweep" }).level, "off");
  });

  it.effect("logs each finding's final outcome once; the rate matches the log", () =>
    Effect.gen(function* () {
      yield* seed();
      yield* standardShells();
      const repository = yield* SquireRepository.SquireRepository;
      const sweep = yield* SquireSweep.SquireSweep;
      yield* findWork;
      yield* raise("card:a", failing);
      yield* raise("card:b", idle);
      const finish = (id: string, status: "resolved" | "dismissed") =>
        repository.updateCard({
          id: SquireCardId.make(id),
          fromStatuses: ["open"],
          patch: { status, resolution: status === "resolved" ? "accepted" : "dismissed" },
          updatedAt: NOW,
        });
      yield* finish("card:a", "resolved");
      yield* finish("card:b", "dismissed");
      yield* repository.insertCard(
        cardRow("card:c", {
          squire_id: lead,
          origin: "sweep",
          finding_key: "thread:x:idle-unmerged-pr:zzz",
          status: "outdated",
          resolution: "outdated",
        }),
      );
      const now = yield* DateTime.now;
      assert.strictEqual(yield* sweep.recordOutcomes(now), 3);
      assert.strictEqual(yield* sweep.recordOutcomes(now), 0);
      const logged = yield* repository.listActionLog({
        squireId: lead,
        kinds: ["sweep.finding"],
        limit: 10,
      });
      assert.deepStrictEqual(logged.map((row) => JSON.parse(row.data_json).outcome).toSorted(), [
        "accepted",
        "dismissed",
        "outdated",
      ]);
      assert.deepStrictEqual(yield* sweep.acceptanceRate(lead, now), { accepted: 1, total: 3 });
      // Outside the 30-day window the rows no longer count.
      assert.deepStrictEqual(yield* sweep.acceptanceRate(lead, DateTime.add(now, { days: 31 })), {
        accepted: 0,
        total: 0,
      });
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("does not run while the Lead is paused or under the inactivity pause", () =>
    Effect.gen(function* () {
      yield* seed({ automation_paused_at: hoursAgo(1) });
      yield* standardShells();
      const repository = yield* SquireRepository.SquireRepository;
      const sweep = yield* SquireSweep.SquireSweep;
      assert.deepStrictEqual(yield* findWork, { outcome: "paused", retryAt: null });
      yield* TestClock.setTime(Date.parse("2026-11-02T13:30:00.000Z"));
      yield* sweep.due(yield* DateTime.now);
      assert.isTrue(Option.isNone(yield* sweep.nextDueAt(yield* DateTime.now)));
      yield* repository.updateSquire({
        id: lead,
        patch: { automation_paused_at: null, status: "paused" },
        updatedAt: NOW,
      });
      yield* sweep.due(yield* DateTime.now);
      assert.strictEqual((yield* findWork).outcome, "paused");
      assert.lengthOf(yield* sweepEvents, 0);
      assert.lengthOf(yield* ranRows, 0);
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("sweeps daily at the digest time, once, catching up later the same day", () =>
    Effect.gen(function* () {
      yield* seed();
      yield* standardShells();
      const sweep = yield* SquireSweep.SquireSweep;
      const at = (iso: string) =>
        TestClock.setTime(Date.parse(iso)).pipe(Effect.andThen(DateTime.now));
      // 08:00 New York is 13:00Z in November.
      assert.deepStrictEqual(
        Option.map(yield* sweep.nextDueAt(yield* at(NOW)), DateTime.formatIso),
        Option.some("2026-11-02T13:00:00.000Z"),
      );
      yield* sweep.due(yield* DateTime.now);
      assert.lengthOf(yield* sweepEvents, 0);
      // Down at the slot; up at 15:00 local the same day: one catch-up sweep.
      yield* sweep.due(yield* at("2026-11-02T20:00:00.000Z"));
      yield* sweep.due(yield* DateTime.now);
      const events = yield* sweepEvents;
      assert.lengthOf(events, 1);
      assert.strictEqual(events[0]?.state_key, "schedule:2026-11-02T13:00:00.000Z");
      assert.deepStrictEqual(
        Option.map(yield* sweep.nextDueAt(yield* DateTime.now), DateTime.formatIso),
        Option.some("2026-11-03T13:00:00.000Z"),
      );
      // A slot missed on an earlier day is not run the next morning.
      yield* sweep.due(yield* at("2026-11-04T12:00:00.000Z"));
      assert.lengthOf(yield* sweepEvents, 1);
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("sweeps every N hours from local midnight, and never when Off", () =>
    Effect.gen(function* () {
      yield* seed({ sweep_json: JSON.stringify({ schedule: { kind: "interval", hours: 6 } }) });
      yield* standardShells();
      const repository = yield* SquireRepository.SquireRepository;
      const sweep = yield* SquireSweep.SquireSweep;
      // 07:00 local: the 06:00 slot is due.
      yield* sweep.due(yield* DateTime.now);
      assert.strictEqual((yield* sweepEvents)[0]?.state_key, "schedule:2026-11-02T11:00:00.000Z");
      assert.deepStrictEqual(
        Option.map(yield* sweep.nextDueAt(yield* DateTime.now), DateTime.formatIso),
        Option.some("2026-11-02T17:00:00.000Z"),
      );
      yield* repository.updateSquire({
        id: lead,
        patch: { sweep_json: JSON.stringify({ schedule: { kind: "off" } }) },
        updatedAt: NOW,
      });
      yield* TestClock.adjust(12 * HOUR);
      yield* sweep.due(yield* DateTime.now);
      assert.lengthOf(yield* sweepEvents, 1);
      assert.isTrue(Option.isNone(yield* sweep.nextDueAt(yield* DateTime.now)));
    }).pipe(Effect.provide(sweepLayer())),
  );
});
