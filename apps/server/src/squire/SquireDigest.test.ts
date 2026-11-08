import { assert, describe, it } from "@effect/vitest";
import {
  isUnknownUnionMember,
  RunId,
  SquireCardId,
  SquireEvent,
  SquireId,
  ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as SquireDigest from "./SquireDigest.ts";
import * as SquireRepository from "./SquireRepository.ts";
import { squireRow } from "./testkit/scopeHarness.ts";
import { sweepLayer } from "./testkit/sweepHarness.ts";

const lead = SquireId.make("squire:lead");
const release = SquireId.make("squire:release");
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(SquireEvent));

const seed = (leadOverrides: Partial<SquireRepository.SquireRow> = {}) =>
  Effect.gen(function* () {
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
      squireRow(release, { name: "Release", home_thread_id: ThreadId.make("thread:release-home") }),
    );
  });

/** Moves the clock and runs the digest check, as SquireClock does. */
const dueAt = (iso: string) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(iso));
    const digest = yield* SquireDigest.SquireDigest;
    return yield* digest.due(yield* DateTime.now);
  });

const digestDates = Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
  repository
    .listEvents({ statuses: ["pending", "delivered"], kinds: ["digest-due"] })
    .pipe(Effect.map((rows) => rows.map((row) => row.state_key))),
);
const leadRow = Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
  Effect.map(repository.getSquire(lead), Option.getOrThrow),
);
const setZone = (timezone: string) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository.updateSquire({
      id: lead,
      patch: { timezone },
      updatedAt: "2026-11-02T00:00:00.000Z",
    }),
  );

describe("SquireDigest", () => {
  it.effect("enqueues once per local date, at the digest time in the Lead's zone (D31)", () =>
    Effect.gen(function* () {
      yield* seed();
      // 07:59 in New York.
      assert.isFalse(yield* dueAt("2026-11-02T12:59:00.000Z"));
      const before = (yield* leadRow).revision;
      assert.isTrue(yield* dueAt("2026-11-02T13:00:00.000Z"));
      assert.isFalse(yield* dueAt("2026-11-02T13:00:05.000Z"));
      assert.isFalse(yield* dueAt("2026-11-03T04:59:00.000Z"));
      assert.deepStrictEqual(yield* digestDates, ["2026-11-02"]);
      const row = yield* leadRow;
      assert.strictEqual(row.digest_last_date, "2026-11-02");
      // The claim never bumps the revision the setup sheet edits against.
      assert.strictEqual(row.revision, before);
      const digest = yield* SquireDigest.SquireDigest;
      assert.deepStrictEqual(
        Option.map(yield* digest.nextDueAt(yield* DateTime.now), DateTime.formatIso),
        Option.some("2026-11-03T13:00:00.000Z"),
      );
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("catches up once later the same local day, never the next day", () =>
    Effect.gen(function* () {
      yield* seed({ digest_last_date: "2026-10-31" });
      // Down through 2026-11-01's slot; up the next morning before the slot.
      assert.isFalse(yield* dueAt("2026-11-02T12:00:00.000Z"));
      // Down through 2026-11-02's slot; up at 17:00 local the same day.
      assert.isTrue(yield* dueAt("2026-11-02T22:00:00.000Z"));
      assert.isFalse(yield* dueAt("2026-11-02T23:00:00.000Z"));
      assert.deepStrictEqual(yield* digestDates, ["2026-11-02"]);
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("a timezone change never repeats a digest, then follows the new zone", () =>
    Effect.gen(function* () {
      yield* seed();
      assert.isTrue(yield* dueAt("2026-11-02T13:05:00.000Z"));
      // 22:05 in Tokyo, still 2026-11-02 there: already sent.
      yield* setZone("Asia/Tokyo");
      assert.isFalse(yield* dueAt("2026-11-02T13:06:00.000Z"));
      // 08:30 on 2026-11-03 in Tokyo.
      assert.isTrue(yield* dueAt("2026-11-02T23:30:00.000Z"));
      // Back to New York, where it is 18:31 on 2026-11-02: the local date went back.
      yield* setZone("America/New_York");
      assert.isFalse(yield* dueAt("2026-11-02T23:31:00.000Z"));
      assert.strictEqual((yield* leadRow).digest_last_date, "2026-11-03");
      assert.isFalse(yield* dueAt("2026-11-03T12:00:00.000Z"));
      assert.deepStrictEqual(yield* digestDates, ["2026-11-02", "2026-11-03"]);
      // New York reaches 2026-11-04 08:00 next.
      assert.isTrue(yield* dueAt("2026-11-04T13:00:00.000Z"));
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("is off without digest settings and while the Lead is paused", () =>
    Effect.gen(function* () {
      yield* seed({ digest_json: null });
      assert.isFalse(yield* dueAt("2026-11-02T14:00:00.000Z"));
      const digest = yield* SquireDigest.SquireDigest;
      assert.isTrue(Option.isNone(yield* digest.nextDueAt(yield* DateTime.now)));
      const repository = yield* SquireRepository.SquireRepository;
      yield* repository.updateSquire({
        id: lead,
        patch: { digest_json: JSON.stringify({ time: "08:00" }), status: "paused" },
        updatedAt: "2026-11-02T14:00:00.000Z",
      });
      assert.isFalse(yield* dueAt("2026-11-02T14:01:00.000Z"));
      assert.deepStrictEqual(yield* digestDates, []);
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("pushes only when digest push is on and the Lead's Notify is On (D27)", () =>
    Effect.gen(function* () {
      const repository = yield* SquireRepository.SquireRepository;
      const pushed = Effect.map(
        repository.listActionLog({ squireId: lead, kinds: ["notification.pushed"], limit: 10 }),
        (rows) => rows.length,
      );
      const fyis = Effect.map(repository.listCards({ squireId: lead, kinds: ["fyi"] }), (cards) =>
        cards.map((card) => card.id),
      );
      yield* seed({
        digest_json: JSON.stringify({ time: "08:00", push: true }),
        permissions_json: JSON.stringify({ notify: "off" }),
      });
      assert.isTrue(yield* dueAt("2026-11-02T13:00:00.000Z"));
      assert.strictEqual(yield* pushed, 0);

      yield* repository.updateSquire({
        id: lead,
        patch: { permissions_json: JSON.stringify({ notify: "on" }) },
        updatedAt: "2026-11-02T14:00:00.000Z",
      });
      assert.isTrue(yield* dueAt("2026-11-03T13:00:00.000Z"));
      assert.strictEqual(yield* pushed, 1);
      assert.deepStrictEqual(yield* fyis, [
        SquireCardId.make(`card:fyi:${lead}:digest:2026-11-03`),
      ]);
      // The mobile row is the relay's to write, after this transaction.
      const delivery = yield* repository.listActionLog({
        squireId: lead,
        kinds: ["notification.delivery"],
        limit: 10,
      });
      assert.lengthOf(delivery, 0);

      yield* repository.updateSquire({
        id: lead,
        patch: { digest_json: JSON.stringify({ time: "08:00", push: false }) },
        updatedAt: "2026-11-03T14:00:00.000Z",
      });
      assert.isTrue(yield* dueAt("2026-11-04T13:00:00.000Z"));
      assert.strictEqual(yield* pushed, 1);
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("carries a bounded input from items, summaries, and the log", () =>
    Effect.gen(function* () {
      yield* seed();
      const repository = yield* SquireRepository.SquireRepository;
      const thread = ThreadId.make("thread:work");
      yield* repository.insertCard({
        id: SquireCardId.make("card:steer:release:1"),
        squire_id: release,
        owner_squire_id: release,
        kind: "steer",
        status: "open",
        target_thread_id: thread,
        project_id: null,
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
        created_at: "2026-11-02T10:00:00.000Z",
        updated_at: "2026-11-02T10:00:00.000Z",
      });
      yield* repository.insertBudgetUsage({
        squire_id: release,
        thread_id: thread,
        kind: "steer",
        room_id: null,
        executed_at: "2026-11-02T11:00:00.000Z",
        execution_key: "exec:1",
      });
      assert.isTrue(yield* dueAt("2026-11-02T13:00:00.000Z"));
      const [row] = yield* repository.listEvents({ statuses: ["pending"], kinds: ["digest-due"] });
      const event = decodeEvent(row?.payload_json ?? "");
      const input =
        !isUnknownUnionMember(event) && event.type === "digest-due" ? event.digest : undefined;
      assert.deepStrictEqual(input?.sweep, { accepted: 0, total: 0 });
      assert.deepStrictEqual(
        input?.squires.map((squire) => squire.name),
        ["Release"],
      );
      const section = input?.squires[0];
      assert.deepStrictEqual(section?.waiting, [
        {
          text: "steer: Rebase onto main",
          threadId: thread,
          cardId: SquireCardId.make("card:steer:release:1"),
        },
      ]);
      assert.deepStrictEqual(section?.budget.steers, { used: 1, limit: 10 });
    }).pipe(Effect.provide(sweepLayer())),
  );

  it.effect("still reports a turn its Squire stayed quiet on, with no card behind it", () =>
    Effect.gen(function* () {
      yield* seed();
      const repository = yield* SquireRepository.SquireRepository;
      const thread = ThreadId.make("thread:quiet");
      const runId = RunId.make("run:quiet");
      yield* repository.insertEvent({
        squire_id: release,
        thread_id: thread,
        kind: "turn-finished",
        state_key: runId,
        payload_json: JSON.stringify({
          outcome: "finished",
          runId,
          pendingRequest: null,
          pullRequest: null,
        }),
        status: "delivered",
        defer_reason: null,
        not_before: "2026-11-02T10:00:00.000Z",
        batch_id: null,
        created_at: "2026-11-02T10:00:00.000Z",
      });
      yield* repository.insertSummary({
        thread_id: thread,
        run_id: runId,
        stage: "terminal",
        status: "complete",
        summary_json: JSON.stringify({
          threadId: thread,
          threadTitle: "Fix invoice rounding",
          project: "billing",
          provider: "codex",
          turnId: runId,
          outcome: "finished",
          summaryStatus: "complete",
          goal: "Round invoices",
          completed: ["Shipped banker's rounding"],
          remaining: [],
          blocked: [],
          pendingQuestion: null,
          suggestedNextStep: null,
          files: { entries: [], counts: { added: 0, modified: 0, deleted: 0 } },
          commands: [],
          pullRequest: null,
        }),
        payer_squire_id: null,
        created_at: "2026-11-02T10:00:00.000Z",
        updated_at: "2026-11-02T10:00:00.000Z",
      });
      assert.lengthOf(yield* repository.listCards({ squireId: release }), 0);

      assert.isTrue(yield* dueAt("2026-11-02T13:00:00.000Z"));
      const [row] = yield* repository.listEvents({ statuses: ["pending"], kinds: ["digest-due"] });
      const event = decodeEvent(row?.payload_json ?? "");
      const input =
        !isUnknownUnionMember(event) && event.type === "digest-due" ? event.digest : undefined;
      assert.deepStrictEqual(input?.squires[0]?.moved, [
        { text: "Fix invoice rounding: Shipped banker's rounding", threadId: thread, cardId: null },
      ]);
    }).pipe(Effect.provide(sweepLayer())),
  );
});
