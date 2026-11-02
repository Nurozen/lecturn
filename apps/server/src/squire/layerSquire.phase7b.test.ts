/**
 * Phase 7b assembly of the real switch-on `layerSquire`: the messaging and
 * room tools are listed from the shared registry, the room RPC seam
 * delegates instead of refusing `not_available`, and a room post routes
 * through to the recipient's home thread.
 */
import { assert, describe, it } from "@effect/vitest";
import { SquireRoomId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SquireLeadRpc from "./SquireLeadRpc.ts";
import * as SquireService from "./SquireService.ts";
import { SQUIRE_TOOL_NAMES } from "./squireToolNames.ts";
import * as SquireTools from "./SquireTools.ts";
import { deliver, invoiceThread, need, withRoomCast } from "./testkit/roomHarness.ts";

describe("layerSquire with Phase 7b", () => {
  it.effect("serves the full record with its brief and every instance's support", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const service = yield* need(SquireService.SquireService);
        const record = yield* service.get(cast.release.squireId);
        assert.isTrue(record._tag === "Some");
        assert.strictEqual(record._tag === "Some" ? record.value.brief : "", "Release brief");
        const { instances } = yield* service.providerSupport;
        const scripted = instances.find((entry) => entry.instanceId === "scripted");
        assert.isDefined(scripted);
        assert.isTrue(scripted!.supported);
        assert.isNull(scripted!.reason);
      }),
    ),
  );

  it.effect("lists the messaging and room tools per role", () =>
    withRoomCast(() =>
      Effect.gen(function* () {
        const tools = yield* need(SquireTools.SquireTools);
        const squire = tools.definitions("squire").map((definition) => definition.name);
        const lead = tools.definitions("lead").map((definition) => definition.name);
        for (const name of ["squire_send_message", "squire_propose_room", "squire_read_room"]) {
          assert.include(squire, name);
        }
        for (const name of [
          "squire_send_message",
          "squire_open_room",
          "squire_close_room",
          "squire_read_room",
        ]) {
          assert.include(lead, name);
        }
        assert.notInclude(squire, "squire_open_room");
        assert.notInclude(lead, "squire_propose_room");
        // Every role tool has a handler in the real layer, and nothing else is listed.
        assert.sameMembers(squire, [...SQUIRE_TOOL_NAMES.squire]);
        assert.sameMembers(lead, [...SQUIRE_TOOL_NAMES.lead]);
      }),
    ),
  );

  it.effect("routes a user room post by scope to the one covering member's home thread", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const rpc = yield* need(SquireLeadRpc.SquireLeadRpc);
        const { room } = yield* rpc.roomCreate({
          requestId: "room-1",
          topic: "Invoice rounding",
          members: [cast.release.squireId, cast.research.squireId],
          includesLead: false,
        });
        assert.strictEqual(room.status, "open");
        const { post } = yield* rpc.roomPost({
          requestId: "post-1",
          roomId: room.id,
          body: "Is the rounding fix safe to ship?",
          refs: [{ kind: "thread", threadId: invoiceThread }],
        });
        assert.deepEqual(post.routing.recipients, [cast.release.squireId]);
        assert.deepInclude(post.routing.via, { kind: "rule", rule: "scope" });

        // A retried post (same requestId) is one post.
        const again = yield* rpc.roomPost({
          requestId: "post-1",
          roomId: room.id,
          body: "Is the rounding fix safe to ship?",
          refs: [{ kind: "thread", threadId: invoiceThread }],
        });
        assert.strictEqual(again.post.id, post.id);

        yield* deliver(cast.release.squireId);
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const { messages } = yield* projections.getThreadRecords(cast.release.homeThreadId, [
          "messages",
        ]);
        const delivered = messages.filter((message) =>
          message.id.startsWith("message:squire:room:"),
        );
        assert.lengthOf(delivered, 1);
        assert.include(delivered[0]!.text, "Is the rounding fix safe to ship?");

        const { posts } = yield* rpc.roomPosts({ roomId: room.id });
        assert.deepEqual(
          posts.map((entry) => entry.id),
          [post.id],
        );
        const missing = yield* Effect.result(
          rpc.roomPosts({ roomId: SquireRoomId.make("room:missing") }),
        );
        assert.isTrue(missing._tag === "Failure");
      }),
    ),
  );
});
