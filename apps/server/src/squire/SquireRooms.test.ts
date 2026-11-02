/**
 * Rooms over the real switch-on Squire stack: caps,
 * members, idle close, the delete cascade, paging, routing writes, reroute,
 * read state, and the unfunded Jev fallback.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  isUnknownUnionMember,
  SquireCreateInput,
  type SquireError,
  type SquireId,
  type SquireRoomId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as SquireClock from "./SquireClock.ts";
import * as SquireReadModel from "./SquireReadModel.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRooms from "./SquireRooms.ts";
import * as SquireService from "./SquireService.ts";
import { scripted, scriptedModel } from "./testkit/lifecycleHarness.ts";
import {
  billing,
  invoiceThread,
  need,
  type RoomCast,
  withRoomCast,
} from "./testkit/roomHarness.ts";

const decodeCreateInput = Schema.decodeSync(SquireCreateInput);

const codeOf = <A>(effect: Effect.Effect<A, SquireError>) =>
  effect.pipe(
    Effect.match({ onFailure: (error) => error.code, onSuccess: () => "served" as const }),
  );

const rooms = need(SquireRooms.SquireRooms);
const repository = need(SquireRepository.SquireRepository);

const openRoom = (requestId: string, members: ReadonlyArray<SquireId>, idleTtlHours?: number) =>
  Effect.flatMap(rooms, (service) =>
    service.create({
      requestId,
      topic: `Room ${requestId}`,
      members,
      includesLead: false,
      ...(idleTtlHours === undefined ? {} : { idleTtlHours }),
    }),
  ).pipe(Effect.map(({ room }) => room));

const extraSquire = (name: string) =>
  Effect.flatMap(need(SquireService.SquireService), (service) =>
    service.create(
      decodeCreateInput({
        requestId: `extra-${name}`,
        homeProjectId: billing,
        providerInstanceId: scripted,
        modelSelection: scriptedModel,
        name,
        brief: `${name} brief`,
        grants: [],
        events: {},
        permissions: {},
        budgets: {},
      }),
    ),
  ).pipe(Effect.map((squire) => squire.id));

/** Every `message` row for the key, whatever delivery has done with it since. */
const messageRows = (squireId: SquireId, messageKey: string) =>
  Effect.flatMap(repository, (store) =>
    store.listEventsByStatus({
      squireId,
      statuses: ["deferred", "pending", "batched", "delivered", "dropped"],
    }),
  ).pipe(
    Effect.map((rows) =>
      rows.filter((row) => row.kind === "message" && row.state_key === messageKey),
    ),
  );

const roomRow = (roomId: SquireRoomId) =>
  Effect.gen(function* () {
    const readModel = yield* need(SquireReadModel.SquireReadModel);
    const first = Option.getOrThrow(yield* Stream.runHead(readModel.subscribe));
    assert.isFalse(isUnknownUnionMember(first));
    if (isUnknownUnionMember(first) || first.type !== "snapshot") throw new Error("no snapshot");
    return first.snapshot.rooms.find((row) => row.id === roomId);
  });

const botPost = (
  roomId: SquireRoomId,
  author: { readonly squireId: SquireId },
  body: string,
  messageKey: string,
) =>
  Effect.gen(function* () {
    const service = yield* rooms;
    const store = yield* repository;
    const now = DateTime.formatIso(yield* DateTime.now);
    const written = yield* store.transaction(
      service.postInTransaction({
        roomId,
        author: { kind: "squire", squireId: author.squireId },
        body,
        refs: [],
        replyTo: null,
        hop: 1,
        messageKey,
        now,
      }),
    );
    if (!written.ok) throw new Error(`refused: ${written.reason}`);
    return written;
  });

const pair = (cast: RoomCast) => [cast.release.squireId, cast.research.squireId];

describe("SquireRooms", () => {
  it.effect("caps open rooms at 6 per environment and 3 per Squire", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const a = yield* extraSquire("Alpha");
        const b = yield* extraSquire("Bravo");
        const c = yield* extraSquire("Charlie");
        const d = yield* extraSquire("Delta");
        const rel = cast.release.squireId;
        const res = cast.research.squireId;
        yield* openRoom("r1", [rel, res]);
        yield* openRoom("r2", [rel, a]);
        yield* openRoom("r3", [rel, b]);
        // Release's 4th open room.
        assert.strictEqual(yield* codeOf(openRoom("r4", [rel, c])), "limit_reached");
        yield* openRoom("r5", [res, a]);
        yield* openRoom("r6", [res, b]);
        yield* openRoom("r7", [c, d]);
        // The environment's 7th open room.
        assert.strictEqual(yield* codeOf(openRoom("r8", [a, c])), "limit_reached");

        // A retried create returns the same room instead of counting again.
        const again = yield* openRoom("r7", [c, d]);
        assert.strictEqual(again.topic, "Room r7");
      }),
    ),
  );

  it.effect("takes 2 to 6 distinct, active Squires", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const rel = cast.release.squireId;
        const res = cast.research.squireId;
        assert.strictEqual(yield* codeOf(openRoom("one", [rel])), "invalid_request");
        assert.strictEqual(yield* codeOf(openRoom("dup", [rel, rel])), "invalid_request");
        assert.strictEqual(
          yield* codeOf(openRoom("lead", [rel, cast.lead.squireId])),
          "invalid_request",
        );
        const service = yield* need(SquireService.SquireService);
        yield* service.setStatus({ requestId: "pause", squireId: res, status: "paused" });
        assert.strictEqual(yield* codeOf(openRoom("paused", [rel, res])), "paused");
        yield* service.setStatus({ requestId: "resume", squireId: res, status: "active" });
        const room = yield* openRoom("ok", [rel, res]);
        assert.deepEqual(room.members, [rel, res]);
        assert.isTrue(room.includesUser);
        assert.isFalse(room.includesLead);
      }),
    ),
  );

  it.effect("closes an idle room on the clock with a system row, then reopens it", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const service = yield* rooms;
        const room = yield* openRoom("ttl", pair(cast), 1);
        const due = Option.getOrThrow(yield* service.nextDueAt);
        assert.strictEqual(
          DateTime.toEpochMillis(due) - DateTime.toEpochMillis(DateTime.makeUnsafe(room.createdAt)),
          60 * 60 * 1000,
        );
        const clock = yield* need(SquireClock.SquireClock);
        yield* TestClock.adjust("59 minutes");
        yield* clock.runDue;
        assert.strictEqual(Option.getOrThrow(yield* service.get(room.id)).status, "open");

        yield* TestClock.adjust("1 minute");
        yield* clock.runDue;
        const closed = yield* service.posts({ roomId: room.id });
        assert.strictEqual(closed.room.status, "closed");
        assert.strictEqual(closed.room.closedReason, "idle");
        assert.strictEqual(closed.posts[0]?.author.kind, "system");
        assert.strictEqual(closed.posts[0]?.body, "Closed after 1 h idle");
        assert.isTrue(Option.isNone(yield* service.nextDueAt));

        const { room: reopened } = yield* service.reopen({ requestId: "reopen", roomId: room.id });
        assert.strictEqual(reopened.status, "open");
        assert.isNull(reopened.closedReason);
        const after = yield* service.posts({ roomId: room.id });
        assert.strictEqual(after.posts[0]?.body, "Reopened by you");
      }),
    ),
  );

  it.effect("refuses posts in a closed room", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const service = yield* rooms;
        const room = yield* openRoom("closing", pair(cast));
        const { room: closed } = yield* service.close({ requestId: "close", roomId: room.id });
        assert.strictEqual(closed.status, "closed");
        assert.strictEqual(
          yield* codeOf(
            service.userPost({ requestId: "late", roomId: room.id, body: "Still here?" }),
          ),
          "invalid_request",
        );
        const { posts } = yield* service.posts({ roomId: room.id });
        assert.deepEqual(
          posts.map((post) => post.body),
          ["Closed by you"],
        );
      }),
    ),
  );

  it.effect("closes a room left with fewer than 2 Squires when a member is deleted", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const service = yield* rooms;
        const room = yield* openRoom("cascade", pair(cast));
        yield* (yield* need(SquireService.SquireService)).delete({
          requestId: "delete-research",
          squireId: cast.research.squireId,
        });
        const after = Option.getOrThrow(yield* service.get(room.id));
        assert.strictEqual(after.status, "closed");
        assert.strictEqual(after.closedReason, "members");
        assert.deepEqual(after.members, [cast.release.squireId]);
      }),
    ),
  );

  it.effect("pages posts newest first with nextBefore", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const service = yield* rooms;
        const room = yield* openRoom("paging", pair(cast));
        const ids: Array<number> = [];
        for (const n of [1, 2, 3]) {
          const { post } = yield* service.userPost({
            requestId: `page-${n}`,
            roomId: room.id,
            body: `@Release note ${n}`,
          });
          ids.push(post.id);
        }
        const first = yield* service.posts({ roomId: room.id, limit: 2 });
        assert.deepEqual(
          first.posts.map((post) => post.id),
          [ids[2], ids[1]],
        );
        assert.strictEqual(first.nextBefore, ids[1]);
        const second = yield* service.posts({
          roomId: room.id,
          before: first.nextBefore!,
          limit: 2,
        });
        assert.deepEqual(
          second.posts.map((post) => post.id),
          [ids[0]],
        );
        assert.isNull(second.nextBefore);
      }),
    ),
  );

  it.effect("routes a user post by rule and writes its recipient's message row, no card", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const service = yield* rooms;
        const room = yield* openRoom("routing", pair(cast));
        const { post } = yield* service.userPost({
          requestId: "scope-post",
          roomId: room.id,
          body: "Is the rounding fix safe?",
          refs: [{ kind: "thread", threadId: invoiceThread }],
        });
        assert.deepInclude(post.routing.via, { kind: "rule", rule: "scope" });
        assert.deepEqual(post.routing.recipients, [cast.release.squireId]);
        const [row, ...rest] = yield* messageRows(cast.release.squireId, "scope-post");
        assert.lengthOf(rest, 0);
        assert.isNull(row?.thread_id);
        assert.include(row?.payload_json ?? "", `"postId":${post.id}`);
        assert.lengthOf(yield* messageRows(cast.research.squireId, "scope-post"), 0);

        // A bot post too: room posts never raise items or Notify intents.
        yield* botPost(room.id, cast.release, "@Research can you check?", "bot-post");
        const store = yield* repository;
        for (const squireId of [cast.release, cast.research, cast.lead].map(
          (who) => who.squireId,
        )) {
          assert.lengthOf(yield* store.listCards({ squireId }), 0);
          assert.lengthOf(
            yield* store.listActionLog({
              squireId,
              kinds: ["notification.delivery", "notification.pushed"],
              limit: 10,
            }),
            0,
          );
        }
      }),
    ),
  );

  it.effect("routes a bot post to nobody with bot messaging or the switch off", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const service = yield* rooms;
        const room = yield* openRoom("quiet", pair(cast));
        const { room: off } = yield* service.update({
          requestId: "bots-off",
          roomId: room.id,
          expectedRevision: room.revision,
          botMessaging: false,
        });
        assert.isFalse(off.botMessaging);
        const muted = yield* botPost(room.id, cast.release, "@Research look", "muted-bot");
        assert.deepEqual(muted.post.routing.recipients, []);
        assert.deepInclude(muted.post.routing.via, { kind: "rule", rule: "none" });
        assert.lengthOf(muted.wake, 0);
        assert.lengthOf(yield* messageRows(cast.research.squireId, "muted-bot"), 0);

        // A stale revision is refused.
        assert.strictEqual(
          yield* codeOf(
            service.update({
              requestId: "stale",
              roomId: room.id,
              expectedRevision: room.revision,
              botMessaging: true,
            }),
          ),
          "revision_conflict",
        );
        assert.strictEqual(Option.getOrThrow(yield* service.get(room.id)).revision, off.revision);
        yield* service.update({
          requestId: "bots-on",
          roomId: room.id,
          // Posts never move the revision, so a header edit opened before them still lands.
          expectedRevision: off.revision,
          botMessaging: true,
        });
        const settings = yield* need(ServerSettings.ServerSettingsService);
        yield* settings.updateSettings({ squire: { botMessages: false } });
        const switched = yield* botPost(room.id, cast.release, "@Research look", "switch-bot");
        assert.deepEqual(switched.post.routing.recipients, []);
        // User posts still route.
        const { post } = yield* service.userPost({
          requestId: "user-still",
          roomId: room.id,
          body: "@Research look",
        });
        assert.deepEqual(post.routing.recipients, [cast.research.squireId]);
      }),
    ),
  );

  it.effect("records an unfunded rule (e) post as a fallback to the Lead", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const service = yield* rooms;
        const room = yield* openRoom("fallback", pair(cast));
        const { post } = yield* service.userPost({
          requestId: "anyone",
          roomId: room.id,
          body: "Anyone looked at this?",
        });
        assert.deepEqual(post.routing.via, { kind: "fallback", reason: "unfunded" });
        assert.deepEqual(post.routing.recipients, [cast.lead.squireId]);
        const [leadRow] = yield* messageRows(cast.lead.squireId, "anyone");
        assert.isNull(leadRow?.defer_reason);
        const store = yield* repository;
        const logged = yield* store.listActionLog({
          squireId: cast.lead.squireId,
          kinds: ["room.routing-fallback"],
          limit: 10,
        });
        assert.lengthOf(logged, 1);
        assert.strictEqual(logged[0]?.post_id, post.id);
        assert.deepEqual(JSON.parse(logged[0]?.data_json ?? "{}"), { reason: "unfunded" });
      }),
    ),
  );

  it.effect("reroutes a post once under a new key", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const service = yield* rooms;
        const room = yield* openRoom("reroute", pair(cast));
        const { post } = yield* service.userPost({
          requestId: "misrouted",
          roomId: room.id,
          body: "Who owns the formatter?",
        });
        const reroute = { requestId: "fix-1", postId: post.id, to: cast.research.squireId };
        const first = yield* service.reroute(reroute);
        const retry = yield* service.reroute(reroute);
        assert.strictEqual(retry.post.id, first.post.id);
        assert.strictEqual(first.post.reroutedFrom, post.id);
        assert.strictEqual(first.post.body, post.body);
        assert.deepEqual(first.post.routing, {
          via: { kind: "rule", rule: "mention", match: "rerouted by you" },
          recipients: [cast.research.squireId],
        });
        const key = `reroute:${post.id}:fix-1`;
        assert.strictEqual(first.post.messageKey, key);
        assert.lengthOf(yield* messageRows(cast.research.squireId, key), 1);
        const store = yield* repository;
        const logged = yield* store.listActionLog({
          squireId: cast.lead.squireId,
          kinds: ["room.rerouted"],
          limit: 10,
        });
        assert.lengthOf(logged, 1);
        // Only a member or the Lead.
        const stranger = yield* extraSquire("Stranger");
        assert.strictEqual(
          yield* codeOf(service.reroute({ requestId: "fix-2", postId: post.id, to: stranger })),
          "invalid_request",
        );
      }),
    ),
  );

  it.effect("markRead clears the room row's unread dot", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const service = yield* rooms;
        const room = yield* openRoom("unread", pair(cast));
        assert.isFalse((yield* roomRow(room.id))?.unread);
        const { post } = yield* botPost(room.id, cast.release, "Heads up: CI is red", "heads-up");
        assert.isTrue((yield* roomRow(room.id))?.unread);
        yield* service.markRead({ requestId: "read", roomId: room.id, throughPostId: post.id });
        assert.isFalse((yield* roomRow(room.id))?.unread);
      }),
    ),
  );

  it.effect("stamps the Lead's inactivity clock on a user post", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const service = yield* rooms;
        const room = yield* openRoom("activity", pair(cast));
        yield* TestClock.adjust("2 hours");
        const { post } = yield* service.userPost({
          requestId: "active",
          roomId: room.id,
          body: "@Release status?",
        });
        const store = yield* repository;
        const lead = Option.getOrThrow(yield* store.getSquire(cast.lead.squireId));
        assert.strictEqual(lead.user_active_at, post.createdAt);
      }),
    ),
  );
});
