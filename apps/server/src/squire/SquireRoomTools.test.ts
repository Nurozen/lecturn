/**
 * Room tools (7b.6, `squire_read_room` of 7b.5) on the real switch-on Squire
 * layer: a Squire's proposal to the Lead, the Lead's open in every Manage
 * Squires cell and its P19.6 refusals, proposal expiry, the Auto open across
 * a crash, and reading a room.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  SquireCardId,
  type SquireId,
  SquireRoomId,
  type SquireRoomPostId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as SquireActions from "./SquireActions.ts";
import { decodeSquireActionIntent, isRoomOpenIntent } from "./squireActionIntent.ts";
import * as SquireLeadRpc from "./SquireLeadRpc.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRooms from "./SquireRooms.ts";
import * as SquireRoomStore from "./SquireRoomStore.ts";
import { ROOM_READ_MAX_CHARS, SquireRoomTools } from "./SquireRoomTools.ts";
import type { SquireToolResult } from "./squireToolKit.ts";
import {
  type RoomCast,
  type RoomCastOptions,
  callTool,
  currencyThread,
  invoiceThread,
  need,
  withRoomCast,
} from "./testkit/roomHarness.ts";

// The server's backstop would run holds and expiry on its own as the test clock moves.
const noTicks = Layer.succeed(
  Scheduler.Scheduler,
  Scheduler.Scheduler.of({ register: () => Effect.void }),
);
const withCast = <A, E>(
  body: Parameters<typeof withRoomCast<A, E>>[0],
  options: RoomCastOptions = {},
) => withRoomCast(body, { scheduler: noTicks, ...options });

const repo = need(SquireRepository.SquireRepository);
const roomStore = need(SquireRoomStore.SquireRoomStore);
const actions = need(SquireActions.SquireActions);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const bothAbout = [
  { kind: "thread", threadId: invoiceThread },
  { kind: "thread", threadId: currencyThread },
];

let counter = 0;
const openArgs = (cast: RoomCast, extra: Record<string, unknown> = {}) => ({
  members: [cast.release.squireId, cast.research.squireId],
  topic: "Currency rounding",
  about: bothAbout,
  reason: `Both threads touch rounding (${++counter}).`,
  ...extra,
});
const openRoom = (cast: RoomCast, extra: Record<string, unknown> = {}) =>
  callTool(cast.lead, "lead", "squire_open_room", openArgs(cast, extra));
const propose = (cast: RoomCast, extra: Record<string, unknown> = {}) =>
  callTool(cast.research, "squire", "squire_propose_room", {
    members: [cast.release.squireId, cast.research.squireId],
    topic: "Currency rounding",
    about: bothAbout,
    reason: `Both threads touch rounding (${++counter}).`,
    ...extra,
  });

const structured = (result: SquireToolResult) =>
  result.structuredContent as Record<string, string | undefined>;
const cardIdOf = (result: SquireToolResult) => {
  assert.isFalse(result.isError, result.text);
  return SquireCardId.make(structured(result).cardId!);
};
const cardOf = (cardId: SquireCardId) =>
  Effect.flatMap(repo, (repository) =>
    repository.getCard(cardId).pipe(Effect.map(Option.getOrThrow)),
  );
const openRooms = Effect.flatMap(roomStore, (store) => store.listRooms({ status: "open" }));
const squireMembers = (roomId: SquireRoomId) =>
  Effect.flatMap(roomStore, (store) =>
    store
      .listMembers(roomId)
      .pipe(
        Effect.map((rows) =>
          rows.filter((row) => row.member_kind === "squire").map((row) => row.member_id),
        ),
      ),
  );
const logOf = (squireId: SquireId, kind: string) =>
  Effect.gen(function* () {
    const rows = yield* (yield* repo).listActionLog({ squireId, kinds: [kind], limit: 500 });
    return rows.map((row) => ({ ...row, data: JSON.parse(row.data_json) as Record<string, any> }));
  });
const executionsOf = (cast: RoomCast, cardId: SquireCardId) =>
  Effect.map(logOf(cast.lead.squireId, "action.executed"), (rows) =>
    rows.filter((row) => row.card_id === cardId),
  );
const accept = (cardId: SquireCardId) =>
  Effect.flatMap(actions, (service) =>
    service.act({ requestId: `accept-${++counter}`, cardIds: [cardId], action: "accept" }),
  );
const executeDue = Effect.flatMap(actions, (service) => service.executeDue);
/** Moves the clock just past the hold's `executes_at`. */
const passHold = (cardId: SquireCardId) =>
  Effect.gen(function* () {
    const card = yield* cardOf(cardId);
    const wait = Date.parse(card.executes_at!) - DateTime.toEpochMillis(yield* DateTime.now);
    yield* TestClock.adjust(`${wait + 1000} millis`);
  });
const setBotMessages = (on: boolean) =>
  Effect.flatMap(ServerSettingsService, (settings) =>
    settings.updateSettings({ squire: { botMessages: on } }),
  );

describe("squire_propose_room (P19.6, D54)", () => {
  it.effect("is refused with the Lead's Manage Squires Off or the switch Off", () =>
    Effect.gen(function* () {
      yield* withCast(
        (cast) =>
          Effect.gen(function* () {
            const result = yield* propose(cast);
            assert.isTrue(result.isError);
            assert.include(result.text, "Manage Squires is Off");
          }),
        { leadManageSquires: "off" },
      );
      yield* withCast((cast) =>
        Effect.gen(function* () {
          yield* setBotMessages(false);
          const result = yield* propose(cast);
          assert.isTrue(result.isError);
          assert.include(result.text, "messages are off");
          const rows = yield* (yield* repo).listEvents({
            statuses: ["pending", "batched", "delivered", "dropped", "deferred"],
            kinds: ["room-proposed"],
          });
          assert.lengthOf(rows, 0);
        }),
      );
    }),
  );

  it.effect("otherwise writes one room-proposed row on the Lead and logs it", () =>
    withCast((cast) =>
      Effect.gen(function* () {
        const args = {
          members: [cast.release.squireId, cast.research.squireId],
          topic: "Currency rounding",
          about: bothAbout,
          reason: "Both threads touch rounding.",
        };
        const result = yield* callTool(cast.research, "squire", "squire_propose_room", args);
        assert.isFalse(result.isError, result.text);
        const proposalId = structured(result).proposalId!;
        assert.match(proposalId, /^proposal:/);
        // A retried call (same key) writes nothing more.
        yield* callTool(cast.research, "squire", "squire_propose_room", args);
        const row = yield* (yield* repo).getEventByKey({
          squireId: cast.lead.squireId,
          kind: "room-proposed",
          threadId: null,
          stateKey: proposalId,
        });
        assert.isTrue(Option.isSome(row));
        const payload = JSON.parse(Option.getOrThrow(row).payload_json!);
        assert.strictEqual(payload.type, "room-proposed");
        assert.strictEqual(payload.fromSquireId, cast.research.squireId);
        const logged = yield* logOf(cast.lead.squireId, "room.proposed");
        assert.lengthOf(logged, 1);
        assert.strictEqual(logged[0]!.data.proposalId, proposalId);
      }),
    ),
  );

  it.effect("an unanswered proposal expires once after 24 h and can no longer be opened", () =>
    withCast(
      (cast) =>
        Effect.gen(function* () {
          const tools = yield* need(SquireRoomTools);
          const proposalId = structured(yield* propose(cast)).proposalId!;
          const key = {
            squireId: cast.lead.squireId,
            kind: "room-proposed",
            threadId: null,
            stateKey: proposalId,
          };
          const before = Option.getOrThrow(yield* (yield* repo).getEventByKey(key));
          const due = Option.getOrThrow(yield* tools.nextExpiryAt);
          assert.strictEqual(
            DateTime.toEpochMillis(due) - Date.parse(before.created_at),
            24 * 60 * 60 * 1000,
          );

          yield* TestClock.adjust("23 hours");
          yield* tools.expireProposals(yield* DateTime.now);
          assert.lengthOf(
            (yield* logOf(cast.lead.squireId, "room.proposed")).filter(
              (row) => row.data.expired === "true",
            ),
            0,
          );

          yield* TestClock.adjust("1 hour");
          yield* tools.expireProposals(yield* DateTime.now);
          yield* tools.expireProposals(yield* DateTime.now);
          const expired = (yield* logOf(cast.lead.squireId, "room.proposed")).filter(
            (row) => row.data.expired === "true",
          );
          assert.lengthOf(expired, 1);
          assert.strictEqual(expired[0]!.data.proposalId, proposalId);
          const after = Option.getOrThrow(yield* (yield* repo).getEventByKey(key));
          assert.strictEqual(
            after.status,
            before.status === "pending" || before.status === "deferred" ? "dropped" : before.status,
          );
          assert.isTrue(Option.isNone(yield* tools.nextExpiryAt));

          const late = yield* openRoom(cast, { proposalId });
          assert.isTrue(late.isError);
          assert.include(late.text, "expired");
        }),
      { leadManageSquires: "recommend" },
    ),
  );
});

describe("squire_open_room in every Manage Squires cell (P8, P19.6)", () => {
  it.effect("Off refuses and raises nothing", () =>
    withCast(
      (cast) =>
        Effect.gen(function* () {
          const result = yield* openRoom(cast);
          assert.isTrue(result.isError);
          assert.include(result.text, "Manage Squires is Off");
          assert.lengthOf(yield* (yield* repo).listCards({ squireId: cast.lead.squireId }), 0);
          const closed = yield* callTool(cast.lead, "lead", "squire_close_room", {
            roomId: "room:any",
            reason: "Done.",
          });
          assert.isTrue(closed.isError);
          assert.include(closed.text, "Manage Squires is Off");
        }),
      { leadManageSquires: "off" },
    ),
  );

  it.effect("Recommend raises an 'Open room' proposal card; accepting opens the room once", () =>
    withCast(
      (cast) =>
        Effect.gen(function* () {
          const cardId = cardIdOf(yield* openRoom(cast));
          const card = yield* cardOf(cardId);
          assert.strictEqual(card.status, "open");
          assert.strictEqual(card.kind, "proposal");
          assert.strictEqual(card.title, "Open room: Currency rounding");
          assert.strictEqual(JSON.parse(card.payload_json).type, "room-proposal");
          assert.lengthOf(yield* openRooms, 0);

          const [accepted] = (yield* accept(cardId)).results;
          assert.strictEqual(accepted!.status, "resolved", JSON.stringify(accepted));
          yield* accept(cardId);
          const [room, ...others] = yield* openRooms;
          assert.lengthOf(others, 0);
          assert.strictEqual(room!.topic, "Currency rounding");
          assert.strictEqual(room!.creator_kind, "lead");
          assert.sameMembers(yield* squireMembers(room!.id), [
            cast.release.squireId,
            cast.research.squireId,
          ]);
          assert.lengthOf(yield* executionsOf(cast, cardId), 1);
        }),
      { leadManageSquires: "recommend" },
    ),
  );

  it.effect(
    "Auto holds an immutable intent and opens the approved proposal after the undo window",
    () =>
      withCast(
        (cast) =>
          Effect.gen(function* () {
            const proposalId = structured(yield* propose(cast)).proposalId!;
            const cardId = cardIdOf(yield* openRoom(cast, { proposalId }));
            const card = yield* cardOf(cardId);
            assert.strictEqual(card.status, "held");
            assert.strictEqual(card.title, "Open room: Currency rounding");
            assert.strictEqual(card.command_id, `server:squire:execute:${cardId}:1`);
            const intent = Option.getOrThrow(decodeSquireActionIntent(card.intent_json));
            assert.isTrue(isRoomOpenIntent(intent));
            assert.strictEqual(isRoomOpenIntent(intent) ? intent.proposalId : null, proposalId);

            yield* executeDue;
            assert.lengthOf(yield* openRooms, 0);
            yield* passHold(cardId);
            yield* executeDue;
            assert.strictEqual((yield* cardOf(cardId)).status, "executed");
            const [room, ...others] = yield* openRooms;
            assert.lengthOf(others, 0);
            assert.strictEqual(room!.creator_kind, "proposal");
            assert.isNotNull(room!.proposal_event_id);
            assert.lengthOf(yield* executionsOf(cast, cardId), 1);

            // An answered proposal never expires.
            const tools = yield* need(SquireRoomTools);
            yield* TestClock.adjust("25 hours");
            yield* tools.expireProposals(yield* DateTime.now);
            assert.lengthOf(
              (yield* logOf(cast.lead.squireId, "room.proposed")).filter(
                (row) => row.data.expired === "true",
              ),
              0,
            );
          }),
        { leadManageSquires: "auto" },
      ),
  );

  it.effect("an Auto hold that is Recommend by execution goes back to a card, unopened", () =>
    withCast(
      (cast) =>
        Effect.gen(function* () {
          const cardId = cardIdOf(yield* openRoom(cast));
          const repository = yield* repo;
          const lead = Option.getOrThrow(yield* repository.getSquire(cast.lead.squireId));
          yield* repository.updateSquire({
            id: lead.id,
            patch: {
              permissions_json: JSON.stringify({
                ...JSON.parse(lead.permissions_json),
                manageSquires: "recommend",
              }),
            },
            updatedAt: yield* nowIso,
          });
          yield* passHold(cardId);
          yield* executeDue;
          assert.strictEqual((yield* cardOf(cardId)).status, "open");
          assert.lengthOf(yield* openRooms, 0);
        }),
      { leadManageSquires: "auto" },
    ),
  );
});

describe("squire_close_room (P19.6)", () => {
  it.effect("closes an open room at once under Recommend and logs room.closed", () =>
    withCast(
      (cast) =>
        Effect.gen(function* () {
          const rpc = yield* need(SquireLeadRpc.SquireLeadRpc);
          const { room } = yield* rpc.roomCreate({
            requestId: "close-1",
            topic: "Done soon",
            members: [cast.release.squireId, cast.research.squireId],
            includesLead: false,
          });
          const closed = yield* callTool(cast.lead, "lead", "squire_close_room", {
            roomId: room.id,
            reason: "The fix shipped.",
          });
          assert.isFalse(closed.isError, closed.text);
          const row = Option.getOrThrow(yield* (yield* roomStore).getRoom(room.id));
          assert.strictEqual(row.status, "closed");
          const logged = yield* logOf(cast.lead.squireId, "room.closed");
          assert.lengthOf(logged, 1);
          assert.strictEqual(logged[0]!.room_id, room.id);
          const again = yield* callTool(cast.lead, "lead", "squire_close_room", {
            roomId: room.id,
            reason: "Again.",
          });
          assert.isTrue(again.isError);
        }),
      { leadManageSquires: "recommend" },
    ),
  );
});

describe("squire_open_room refusals (P19.6)", () => {
  const refusedWith = (result: SquireToolResult, reason: string) => {
    assert.isTrue(result.isError, result.text);
    assert.strictEqual(structured(result).reason, reason, result.text);
  };

  it.effect("members must be 2-6 active Squires", () =>
    withCast(
      (cast) =>
        Effect.gen(function* () {
          yield* (yield* repo).updateSquire({
            id: cast.research.squireId,
            patch: { status: "paused" },
            updatedAt: yield* nowIso,
          });
          refusedWith(yield* openRoom(cast), "paused");
          refusedWith(
            yield* openRoom(cast, { members: [cast.release.squireId, "squire-missing"] }),
            "members",
          );
          refusedWith(
            yield* openRoom(cast, { members: [cast.release.squireId, cast.lead.squireId] }),
            "members",
          );
          assert.lengthOf(yield* (yield* repo).listCards({ squireId: cast.lead.squireId }), 0);
        }),
      { leadManageSquires: "auto" },
    ),
  );

  it.effect("every member's scope covers an about ref", () =>
    withCast(
      (cast) =>
        Effect.gen(function* () {
          refusedWith(
            yield* openRoom(cast, { about: [{ kind: "thread", threadId: invoiceThread }] }),
            "scope",
          );
        }),
      { leadManageSquires: "auto" },
    ),
  );

  it.effect("the room caps allow it", () =>
    withCast(
      (cast) =>
        Effect.gen(function* () {
          const rpc = yield* need(SquireLeadRpc.SquireLeadRpc);
          for (const n of [1, 2, 3]) {
            yield* rpc.roomCreate({
              requestId: `cap-${n}`,
              topic: `Room ${n}`,
              members: [cast.release.squireId, cast.research.squireId],
              includesLead: false,
            });
          }
          refusedWith(yield* openRoom(cast), "cap");
        }),
      { leadManageSquires: "auto" },
    ),
  );

  it.effect("the environment switch is On", () =>
    withCast(
      (cast) =>
        Effect.gen(function* () {
          yield* setBotMessages(false);
          refusedWith(yield* openRoom(cast), "switch");
        }),
      { leadManageSquires: "auto" },
    ),
  );

  it.effect("no member's message budget is exhausted", () =>
    withCast(
      (cast) =>
        Effect.gen(function* () {
          const repository = yield* repo;
          const now = yield* nowIso;
          for (let n = 0; n < 20; n++) {
            yield* repository.insertBudgetUsage({
              squire_id: cast.research.squireId,
              kind: "message",
              thread_id: null,
              room_id: null,
              executed_at: now,
              execution_key: `message:seed-${n}`,
            });
          }
          refusedWith(yield* openRoom(cast), "budget");
        }),
      { leadManageSquires: "auto" },
    ),
  );
});

describe("an Auto open across a crash (A9)", () => {
  it.effect("committed before its card settled, it finalizes once and opens one room", () =>
    withCast(
      (cast) =>
        Effect.gen(function* () {
          const cardId = cardIdOf(yield* openRoom(cast));
          yield* passHold(cardId);
          const repository = yield* repo;
          const card = yield* cardOf(cardId);
          yield* repository.updateCard({
            id: cardId,
            fromStatuses: ["held"],
            patch: { status: "executing" },
            updatedAt: yield* nowIso,
          });
          const intent = Option.getOrThrow(decodeSquireActionIntent(card.intent_json));
          assert.isTrue(isRoomOpenIntent(intent));
          if (!isRoomOpenIntent(intent)) return;
          // The execution committed, then the server stopped before finalize.
          const rooms = yield* need(SquireRooms.SquireRooms);
          const applied = yield* rooms.applyOpen(intent, {
            executionKey: card.command_id!,
            now: yield* nowIso,
            verb: "execute",
          });
          assert.isTrue(applied.ok);

          yield* (yield* actions).reconcileStartup;
          yield* executeDue;
          yield* executeDue;
          assert.strictEqual((yield* cardOf(cardId)).status, "executed");
          assert.lengthOf(yield* openRooms, 1);
          assert.lengthOf(yield* executionsOf(cast, cardId), 1);
        }),
      { leadManageSquires: "auto" },
    ),
  );

  it.effect("a hold restarted before execution runs once", () =>
    withCast(
      (cast) =>
        Effect.gen(function* () {
          const cardId = cardIdOf(yield* openRoom(cast));
          yield* (yield* actions).reconcileStartup;
          assert.strictEqual((yield* cardOf(cardId)).status, "held");
          yield* passHold(cardId);
          yield* executeDue;
          yield* executeDue;
          assert.strictEqual((yield* cardOf(cardId)).status, "executed");
          assert.lengthOf(yield* openRooms, 1);
          assert.lengthOf(yield* executionsOf(cast, cardId), 1);
        }),
      { leadManageSquires: "auto" },
    ),
  );
});

describe("squire_read_room (P19.2)", () => {
  /** A room of Release and the Lead, seeded straight into the store. */
  const seedRoom = (cast: RoomCast, bodies: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const repository = yield* repo;
      const store = yield* roomStore;
      const now = yield* nowIso;
      const roomId = SquireRoomId.make("room:read");
      const ids: Array<SquireRoomPostId> = [];
      yield* repository.transaction(
        Effect.gen(function* () {
          yield* store.insertRoom({
            id: roomId,
            topic: "Release notes",
            about_json: "[]",
            status: "open",
            muted: 0,
            bot_messaging: "on",
            idle_ttl_seconds: 86_400,
            creator_kind: "user",
            proposal_event_id: null,
            last_post_at: now,
            closed_reason: null,
            create_request_id: "seed-read",
            revision: 0,
            created_at: now,
            updated_at: now,
          });
          for (const member of [cast.release.squireId, cast.research.squireId]) {
            yield* store.addMember({
              room_id: roomId,
              member_kind: "squire",
              member_id: member,
              read_cursor: 0,
              user_seen_cursor: null,
            });
          }
          for (const [n, body] of bodies.entries()) {
            const id = yield* store.insertPost({
              message_key: `seed-post-${n}`,
              room_id: roomId,
              author_kind: "squire",
              author_id: cast.release.squireId,
              body,
              reply_to: null,
              refs_json: "[]",
              hop: 0,
              routing_json: JSON.stringify({
                via: { kind: "rule", rule: "none", match: "" },
                recipients: [],
              }),
              rerouted_from: null,
              created_at: now,
            });
            ids.push(Option.getOrThrow(id));
          }
        }),
      );
      return { roomId, ids };
    });

  it.effect("refuses non-members, serves members and the Lead, newest within 4,000 chars", () =>
    withCast((cast) =>
      Effect.gen(function* () {
        const bodies = ["A", "B", "C", "D", "E"].map((letter) => `${letter}${"x".repeat(1499)}`);
        const { roomId, ids } = yield* seedRoom(cast, bodies);
        const store = yield* roomStore;
        yield* store.removeMember({
          roomId,
          member: { member_kind: "squire", member_id: cast.research.squireId },
        });

        // Idle home threads share the run id "none", so distinct args keep the invocation keys apart.
        const outsider = yield* callTool(cast.research, "squire", "squire_read_room", {
          roomId,
          before: 1_000_000,
        });
        assert.isTrue(outsider.isError);
        assert.include(outsider.text, "not a member");

        const member = yield* callTool(cast.release, "squire", "squire_read_room", { roomId });
        assert.isFalse(member.isError, member.text);
        assert.isAtMost(member.text.length, ROOM_READ_MAX_CHARS);
        assert.include(member.text, "Release notes");
        assert.include(member.text, `post #${ids[4]}`);
        assert.include(member.text, `post #${ids[3]}`);
        assert.notInclude(member.text, `post #${ids[0]} `);
        const before = Number(structured(member).before);
        assert.include(member.text, `before=${before}`);

        const older = yield* callTool(cast.lead, "lead", "squire_read_room", { roomId, before });
        assert.isFalse(older.isError, older.text);
        assert.include(older.text, `post #${ids[2]}`);
        assert.include(older.text, `post #${ids[1]}`);
        assert.notInclude(older.text, `post #${ids[3]}`);

        // Each read is logged.
        const called = (yield* logOf(cast.release.squireId, "tool.called")).filter(
          (row) => row.data.tool === "squire_read_room",
        );
        assert.lengthOf(called, 1);
      }),
    ),
  );
});
