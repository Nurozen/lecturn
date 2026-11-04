import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  RunId,
  SquireCardId,
  SquireId,
  SquireRoomId,
  SquireRuleId,
  ThreadId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SquireRepository from "./SquireRepository.ts";

const squireId = SquireId.make("squire-research");
const threadId = ThreadId.make("thread-1");
const now = "2026-10-01T00:00:00.000Z";

const squire = (
  overrides: Partial<SquireRepository.SquireRow> = {},
): SquireRepository.SquireRow => ({
  id: squireId,
  role: "squire",
  name: "Research",
  lifecycle: "ready",
  home_generation: 0,
  home_thread_id: ThreadId.make("home-thread"),
  home_project_id: ProjectId.make("project-1"),
  provider_instance_id: "codex",
  model_selection_json: "{}",
  summary_model_selection_json: null,
  brief: "Watch the release",
  status: "active",
  events_json: "{}",
  permissions_json: "{}",
  budgets_json: "{}",
  undo_window_seconds: 10,
  digest_json: null,
  digest_last_date: null,
  onboarded_at: null,
  sweep_json: null,
  user_active_at: null,
  inactivity_prompted_at: null,
  automation_paused_at: null,
  companion_json: "{}",
  revision: 0,
  create_request_id: null,
  created_at: now,
  updated_at: now,
  ...overrides,
});

const event = (
  overrides: Partial<Omit<SquireRepository.SquireEventRow, "id">> = {},
): Omit<SquireRepository.SquireEventRow, "id"> => ({
  squire_id: squireId,
  thread_id: threadId,
  kind: "turn-finished",
  state_key: "run-1",
  payload_json: '{"outcome":"completed"}',
  status: "pending",
  defer_reason: null,
  not_before: now,
  batch_id: null,
  created_at: now,
  ...overrides,
});

const card = (
  overrides: Partial<SquireRepository.SquireCardRow> = {},
): SquireRepository.SquireCardRow => ({
  id: SquireCardId.make("card-1"),
  squire_id: squireId,
  owner_squire_id: squireId,
  kind: "steer",
  status: "open",
  target_thread_id: threadId,
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
  attempt: 0,
  command_id: null,
  execution_key: null,
  dedupe_key: null,
  replaced_count: 0,
  ask_json: null,
  resolution: null,
  created_at: now,
  updated_at: now,
  ...overrides,
});

const actionLog = (
  overrides: Partial<Omit<SquireRepository.SquireActionLogRow, "id">> = {},
): Omit<SquireRepository.SquireActionLogRow, "id"> => ({
  squire_id: squireId,
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
  created_at: now,
  ...overrides,
});

const roomPost = (
  overrides: Partial<Omit<SquireRepository.SquireRoomPostRow, "id">> = {},
): Omit<SquireRepository.SquireRoomPostRow, "id"> => ({
  message_key: "invocation-1",
  room_id: SquireRoomId.make("room-release"),
  author_kind: "squire",
  author_id: squireId,
  body: "Release is green",
  reply_to: null,
  refs_json: "[]",
  hop: 0,
  routing_json: "{}",
  rerouted_from: null,
  created_at: now,
  ...overrides,
});

const rule = (
  overrides: Partial<SquireRepository.SquireRuleRow> = {},
): SquireRepository.SquireRuleRow => ({
  id: SquireRuleId.make("rule-1"),
  squire_id: squireId,
  effect: "allow",
  action_class: "steer",
  target_kind: "thread",
  target_id: threadId,
  steer_kind: null,
  status: "active",
  match_count: 0,
  last_matched_at: null,
  created_at: now,
  ...overrides,
});

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "squire",
    "squire_grant",
    "squire_event",
    "squire_summary",
    "squire_card",
    "squire_budget_usage",
    "squire_action_log",
    "squire_rule",
    "squire_trigger",
    "squire_room",
    "squire_room_member",
    "squire_room_post",
  ])
    yield* sql`DELETE FROM ${sql(table)}`;
  return yield* SquireRepository.SquireRepository;
});

const otherId = SquireId.make("squire-release");
const leadId = SquireId.make("lead");

const grant = (
  overrides: Partial<SquireRepository.SquireGrantRow> = {},
): SquireRepository.SquireGrantRow => ({
  squire_id: squireId,
  kind: "thread",
  target_id: threadId,
  origin: "granted",
  created_at: now,
  ...overrides,
});

const usage = (
  overrides: Partial<Omit<SquireRepository.SquireBudgetUsageRow, "id">> = {},
): Omit<SquireRepository.SquireBudgetUsageRow, "id"> => ({
  squire_id: squireId,
  thread_id: threadId,
  kind: "steer",
  room_id: null,
  executed_at: now,
  execution_key: null,
  ...overrides,
});

const seedRoom = (id: string, members: ReadonlyArray<readonly [string, string]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO squire_room ${sql.insert({
      id,
      topic: id,
      about_json: "[]",
      status: "open",
      bot_messaging: "on",
      idle_ttl_seconds: 3600,
      creator_kind: "user",
      last_post_at: now,
      created_at: now,
      updated_at: now,
    })}`;
    for (const [member_kind, member_id] of members)
      yield* sql`INSERT INTO squire_room_member ${sql.insert({ room_id: id, member_kind, member_id })}`;
  });

const seedTrigger = (id: string, owner: SquireId, secretRef: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO squire_trigger ${sql.insert({
      id,
      squire_id: owner,
      name: id,
      kind: secretRef === null ? "schedule" : "webhook",
      instruction: "Check",
      status: "active",
      secret_ref: secretRef,
      created_at: now,
    })}`;
  });

const cardIds = (cards: ReadonlyArray<SquireRepository.SquireCardRow>) =>
  cards.map((row) => row.id);

// SQLITE_CONSTRAINT_UNIQUE, so a test cannot pass on some other failure.
const uniqueViolation = <A>(effect: Effect.Effect<A, PersistenceSqlError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.detail?.startsWith("SQLITE(2067)") ?? false),
  );

it.layer(Layer.provideMerge(SquireRepository.layer, SqlitePersistence.layerMemory))(
  "SquireRepository",
  (it) => {
    it.effect("ignores a second event with the same dedupe key, null thread included", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        assert.isTrue(yield* repository.insertEvent(event()));
        assert.isFalse(yield* repository.insertEvent(event({ payload_json: "{}" })));
        assert.isTrue(yield* repository.insertEvent(event({ state_key: "run-2" })));

        const direct = event({ thread_id: null, kind: "message", state_key: "key-1" });
        assert.isTrue(yield* repository.insertEvent(direct));
        assert.isFalse(yield* repository.insertEvent(direct));
      }),
    );

    it.effect("keeps a pruned event's key, so a re-insert is still ignored", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* fixture;
        yield* repository.insertEvent(event({ status: "delivered" }));
        yield* repository.insertEvent(event({ state_key: "run-2", status: "deferred" }));

        assert.equal(yield* repository.pruneEventPayloads({ before: "2026-11-01" }), 1);
        const rows = yield* sql<{ state_key: string; payload_json: string | null }>`
          SELECT state_key, payload_json FROM squire_event ORDER BY state_key`;
        assert.deepStrictEqual(rows, [
          { state_key: "run-1", payload_json: null },
          { state_key: "run-2", payload_json: '{"outcome":"completed"}' },
        ]);
        assert.isFalse(yield* repository.insertEvent(event({ status: "pending" })));
      }),
    );

    it.effect("allows one open card per Squire, target, and kind, but not for holds", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        yield* repository.insertCard(card());
        assert.isTrue(
          yield* uniqueViolation(repository.insertCard(card({ id: SquireCardId.make("card-2") }))),
        );
        yield* repository.insertCard(card({ id: SquireCardId.make("card-3"), status: "held" }));
        yield* repository.insertCard(card({ id: SquireCardId.make("card-4"), kind: "question" }));
      }),
    );

    it.effect("allows one open overlap card per dedupe key", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        const overlap = { kind: "overlap", dedupe_key: "repo:thread-1|thread-2" } as const;
        yield* repository.insertCard(card(overlap));
        assert.isTrue(
          yield* uniqueViolation(
            repository.insertCard(
              card({
                ...overlap,
                id: SquireCardId.make("card-2"),
                squire_id: SquireId.make("squire-release"),
              }),
            ),
          ),
        );
      }),
    );

    it.effect("allows only one Lead", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        yield* repository.createSquire(squire({ id: SquireId.make("lead-1"), role: "lead" }));
        yield* repository.createSquire(squire());
        assert.isTrue(
          yield* uniqueViolation(
            repository.createSquire(squire({ id: SquireId.make("lead-2"), role: "lead" })),
          ),
        );
        const stored = yield* repository.getSquire(squireId);
        assert.equal(Option.getOrThrow(stored).name, "Research");
      }),
    );

    it.effect("makes the create request id unique", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        yield* repository.createSquire(squire({ create_request_id: "fixture:research" }));
        assert.isTrue(
          yield* uniqueViolation(
            repository.createSquire(
              squire({ id: SquireId.make("squire-2"), create_request_id: "fixture:research" }),
            ),
          ),
        );
      }),
    );

    it.effect("keys tool calls by invocation and executions by execution key", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        const called = actionLog({ invocation_key: "invocation-1" });
        yield* repository.insertActionLog(called);
        assert.isTrue(yield* uniqueViolation(repository.insertActionLog(called)));

        const executed = actionLog({ kind: "action.executed", execution_key: "execution-1" });
        yield* repository.insertActionLog(executed);
        assert.isTrue(yield* uniqueViolation(repository.insertActionLog(executed)));

        // Other kinds may repeat a key: only the two keyed kinds dedupe.
        yield* repository.insertActionLog(
          actionLog({ kind: "card.raised", invocation_key: "invocation-1" }),
        );
        yield* repository.insertActionLog(
          actionLog({ kind: "card.raised", invocation_key: "invocation-1" }),
        );
      }),
    );

    it.effect("makes the budget usage execution key unique, seeded rows aside", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        const usage = {
          squire_id: squireId,
          thread_id: threadId,
          kind: "steer",
          room_id: null,
          executed_at: now,
          execution_key: "execution-1",
        } as const;
        yield* repository.insertBudgetUsage(usage);
        assert.isTrue(yield* uniqueViolation(repository.insertBudgetUsage(usage)));
        yield* repository.insertBudgetUsage({ ...usage, execution_key: null });
        yield* repository.insertBudgetUsage({ ...usage, execution_key: null });
      }),
    );

    it.effect("makes the room post message key unique", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        const first = yield* repository.insertRoomPost(roomPost());
        assert.isTrue(
          yield* uniqueViolation(repository.insertRoomPost(roomPost({ body: "Again" }))),
        );
        assert.isAbove(
          yield* repository.insertRoomPost(roomPost({ message_key: "invocation-2" })),
          first,
        );
      }),
    );

    it.effect("makes rules unique per target and steer kind, null steer kind included", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        yield* repository.insertRule(rule());
        assert.isTrue(
          yield* uniqueViolation(repository.insertRule(rule({ id: SquireRuleId.make("rule-2") }))),
        );
        yield* repository.insertRule(
          rule({ id: SquireRuleId.make("rule-3"), steer_kind: "rerun" }),
        );
        assert.isTrue(
          yield* uniqueViolation(
            repository.insertRule(rule({ id: SquireRuleId.make("rule-4"), steer_kind: "rerun" })),
          ),
        );
        yield* repository.insertRule(
          rule({ id: SquireRuleId.make("rule-5"), effect: "ask-first" }),
        );
      }),
    );

    it.effect("reads a missing cursor as disabled at zero and writes it back", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* fixture;
        yield* sql`DELETE FROM squire_reactor_cursor`;
        assert.deepStrictEqual(yield* repository.readCursor, { sequence: 0, enabled: false });
        yield* repository.writeCursor({ sequence: 42, enabled: true });
        assert.deepStrictEqual(yield* repository.readCursor, { sequence: 42, enabled: true });
      }),
    );

    it.effect("lists Squires oldest first and finds the Lead and a create request", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        yield* repository.createSquire(squire({ created_at: "2026-10-02T00:00:00.000Z" }));
        yield* repository.createSquire(
          squire({ id: leadId, role: "lead", create_request_id: "request-lead" }),
        );
        assert.deepStrictEqual(
          (yield* repository.listSquires).map((row) => row.id),
          [leadId, squireId],
        );
        assert.equal(Option.getOrThrow(yield* repository.getLead).id, leadId);
        assert.equal(
          Option.getOrThrow(yield* repository.getSquireByCreateRequestId("request-lead")).id,
          leadId,
        );
        assert.isTrue(Option.isNone(yield* repository.getSquireByCreateRequestId("missing")));
      }),
    );

    it.effect("updates a Squire with a revision compare-and-set", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        yield* repository.createSquire(squire());
        const later = "2026-10-03T00:00:00.000Z";

        const renamed = yield* repository.updateSquire({
          id: squireId,
          expectedRevision: 0,
          patch: { name: "Renamed", status: "paused" },
          updatedAt: later,
        });
        assert.deepInclude(Option.getOrThrow(renamed), {
          name: "Renamed",
          status: "paused",
          revision: 1,
          updated_at: later,
        });

        const stale = yield* repository.updateSquire({
          id: squireId,
          expectedRevision: 0,
          patch: { name: "Stale" },
          updatedAt: later,
        });
        assert.isTrue(Option.isNone(stale));

        // Without an expected revision it always applies; a spread row cannot
        // rewrite the immutable columns.
        const spread = yield* repository.updateSquire({
          id: squireId,
          patch: { ...squire({ id: SquireId.make("other"), revision: 9 }), brief: "New" },
          updatedAt: later,
        });
        assert.deepInclude(Option.getOrThrow(spread), { id: squireId, revision: 2, brief: "New" });
        assert.isTrue(
          Option.isNone(
            yield* repository.updateSquire({
              id: SquireId.make("missing"),
              patch: {},
              updatedAt: later,
            }),
          ),
        );
      }),
    );

    it.effect("deletes every row of a Squire, keeps shared rows, and is idempotent", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* fixture;
        yield* repository.createSquire(squire());
        yield* repository.createSquire(squire({ id: otherId, created_at: "2026-10-02" }));
        for (const owner of [squireId, otherId]) {
          yield* repository.insertGrant(grant({ squire_id: owner }));
          yield* repository.insertEvent(event({ squire_id: owner }));
          yield* repository.insertBudgetUsage(usage({ squire_id: owner }));
          yield* repository.insertActionLog(actionLog({ squire_id: owner }));
          yield* repository.insertRule(
            rule({ id: SquireRuleId.make(`rule-${owner}`), squire_id: owner }),
          );
        }
        yield* repository.insertCard(card({ id: SquireCardId.make("raised") }));
        // Raised by the other Squire but owned by this one.
        yield* repository.insertCard(
          card({ id: SquireCardId.make("owned"), squire_id: otherId, kind: "question" }),
        );
        yield* repository.insertCard(
          card({ id: SquireCardId.make("kept"), squire_id: otherId, owner_squire_id: otherId }),
        );
        yield* seedTrigger("hook", squireId, "secret:hook");
        yield* seedTrigger("schedule", squireId, null);
        yield* seedTrigger("other-hook", otherId, "secret:other");
        yield* repository.insertSummary({
          thread_id: threadId,
          run_id: RunId.make("run-1"),
          stage: "terminal",
          status: "complete",
          summary_json: "{}",
          payer_squire_id: squireId,
          created_at: now,
          updated_at: now,
        });
        yield* seedRoom("pair", [
          ["squire", squireId],
          ["squire", otherId],
          ["user", "user"],
        ]);
        yield* seedRoom("trio", [
          ["squire", squireId],
          ["squire", otherId],
          ["lead", leadId],
        ]);
        yield* seedRoom("bystander", [["squire", otherId]]);

        const deleted = yield* repository.deleteSquireRows(squireId);
        assert.deepStrictEqual(deleted.triggerSecretRefs, ["secret:hook"]);

        assert.isTrue(Option.isNone(yield* repository.getSquire(squireId)));
        for (const table of [
          "squire",
          "squire_grant",
          "squire_event",
          "squire_budget_usage",
          "squire_action_log",
          "squire_rule",
          "squire_trigger",
        ]) {
          const owners = yield* sql<{ owner: string }>`
            SELECT ${sql(table === "squire" ? "id" : "squire_id")} AS owner FROM ${sql(table)}`;
          assert.deepStrictEqual(
            owners.map((row) => row.owner),
            [otherId],
            table,
          );
        }
        assert.deepStrictEqual(cardIds(yield* repository.listCards({})), ["kept"]);
        const summary = yield* repository.getSummary({
          thread_id: threadId,
          run_id: RunId.make("run-1"),
          stage: "terminal",
        });
        assert.isNull(Option.getOrThrow(summary).payer_squire_id);

        const rooms = yield* sql<{ id: string; status: string; closed_reason: string | null }>`
          SELECT id, status, closed_reason FROM squire_room ORDER BY id`;
        assert.deepStrictEqual(rooms, [
          { id: "bystander", status: "open", closed_reason: null },
          { id: "pair", status: "closed", closed_reason: "members" },
          { id: "trio", status: "open", closed_reason: null },
        ]);
        const members = yield* sql<{ n: number }>`
          SELECT count(*) AS n FROM squire_room_member WHERE member_id = ${squireId}`;
        assert.equal(members[0]?.n, 0);

        assert.deepStrictEqual(yield* repository.deleteSquireRows(squireId), {
          triggerSecretRefs: [],
        });
      }),
    );

    it.effect("keeps one grant per key and deletes by key or target", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        assert.isTrue(yield* repository.insertGrant(grant()));
        assert.isFalse(yield* repository.insertGrant(grant({ origin: "created" })));
        yield* repository.insertGrant(grant({ squire_id: otherId }));
        yield* repository.insertGrant(grant({ kind: "project", target_id: "project-1" }));

        assert.deepStrictEqual(
          (yield* repository.listGrants(squireId)).map((row) => [row.kind, row.origin]),
          [
            ["thread", "granted"],
            ["project", "granted"],
          ],
        );
        const target = { kind: "thread", targetId: threadId } as const;
        assert.lengthOf(yield* repository.listGrantsForTarget(target), 2);

        assert.isTrue(yield* repository.deleteGrant({ squireId, ...target }));
        assert.isFalse(yield* repository.deleteGrant({ squireId, ...target }));
        assert.equal(yield* repository.deleteGrantsForTarget(target), 1);
        assert.equal(yield* repository.deleteGrantsForTarget(target), 0);
      }),
    );

    it.effect("drops only the Squire's deferred events, up to a cutoff when given", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* fixture;
        yield* repository.insertEvent(event({ status: "deferred", state_key: "old" }));
        yield* repository.insertEvent(
          event({ status: "deferred", state_key: "new", created_at: "2026-10-05" }),
        );
        yield* repository.insertEvent(event({ status: "pending", state_key: "pending" }));
        yield* repository.insertEvent(
          event({ squire_id: otherId, status: "deferred", state_key: "other" }),
        );

        assert.equal(yield* repository.dropDeferredEvents(squireId, "2026-10-02"), 1);
        assert.equal(yield* repository.dropDeferredEvents(squireId), 1);
        assert.equal(yield* repository.dropDeferredEvents(squireId), 0);
        const rows = yield* sql<{ state_key: string; status: string }>`
          SELECT state_key, status FROM squire_event ORDER BY state_key`;
        assert.deepStrictEqual(rows, [
          { state_key: "new", status: "dropped" },
          { state_key: "old", status: "dropped" },
          { state_key: "other", status: "deferred" },
          { state_key: "pending", status: "pending" },
        ]);
      }),
    );

    it.effect("filters cards and updates them only from an expected status", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        const other = ThreadId.make("thread-2");
        yield* repository.insertCard(card());
        yield* repository.insertCard(
          card({ id: SquireCardId.make("card-2"), kind: "question", status: "held" }),
        );
        yield* repository.insertCard(
          card({
            id: SquireCardId.make("card-3"),
            owner_squire_id: otherId,
            target_thread_id: other,
          }),
        );

        assert.deepStrictEqual(cardIds(yield* repository.listCards({ statuses: ["open"] })), [
          "card-1",
          "card-3",
        ]);
        assert.deepStrictEqual(cardIds(yield* repository.listCards({ ownerSquireId: otherId })), [
          "card-3",
        ]);
        assert.deepStrictEqual(
          cardIds(yield* repository.listCards({ targetThreadId: threadId, kinds: ["question"] })),
          ["card-2"],
        );
        assert.deepStrictEqual(yield* repository.listCards({ statuses: [] }), []);

        const later = "2026-10-03T00:00:00.000Z";
        const accepting = yield* repository.updateCard({
          id: SquireCardId.make("card-1"),
          fromStatuses: ["open"],
          patch: { status: "accepting", attempt: 1, command_id: "server:squire:accept:card-1:1" },
          updatedAt: later,
        });
        assert.deepInclude(Option.getOrThrow(accepting), {
          status: "accepting",
          attempt: 1,
          updated_at: later,
        });
        const replay = yield* repository.updateCard({
          id: SquireCardId.make("card-1"),
          fromStatuses: ["open"],
          patch: { status: "accepting" },
          updatedAt: later,
        });
        assert.isTrue(Option.isNone(replay));
        assert.equal(
          Option.getOrThrow(yield* repository.getCard(SquireCardId.make("card-1"))).attempt,
          1,
        );
        assert.isTrue(Option.isNone(yield* repository.getCard(SquireCardId.make("missing"))));
      }),
    );

    it.effect("outdates open and held cards on a thread, settled ones aside", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        yield* repository.insertCard(card());
        yield* repository.insertCard(card({ id: SquireCardId.make("card-2"), status: "held" }));
        yield* repository.insertCard(card({ id: SquireCardId.make("card-3"), status: "executed" }));
        yield* repository.insertCard(
          card({ id: SquireCardId.make("card-4"), target_thread_id: ThreadId.make("thread-2") }),
        );

        const outdated = yield* repository.outdateCardsForThread({
          threadId,
          resolution: "thread-deleted",
          updatedAt: now,
        });
        assert.sameMembers([...outdated], ["card-1", "card-2"]);
        assert.deepStrictEqual(
          (yield* repository.listCards({ statuses: ["outdated"] })).map((row) => row.resolution),
          ["thread-deleted", "thread-deleted"],
        );
        assert.deepStrictEqual(
          yield* repository.outdateCardsForThread({ threadId, resolution: "x", updatedAt: now }),
          [],
        );
      }),
    );

    it.effect("opens held cards on pause, and a hold whose open slot is taken is superseded", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        const other = ThreadId.make("thread-2");
        yield* repository.insertCard(card());
        yield* repository.insertCard(
          card({ id: SquireCardId.make("blocked"), status: "held", executes_at: now }),
        );
        yield* repository.insertCard(
          card({
            id: SquireCardId.make("older"),
            status: "held",
            target_thread_id: other,
            executes_at: now,
          }),
        );
        yield* repository.insertCard(
          card({
            id: SquireCardId.make("newer"),
            status: "held",
            target_thread_id: other,
            executes_at: now,
            created_at: "2026-10-02T00:00:00.000Z",
          }),
        );
        // Raised by the Lead for this Squire's thread.
        yield* repository.insertCard(
          card({
            id: SquireCardId.make("owned"),
            squire_id: leadId,
            status: "held",
            executes_at: now,
          }),
        );
        yield* repository.insertCard(
          card({
            id: SquireCardId.make("unrelated"),
            squire_id: otherId,
            owner_squire_id: otherId,
            status: "held",
          }),
        );

        const later = "2026-10-03T00:00:00.000Z";
        const opened = yield* repository.openHeldCards({ squireId, updatedAt: later });
        assert.sameMembers([...opened], ["newer", "owned"]);

        const status = (id: string) =>
          repository.getCard(SquireCardId.make(id)).pipe(
            Effect.map(Option.getOrThrow),
            Effect.map((row) => [row.status, row.executes_at, row.resolution]),
          );
        assert.deepStrictEqual(yield* status("newer"), ["open", null, null]);
        assert.deepStrictEqual(yield* status("owned"), ["open", null, null]);
        assert.deepStrictEqual(yield* status("blocked"), ["outdated", now, "superseded"]);
        assert.deepStrictEqual(yield* status("older"), ["outdated", now, "superseded"]);
        assert.deepStrictEqual(yield* status("unrelated"), ["held", null, null]);
        assert.deepStrictEqual(yield* repository.openHeldCards({ squireId, updatedAt: later }), []);
      }),
    );

    it.effect("pages the action log forward and finds tool calls and executions by key", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        const called = yield* repository.insertActionLog(actionLog({ invocation_key: "inv-1" }));
        yield* repository.insertActionLog(
          actionLog({ kind: "card.raised", invocation_key: "inv-2" }),
        );
        const executed = yield* repository.insertActionLog(
          actionLog({ kind: "action.executed", execution_key: "exec-1" }),
        );
        yield* repository.insertActionLog(actionLog({ squire_id: otherId }));

        const page = yield* repository.listActionLog({ squireId, limit: 2 });
        assert.deepStrictEqual(
          page.map((row) => row.kind),
          ["tool.called", "card.raised"],
        );
        const next = yield* repository.listActionLog({
          squireId,
          afterId: page[1]?.id ?? 0,
          limit: 2,
        });
        assert.deepStrictEqual(
          next.map((row) => row.id),
          [executed],
        );
        assert.deepStrictEqual(
          (yield* repository.listActionLog({ squireId, kinds: ["card.raised"], limit: 10 })).map(
            (row) => row.invocation_key,
          ),
          ["inv-2"],
        );
        assert.deepStrictEqual(
          yield* repository.listActionLog({ squireId, kinds: [], limit: 10 }),
          [],
        );

        assert.equal(Option.getOrThrow(yield* repository.getToolCall("inv-1")).id, called);
        // Only the keyed kind answers: a card.raised row carrying the key is not a tool call.
        assert.isTrue(Option.isNone(yield* repository.getToolCall("inv-2")));
        assert.equal(Option.getOrThrow(yield* repository.getExecution("exec-1")).id, executed);
        assert.isTrue(Option.isNone(yield* repository.getExecution("missing")));
      }),
    );

    it.effect("lists, counts, disables, and removes rules", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        yield* repository.insertRule(rule());
        yield* repository.insertRule(
          rule({ id: SquireRuleId.make("rule-2"), steer_kind: "rebase", status: "disabled" }),
        );
        yield* repository.insertRule(
          rule({ id: SquireRuleId.make("rule-3"), effect: "ask-first" }),
        );

        assert.equal(yield* repository.countRules({ squireId, effect: "allow" }), 2);
        assert.equal(yield* repository.countRules({ squireId, effect: "ask-first" }), 1);
        assert.deepStrictEqual(
          (yield* repository.listRules({ squireId, status: "active" })).map((row) => row.id),
          ["rule-1", "rule-3"],
        );

        const ids = [SquireRuleId.make("rule-1"), SquireRuleId.make("rule-2")];
        assert.equal(yield* repository.setRuleStatus({ ids, status: "disabled" }), 1);
        assert.equal(yield* repository.setRuleStatus({ ids: [], status: "active" }), 0);
        assert.lengthOf(yield* repository.listRules({ squireId, status: "disabled" }), 2);

        assert.equal(
          Option.getOrThrow(yield* repository.getRule(SquireRuleId.make("rule-3"))).effect,
          "ask-first",
        );
        assert.isTrue(yield* repository.deleteRule(SquireRuleId.make("rule-1")));
        assert.isFalse(yield* repository.deleteRule(SquireRuleId.make("rule-1")));
        assert.isTrue(Option.isNone(yield* repository.getRule(SquireRuleId.make("rule-1"))));
        assert.lengthOf(yield* repository.listRules({ squireId }), 2);
      }),
    );

    it.effect("lists budget usage inside a window", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        yield* repository.insertBudgetUsage(usage({ executed_at: "2026-10-02T00:00:00.000Z" }));
        yield* repository.insertBudgetUsage(usage({ executed_at: "2026-09-30T00:00:00.000Z" }));
        yield* repository.insertBudgetUsage(usage({ executed_at: now, kind: "thread" }));
        yield* repository.insertBudgetUsage(usage({ squire_id: otherId }));

        const rows = yield* repository.listBudgetUsage({ squireId, since: now });
        assert.deepStrictEqual(
          rows.map((row) => [row.kind, row.executed_at]),
          [
            ["thread", now],
            ["steer", "2026-10-02T00:00:00.000Z"],
          ],
        );
      }),
    );

    it.effect("publishes a change after a write commits", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* fixture;
          const changes = yield* repository.subscribeChanges;
          yield* repository.insertRule(rule());
          const seen = yield* changes.pipe(Stream.take(1), Stream.runCollect);
          assert.equal(seen.length, 1);
        }),
      ),
    );

    it.effect("bumps the change generation once per committed change", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        const before = yield* repository.changeGeneration;
        yield* repository.transaction(
          Effect.gen(function* () {
            yield* repository.insertRule(rule());
            // Inside the transaction nothing is published yet.
            assert.equal(yield* repository.changeGeneration, before);
            yield* repository.setRuleStatus({ ids: [rule().id], status: "disabled" });
          }),
        );
        assert.equal(yield* repository.changeGeneration, before + 1);
        // A write that changes nothing publishes nothing.
        yield* repository.setRuleStatus({ ids: [rule().id], status: "disabled" });
        assert.equal(yield* repository.changeGeneration, before + 1);
      }),
    );

    it.effect("prunes old finished history and keeps keys, memory, and live rows", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* fixture;
        const old = "2026-08-01T00:00:00.000Z";
        const cutoff = "2026-09-01T00:00:00.000Z";
        // Events: finished and old go, except PR keys; unfinished never go.
        yield* repository.insertEvent(
          event({ state_key: "old", status: "delivered", created_at: old }),
        );
        yield* repository.insertEvent(
          event({ state_key: "dropped", status: "dropped", created_at: old }),
        );
        yield* repository.insertEvent(
          event({ state_key: "deferred", status: "deferred", created_at: old }),
        );
        yield* repository.insertEvent(event({ state_key: "recent", status: "delivered" }));
        yield* repository.insertEvent(
          event({
            kind: "pull-request-changed",
            state_key: "pr:1:sha:failed",
            status: "delivered",
            created_at: old,
          }),
        );
        // Cards: settled and old go, except dismissals that are memory; live cards stay.
        const settled = (id: string, overrides: Partial<SquireRepository.SquireCardRow>) =>
          repository.insertCard(
            card({
              id: SquireCardId.make(id),
              target_thread_id: ThreadId.make(id),
              updated_at: old,
              ...overrides,
            }),
          );
        yield* settled("outdated", { status: "outdated" });
        yield* settled("executed", { status: "executed" });
        yield* settled("dismissed-fyi", { status: "dismissed", kind: "fyi" });
        yield* settled("dismissed-overlap", { status: "dismissed", kind: "overlap" });
        yield* settled("resolved-overlap", { status: "resolved", kind: "overlap" });
        yield* settled("dismissed-finding", { status: "dismissed", finding_key: "t:checks:sha" });
        yield* settled("open-old", { status: "open" });
        yield* settled("settled-recently", { status: "outdated", updated_at: now });
        // Action log: old rows go unless their card survives or they mark a branch boundary.
        yield* repository.insertActionLog(actionLog({ kind: "x", created_at: old }));
        yield* repository.insertActionLog(
          actionLog({
            kind: "card.created",
            card_id: SquireCardId.make("outdated"),
            created_at: old,
          }),
        );
        yield* repository.insertActionLog(
          actionLog({
            kind: "card.created",
            card_id: SquireCardId.make("open-old"),
            created_at: old,
          }),
        );
        for (const branch of ["a", "b", "c"]) {
          yield* repository.insertActionLog(
            actionLog({
              kind: "overlap.branch",
              thread_id: threadId,
              data_json: branch,
              created_at: old,
            }),
          );
        }
        yield* repository.insertActionLog(actionLog({ kind: "y" }));
        // Budget usage and closed rooms' posts.
        yield* repository.insertBudgetUsage(usage({ executed_at: old }));
        yield* repository.insertBudgetUsage(usage());
        yield* seedRoom("room-closed", []);
        yield* seedRoom("room-open", []);
        yield* sql`UPDATE squire_room SET status = 'closed', updated_at = ${old} WHERE id = 'room-closed'`;
        yield* repository.insertRoomPost(
          roomPost({ room_id: SquireRoomId.make("room-closed"), message_key: "c" }),
        );
        yield* repository.insertRoomPost(
          roomPost({ room_id: SquireRoomId.make("room-open"), message_key: "o", created_at: old }),
        );

        const counts = yield* repository.pruneHistory({
          eventsBefore: cutoff,
          cardsBefore: cutoff,
          actionLogBefore: cutoff,
          budgetUsageBefore: cutoff,
          closedRoomPostsBefore: cutoff,
        });
        assert.deepStrictEqual(counts, {
          events: 2,
          cards: 3,
          actionLog: 3,
          budgetUsage: 1,
          roomPosts: 1,
        });

        const keys = yield* sql<{
          state_key: string;
        }>`SELECT state_key FROM squire_event ORDER BY id`;
        assert.deepStrictEqual(
          keys.map((row) => row.state_key),
          ["deferred", "recent", "pr:1:sha:failed"],
        );
        // The kept PR key still dedupes.
        assert.isFalse(
          yield* repository.insertEvent(
            event({ kind: "pull-request-changed", state_key: "pr:1:sha:failed" }),
          ),
        );
        const cards = yield* sql<{ id: string }>`SELECT id FROM squire_card ORDER BY id`;
        assert.deepStrictEqual(
          cards.map((row) => row.id),
          [
            "dismissed-finding",
            "dismissed-overlap",
            "open-old",
            "resolved-overlap",
            "settled-recently",
          ],
        );
        const logs = yield* sql<{ kind: string; data_json: string }>`
          SELECT kind, data_json FROM squire_action_log ORDER BY id`;
        assert.deepStrictEqual(logs, [
          { kind: "card.created", data_json: "{}" },
          { kind: "overlap.branch", data_json: "b" },
          { kind: "overlap.branch", data_json: "c" },
          { kind: "y", data_json: "{}" },
        ]);
        const posts = yield* sql<{ room_id: string }>`SELECT room_id FROM squire_room_post`;
        assert.deepStrictEqual(posts, [{ room_id: "room-open" }]);
      }),
    );

    it.effect("lists recently summarized threads, newest first, within a limit", () =>
      Effect.gen(function* () {
        const repository = yield* fixture;
        const summary = (
          thread: string,
          run: string,
          at: string,
          status: SquireRepository.SquireSummaryRow["status"] = "complete",
        ) =>
          repository.insertSummary({
            thread_id: ThreadId.make(thread),
            run_id: RunId.make(run),
            stage: "terminal",
            status,
            summary_json: "{}",
            payer_squire_id: null,
            created_at: at,
            updated_at: at,
          });
        yield* summary("quiet", "run-1", "2026-08-01T00:00:00.000Z");
        yield* summary("busy", "run-1", "2026-09-20T00:00:00.000Z");
        yield* summary("busy", "run-2", "2026-09-30T00:00:00.000Z");
        yield* summary("newer", "run-1", "2026-09-25T00:00:00.000Z");
        yield* summary("generating", "run-1", "2026-09-29T00:00:00.000Z", "generating");
        const since = "2026-09-01T00:00:00.000Z";
        assert.deepStrictEqual(
          yield* repository.listRecentlySummarizedThreadIds({ since, limit: 10 }),
          [ThreadId.make("busy"), ThreadId.make("newer")],
        );
        assert.deepStrictEqual(
          yield* repository.listRecentlySummarizedThreadIds({ since, limit: 1 }),
          [ThreadId.make("busy")],
        );
        assert.equal(yield* repository.deleteThreadSummaries(ThreadId.make("busy")), 2);
        assert.deepStrictEqual(
          yield* repository.listRecentlySummarizedThreadIds({ since, limit: 10 }),
          [ThreadId.make("newer")],
        );
      }),
    );

    it.effect("lists open rooms and rooms closed since the cutoff", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* fixture;
        yield* seedRoom("room-open", []);
        yield* seedRoom("room-closed-recently", []);
        yield* seedRoom("room-closed-long-ago", []);
        yield* sql`UPDATE squire_room SET status = 'closed', updated_at = '2026-09-30T00:00:00.000Z'
          WHERE id = 'room-closed-recently'`;
        yield* sql`UPDATE squire_room SET status = 'closed', updated_at = '2026-08-01T00:00:00.000Z'
          WHERE id = 'room-closed-long-ago'`;
        const rows = yield* repository.listRoomRows({ closedSince: "2026-09-24T00:00:00.000Z" });
        assert.deepStrictEqual(rows.map((row) => row.id).toSorted(), [
          "room-closed-recently",
          "room-open",
        ]);
      }),
    );

    it.effect("plans queue and overlap reads on their indexes", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* fixture;
        const plan = (query: string) =>
          sql
            .unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
            .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("; ")));
        // The literal term the repository adds lets SQLite use the partial index.
        // Bound like the repository's own query, so the plan sees parameters.
        const bound = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
          SELECT * FROM squire_card WHERE status IN ('open', 'held')
            AND status IN ${sql.in(["open"])} ORDER BY created_at`;
        assert.include(bound.map((row) => row.detail).join("; "), "squire_card_live");
        assert.include(
          yield* plan(
            "SELECT id FROM squire_card WHERE status IN ('open', 'held') AND status = 'held' AND (squire_id = 'a' OR owner_squire_id = 'a')",
          ),
          "squire_card_live",
        );
        const recent = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
          SELECT thread_id FROM squire_summary
          WHERE updated_at >= ${now} AND status != 'generating'
          GROUP BY +thread_id ORDER BY max(updated_at) DESC, thread_id LIMIT ${10}`;
        assert.include(recent.map((row) => row.detail).join("; "), "squire_summary_recent");
      }),
    );
  },
);
