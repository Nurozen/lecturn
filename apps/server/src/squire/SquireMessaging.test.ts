/**
 * `squire_send_message` over the real switch-on stack (Acceptance
 * "Messaging", P19.1, P19.7): Release and Research are Squires, plus the Lead.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  SquireCardId,
  SquireEvent,
  type SquireId,
  type ThreadId,
  isUnknownUnionMember,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SquireLeadRpc from "./SquireLeadRpc.ts";
import { HOP_LIMIT_TEXT } from "./squireMessageGuards.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireService from "./SquireService.ts";
import {
  callTool,
  currencyThread,
  deliver,
  invoiceThread,
  need,
  type RoomCast,
  withRoomCast,
} from "./testkit/roomHarness.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(SquireEvent));
const messageEvent = (json: string | null) => {
  const event = decodeEvent(json);
  if (isUnknownUnionMember(event) || event.type !== "message") throw new Error("not a message");
  return event;
};
const SINCE = "1969-12-31T00:00:00.000Z";
const ALL_STATUSES = ["deferred", "pending", "batched", "delivered", "dropped"] as const;

type Who = RoomCast["release"];

const send = (who: Who, role: "squire" | "lead", args: Record<string, unknown>) =>
  callTool(who, role, "squire_send_message", args);

const structured = (result: { readonly structuredContent?: unknown }) =>
  result.structuredContent as Record<string, unknown>;

const messageRows = (squireId: SquireId) =>
  Effect.gen(function* () {
    const repository = yield* need(SquireRepository.SquireRepository);
    const rows = yield* repository.listEventsByStatus({ squireId, statuses: ALL_STATUSES });
    return rows.filter((row) => row.kind === "message");
  });

const logRows = (squireId: SquireId, kind: string) =>
  Effect.gen(function* () {
    const repository = yield* need(SquireRepository.SquireRepository);
    return yield* repository.listActionLog({ squireId, kinds: [kind], limit: 100 });
  });

const sendCalls = (squireId: SquireId) =>
  Effect.map(logRows(squireId, "tool.called"), (rows) =>
    rows.filter((row) => row.data_json.includes('"squire_send_message"')),
  );

const usage = (squireId: SquireId) =>
  Effect.gen(function* () {
    const repository = yield* need(SquireRepository.SquireRepository);
    return (yield* repository.listBudgetUsage({ squireId, since: SINCE })).filter(
      (row) => row.kind === "message",
    );
  });

const rejectedReasons = (squireId: SquireId) =>
  Effect.map(logRows(squireId, "message.rejected"), (rows) =>
    rows.map((row) => (JSON.parse(row.data_json) as { reason: string }).reason),
  );

const homeMessages = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* need(Orchestrator.OrchestratorV2);
    const projection = yield* orchestrator.getThreadProjection(threadId);
    // A Lead-authored batch has origin `lead` (D56), a Squire-authored one `message`.
    return projection.messages.filter(
      (message) =>
        message.id.startsWith("message:squire:message:") ||
        message.id.startsWith("message:squire:lead:"),
    );
  });

describe("squire_send_message", () => {
  it.effect("commits a direct message once and delivers it to the recipient's home thread", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const args = {
          to: cast.research.squireId,
          body: "Check whether #318 touches the currency formatter",
          refs: [{ kind: "thread", threadId: invoiceThread }],
        };
        const result = yield* send(cast.release, "squire", args);
        assert.isFalse(result.isError, result.text);
        const key = structured(result).messageKey as string;
        assert.include(result.text, "Research");
        assert.include(result.text, key);
        assert.strictEqual(structured(result).hop, 1);

        const [row, ...more] = yield* messageRows(cast.research.squireId);
        assert.lengthOf(more, 0);
        assert.strictEqual(row!.state_key, key);
        // The commit wakes Research, whose delivery may already have batched it.
        assert.include(["pending", "batched", "delivered"], row!.status);
        assert.isNull(row!.thread_id);
        assert.deepInclude(decodeEvent(row!.payload_json), {
          type: "message",
          messageKey: key,
          from: { kind: "squire", squireId: cast.release.squireId },
          hop: 1,
          body: args.body,
          refs: [{ kind: "thread", threadId: invoiceThread }],
        });
        const [charged] = yield* usage(cast.release.squireId);
        assert.strictEqual(charged!.execution_key, `message:${key}`);
        assert.isNull(charged!.room_id);
        assert.lengthOf(yield* usage(cast.research.squireId), 0);
        const [sent] = yield* logRows(cast.release.squireId, "message.sent");
        assert.strictEqual(sent!.event_id, row!.id);
        assert.deepEqual(JSON.parse(sent!.data_json), { to: cast.research.squireId, hop: 1 });
        const [called] = yield* sendCalls(cast.release.squireId);
        assert.strictEqual(called!.invocation_key, key);

        // A retried key returns the stored result and writes nothing.
        const again = yield* send(cast.release, "squire", args);
        assert.deepEqual(again, result);
        assert.lengthOf(yield* messageRows(cast.research.squireId), 1);
        assert.lengthOf(yield* usage(cast.release.squireId), 1);
        assert.lengthOf(yield* logRows(cast.release.squireId, "message.sent"), 1);
        assert.lengthOf(yield* sendCalls(cast.release.squireId), 1);

        yield* deliver(cast.research.squireId);
        const delivered = yield* homeMessages(cast.research.homeThreadId);
        assert.lengthOf(delivered, 1);
        assert.include(delivered[0]!.text, args.body);
        assert.strictEqual(delivered[0]!.senderThreadId, cast.release.homeThreadId);
      }),
    ),
  );

  it.effect("leaves neither tool.called nor the message row when the commit fails", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const sql = yield* need(SqlClient.SqlClient);
        // Fails inside the commit, after the recipient's row was inserted.
        yield* sql.unsafe(
          "CREATE TRIGGER fail_message_usage BEFORE INSERT ON squire_budget_usage BEGIN SELECT RAISE(ABORT, 'injected'); END",
        );
        const args = { to: cast.research.squireId, body: "Is the formatter change merged?" };
        const failed = yield* send(cast.release, "squire", args);
        assert.isTrue(failed.isError);
        assert.strictEqual(structured(failed).reason, "internal");
        assert.lengthOf(yield* messageRows(cast.research.squireId), 0);
        assert.lengthOf(yield* sendCalls(cast.release.squireId), 0);
        assert.lengthOf(yield* logRows(cast.release.squireId, "message.sent"), 0);

        yield* sql.unsafe("DROP TRIGGER fail_message_usage");
        const retried = yield* send(cast.release, "squire", args);
        assert.isFalse(retried.isError, retried.text);
        assert.lengthOf(yield* messageRows(cast.research.squireId), 1);
      }),
    ),
  );

  it.effect("rejects out-of-scope refs, bad recipients, a paused recipient, and the switch", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const to = cast.research.squireId;
        const outside = yield* send(cast.release, "squire", {
          to,
          body: "What about the formatter?",
          refs: [{ kind: "thread", threadId: currencyThread }],
        });
        assert.strictEqual(structured(outside).reason, "scope");
        assert.include(outside.text, currencyThread);
        const card = yield* send(cast.release, "squire", {
          to,
          body: "See this item",
          refs: [{ kind: "item", cardId: SquireCardId.make("card:missing") }],
        });
        assert.strictEqual(structured(card).reason, "scope");
        const self = yield* send(cast.release, "squire", { to: cast.release.squireId, body: "Me" });
        assert.strictEqual(structured(self).reason, "recipient");
        const both = yield* send(cast.release, "squire", { body: "Nobody" });
        assert.strictEqual(structured(both).reason, "invalid-arguments");

        // The Lead may name any thread a Squire tracks.
        const lead = yield* send(cast.lead, "lead", {
          to,
          body: "Look at the formatter",
          refs: [{ kind: "thread", threadId: currencyThread }],
        });
        assert.isFalse(lead.isError, lead.text);

        const service = yield* need(SquireService.SquireService);
        yield* service.setStatus({ requestId: "pause-research", squireId: to, status: "paused" });
        const paused = yield* send(cast.release, "squire", { to, body: "Are you there?" });
        assert.strictEqual(structured(paused).reason, "paused");
        assert.strictEqual(paused.text, "Research is paused.");

        const settings = yield* need(ServerSettings.ServerSettingsService);
        yield* settings.updateSettings({ squire: { botMessages: false } });
        const off = yield* send(cast.release, "squire", { to: "lead", body: "Switch test" });
        assert.strictEqual(structured(off).reason, "switch");

        assert.deepEqual(yield* rejectedReasons(cast.release.squireId), [
          "scope",
          "scope",
          "recipient",
          "paused",
          "switch",
        ]);
        // Only the Lead's message reached Research; rejections charge nothing.
        assert.lengthOf(yield* messageRows(to), 1);
        assert.lengthOf(yield* messageRows(cast.lead.squireId), 0);
        assert.lengthOf(yield* usage(cast.release.squireId), 0);
      }),
    ),
  );

  it.effect("charges only the sender and rejects at the cap with the until time", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const repository = yield* need(SquireRepository.SquireRepository);
        const first = yield* send(cast.release, "squire", { to: "lead", body: "First" });
        assert.isFalse(first.isError, first.text);
        const now = (yield* usage(cast.release.squireId))[0]!.executed_at;
        for (let index = 0; index < 19; index++) {
          yield* repository.insertBudgetUsage({
            squire_id: cast.release.squireId,
            kind: "message",
            room_id: null,
            thread_id: null,
            executed_at: now,
            execution_key: `message:seed-${index}`,
          });
        }
        const capped = yield* send(cast.release, "squire", { to: "lead", body: "One more" });
        assert.strictEqual(structured(capped).reason, "budget");
        const until = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { hours: 24 }));
        assert.strictEqual(capped.text, `message budget reached until ${until}`);
        assert.lengthOf(yield* usage(cast.release.squireId), 20);
        assert.lengthOf(yield* usage(cast.lead.squireId), 0);
        assert.lengthOf(yield* messageRows(cast.lead.squireId), 1);
        assert.deepEqual(yield* rejectedReasons(cast.release.squireId), ["budget"]);
      }),
    ),
  );

  it.effect("stops a Squire to Lead to Squire chain at hop 3", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const hopOf = (result: { readonly structuredContent?: unknown }) => structured(result).hop;
        const one = yield* send(cast.release, "squire", { to: "lead", body: "Hop one" });
        assert.strictEqual(hopOf(one), 1, one.text);
        yield* deliver(cast.lead.squireId);

        // The Lead's send inherits its batch's hop.
        const two = yield* send(cast.lead, "lead", { to: cast.research.squireId, body: "Hop two" });
        assert.strictEqual(hopOf(two), 2, two.text);
        yield* deliver(cast.research.squireId);
        const [received] = yield* homeMessages(cast.research.homeThreadId);
        assert.strictEqual(received!.senderThreadId, cast.lead.homeThreadId);

        const three = yield* send(cast.research, "squire", {
          to: cast.release.squireId,
          body: "Hop three",
          replyTo: structured(two).messageKey,
        });
        assert.strictEqual(hopOf(three), 3, three.text);
        yield* deliver(cast.release.squireId);

        const four = yield* send(cast.release, "squire", {
          to: cast.research.squireId,
          body: "Hop four",
        });
        assert.strictEqual(structured(four).reason, "hop-limit");
        assert.strictEqual(four.text, HOP_LIMIT_TEXT);
        assert.deepEqual(yield* rejectedReasons(cast.release.squireId), ["hop-limit"]);
        assert.lengthOf(yield* messageRows(cast.research.squireId), 1);
        const [replied] = yield* messageRows(cast.release.squireId);
        assert.strictEqual(messageEvent(replied!.payload_json).replyTo, structured(two).messageKey);
      }),
    ),
  );

  it.effect("posts in a room as a member, charged to the room and the sender", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const rpc = yield* need(SquireLeadRpc.SquireLeadRpc);
        const { room } = yield* rpc.roomCreate({
          requestId: "room-1",
          topic: "Currency formatting",
          members: [cast.release.squireId, cast.research.squireId],
          includesLead: false,
        });
        const result = yield* send(cast.release, "squire", {
          roomId: room.id,
          body: "@Research does the formatter change touch invoices?",
        });
        assert.isFalse(result.isError, result.text);
        assert.deepEqual(structured(result).recipients, [cast.research.squireId]);
        const postId = structured(result).postId;

        const [charged, ...more] = yield* usage(cast.release.squireId);
        assert.lengthOf(more, 0);
        assert.strictEqual(charged!.room_id, room.id);
        assert.lengthOf(yield* usage(cast.research.squireId), 0);
        const [sent] = yield* logRows(cast.release.squireId, "message.sent");
        assert.strictEqual(sent!.room_id, room.id);
        assert.strictEqual(sent!.post_id, postId);

        const [row] = yield* messageRows(cast.research.squireId);
        const event = messageEvent(row!.payload_json);
        assert.deepInclude(event, {
          type: "message",
          roomId: room.id,
          from: { kind: "squire", squireId: cast.release.squireId },
          hop: 1,
        });
        assert.strictEqual(event.postId, postId);
        assert.strictEqual(row!.state_key, structured(result).messageKey);
      }),
    ),
  );
});
