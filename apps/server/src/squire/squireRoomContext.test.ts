import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  SquireEvent,
  SquireId,
  SquireRoomId,
  type SquireRoomPostId,
  ThreadId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRoomStore from "./SquireRoomStore.ts";
import {
  ROOM_CONTEXT_LOG_KEY,
  ROOM_CONTEXT_MAX_CHARS,
  advanceRoomCursors,
  collectRoomContext,
  encodeRoomContextWindows,
  readRoomContextWindows,
  rewindRoomCursors,
  roomContextFromWindows,
} from "./squireRoomContext.ts";

const NOW = "2026-11-01T10:00:00.000Z";
const releaseId = SquireId.make("squire-release");
const researchId = SquireId.make("squire-research");
const leadId = SquireId.make("squire-lead");
const roomId = SquireRoomId.make("room-release");
const otherRoomId = SquireRoomId.make("room-other");
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SquireEvent));

const testLayer = Layer.mergeAll(SquireRepository.layer, SquireRoomStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const stores = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const rooms = yield* SquireRoomStore.SquireRoomStore;
  return { repository, rooms };
});

const squireRow = (
  id: SquireId,
  name: string,
  role: SquireRepository.SquireRow["role"] = "squire",
): SquireRepository.SquireRow => ({
  id,
  role,
  name,
  lifecycle: "ready",
  home_generation: 0,
  home_thread_id: ThreadId.make(`home-${id}`),
  home_project_id: ProjectId.make("project-1"),
  provider_instance_id: "codex",
  model_selection_json: "{}",
  summary_model_selection_json: null,
  brief: "",
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
  created_at: NOW,
  updated_at: NOW,
});

const room = (id: SquireRoomId, topic: string): SquireRoomStore.SquireRoomDbRow => ({
  id,
  topic,
  about_json: "[]",
  status: "open",
  muted: 0,
  bot_messaging: "on",
  idle_ttl_seconds: 86_400,
  creator_kind: "user",
  proposal_event_id: null,
  last_post_at: NOW,
  closed_reason: null,
  create_request_id: null,
  revision: 0,
  created_at: NOW,
  updated_at: NOW,
});

/** Release and Research in one room with the user; the Lead is in neither room. */
const seed = Effect.gen(function* () {
  const { repository, rooms } = yield* stores;
  yield* repository.transaction(
    Effect.gen(function* () {
      yield* repository.createSquire(squireRow(releaseId, "Release"));
      yield* repository.createSquire(squireRow(researchId, "Research"));
      yield* repository.createSquire(squireRow(leadId, "Lead", "lead"));
      yield* rooms.insertRoom(room(roomId, "v2.5 release"));
      yield* rooms.insertRoom(room(otherRoomId, "Docs"));
      for (const [id, kind, memberId] of [
        [roomId, "squire", releaseId],
        [roomId, "squire", researchId],
        [roomId, "user", SquireRoomStore.USER_MEMBER_ID],
        [otherRoomId, "squire", researchId],
      ] as const) {
        yield* rooms.addMember({
          room_id: id,
          member_kind: kind,
          member_id: memberId,
          read_cursor: 0,
          user_seen_cursor: null,
        });
      }
    }),
  );
});

let keys = 0;
const post = (
  input: {
    readonly room?: SquireRoomId;
    readonly author?: "user" | "system" | SquireId;
    readonly body?: string;
    readonly routing?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const { repository, rooms } = yield* stores;
    const author = input.author ?? "user";
    const authorKind =
      author === "user"
        ? ("user" as const)
        : author === "system"
          ? ("system" as const)
          : author === leadId
            ? ("lead" as const)
            : ("squire" as const);
    return yield* repository.transaction(
      rooms
        .insertPost({
          message_key: `key-${++keys}`,
          room_id: input.room ?? roomId,
          author_kind: authorKind,
          author_id: author === "user" || author === "system" ? null : author,
          body: input.body ?? `post ${keys}`,
          reply_to: null,
          refs_json: "[]",
          hop: 0,
          routing_json:
            input.routing ?? '{"via":{"kind":"rule","rule":"none","match":""},"recipients":[]}',
          rerouted_from: null,
          created_at: NOW,
        })
        .pipe(Effect.map(Option.getOrThrow)),
    );
  });

/** The `message` row a routed post leaves for its recipient. */
const messageRow = (
  squireId: SquireId,
  postId: SquireRoomPostId,
  status: SquireRepository.SquireEventRow["status"] = "pending",
): SquireRepository.SquireEventRow => ({
  id: postId + 10_000,
  squire_id: squireId,
  thread_id: null,
  kind: "message",
  state_key: `message:${postId}`,
  payload_json: encodeEvent({
    type: "message",
    messageKey: `key-${postId}`,
    from: { kind: "user" },
    roomId,
    postId,
    hop: 0,
    body: "routed",
  }),
  status,
  defer_reason: null,
  not_before: NOW,
  batch_id: null,
  created_at: NOW,
});

const cursorOf = (squireId: SquireId, kind: "squire" | "lead" = "squire") =>
  Effect.gen(function* () {
    const { rooms } = yield* stores;
    const members = yield* rooms.listMembers(roomId);
    return members.find((row) => row.member_kind === kind && row.member_id === squireId)
      ?.read_cursor;
  });

const collect = (
  squireId: SquireId,
  batch: ReadonlyArray<SquireRepository.SquireEventRow> = [],
  role: SquireRepository.SquireRow["role"] = "squire",
) =>
  Effect.flatMap(stores, (both) =>
    collectRoomContext(both, { squire: { id: squireId, role }, batch }),
  );

describe("squireRoomContext (P19.2)", () => {
  it.effect("keeps the newest 20 unseen posts of each room and counts the older ones", () =>
    Effect.gen(function* () {
      yield* seed;
      for (let index = 0; index < 25; index++) yield* post({ author: researchId });
      const [block, ...rest] = yield* collect(releaseId);
      assert.lengthOf(rest, 0);
      assert.strictEqual(block!.topic, "v2.5 release");
      assert.lengthOf(block!.posts, 20);
      assert.strictEqual(block!.olderCount, 5);
      assert.strictEqual(block!.after, 0);
      assert.strictEqual(block!.through, block!.posts.at(-1)!.postId);
      assert.strictEqual(block!.posts[0]!.author, "Research");
      // Oldest first within the kept window.
      const ids = block!.posts.map((entry) => entry.postId);
      assert.deepStrictEqual(
        ids,
        [...ids].sort((a, b) => a - b),
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("bounds a room to 4,000 characters, newest kept", () =>
    Effect.gen(function* () {
      yield* seed;
      const old = yield* post({ body: "a".repeat(1_500) });
      yield* post({ body: "b".repeat(1_500) });
      yield* post({ body: "c".repeat(1_500) });
      const newest = yield* post({ body: "short" });
      const [block] = yield* collect(releaseId);
      assert.deepStrictEqual(
        block!.posts.map((entry) => entry.body[0]),
        ["b", "c", "s"],
      );
      assert.isAtMost(
        block!.posts.reduce((sum, entry) => sum + entry.body.length, 0),
        ROOM_CONTEXT_MAX_CHARS,
      );
      assert.strictEqual(block!.olderCount, 1);
      assert.notInclude(
        block!.posts.map((entry) => entry.postId),
        old,
      );
      assert.strictEqual(block!.through, newest);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("leaves out its own posts and posts it gets as messages, but moves past them", () =>
    Effect.gen(function* () {
      yield* seed;
      const seen = yield* post({ author: "user", body: "hello" });
      yield* post({ author: releaseId, body: "mine" });
      const delivered = yield* post({ author: "user", body: "@Release rebase" });
      const queued = yield* post({ author: "user", body: "@Release and then" });
      const { repository } = yield* stores;
      // A routed post still waiting for the next batch is a message, not context.
      assert.isTrue(yield* repository.insertEvent(messageRow(releaseId, queued)));
      const [block] = yield* collect(releaseId, [messageRow(releaseId, delivered)]);
      assert.deepStrictEqual(
        block!.posts.map((entry) => [entry.postId, entry.author, entry.body]),
        [[seen, "the user", "hello"]],
      );
      assert.strictEqual(block!.through, queued);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("advances the cursor once, so the next batch gets only newer posts", () =>
    Effect.gen(function* () {
      yield* seed;
      const { rooms, repository } = yield* stores;
      yield* post();
      const second = yield* post();
      const blocks = yield* collect(releaseId);
      yield* repository.transaction(
        advanceRoomCursors(rooms, { squireId: releaseId, role: "squire", blocks }),
      );
      assert.strictEqual(yield* cursorOf(releaseId), second);
      // A replay of the same advance, or an older one, never moves it back.
      yield* advanceRoomCursors(rooms, {
        squireId: releaseId,
        role: "squire",
        blocks: [{ roomId, through: 1 }],
      });
      assert.strictEqual(yield* cursorOf(releaseId), second);
      assert.lengthOf(yield* collect(releaseId), 0);
      // Research was never given context: its cursor did not move.
      assert.strictEqual(yield* cursorOf(researchId), 0);

      const third = yield* post({ body: "later" });
      const [next] = yield* collect(releaseId);
      assert.deepStrictEqual(
        next!.posts.map((entry) => entry.postId),
        [third],
      );
      assert.strictEqual(next!.after, second);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("gives the Lead a room it is not in only once Jev shows it a post there", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* post({ author: researchId, body: "Is anyone on the formatter?" });
      assert.lengthOf(yield* collect(leadId, [], "lead"), 0);
      yield* post({ author: "system", body: "Routed to Research · Jev 0.72 · shown to Lead" });
      const [block, ...rest] = yield* collect(leadId, [], "lead");
      assert.lengthOf(rest, 0);
      assert.strictEqual(block!.roomId, roomId);
      assert.deepStrictEqual(
        block!.posts.map((entry) => entry.author),
        ["Research", "system"],
      );

      // A stored window is the Lead's cursor in a room it is not in.
      const { repository } = yield* stores;
      yield* repository.insertActionLog({
        squire_id: leadId,
        kind: "event.received",
        room_id: null,
        post_id: null,
        trigger_id: null,
        task_id: null,
        thread_id: null,
        card_id: null,
        event_id: 1,
        run_id: null,
        invocation_key: null,
        execution_key: null,
        data_json: JSON.stringify({
          batchId: "lead-batch",
          kind: "message",
          [ROOM_CONTEXT_LOG_KEY]: encodeRoomContextWindows([block!]),
        }),
        created_at: NOW,
      });
      assert.lengthOf(yield* collect(leadId, [], "lead"), 0);
      yield* post({ author: researchId, body: "No shown row after the cursor" });
      assert.lengthOf(yield* collect(leadId, [], "lead"), 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rewinds a refused batch's cursor, unless a later batch moved it on", () =>
    Effect.gen(function* () {
      yield* seed;
      const { rooms, repository } = yield* stores;
      yield* post();
      const second = yield* post();
      const blocks = yield* collect(releaseId);
      const member = { squireId: releaseId, role: "squire" as const };
      yield* repository.transaction(advanceRoomCursors(rooms, { ...member, blocks }));
      assert.strictEqual(yield* cursorOf(releaseId), second);
      yield* repository.transaction(rewindRoomCursors(rooms, { ...member, windows: blocks }));
      assert.strictEqual(yield* cursorOf(releaseId), 0);
      // The refused batch's posts ride the next one.
      assert.deepStrictEqual(
        (yield* collect(releaseId)).flatMap((block) => block.posts.map((entry) => entry.postId)),
        blocks.flatMap((block) => block.posts.map((entry) => entry.postId)),
      );

      yield* advanceRoomCursors(rooms, { ...member, blocks });
      const third = yield* post();
      yield* advanceRoomCursors(rooms, { ...member, blocks: [{ roomId, through: third }] });
      yield* rewindRoomCursors(rooms, { ...member, windows: blocks });
      assert.strictEqual(yield* cursorOf(releaseId), third);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("never counts a dropped batch's window as shown to the Lead", () =>
    Effect.gen(function* () {
      yield* seed;
      const { repository } = yield* stores;
      yield* post({ author: researchId, body: "Is anyone on the formatter?" });
      yield* post({ author: "system", body: "Routed to Research · Jev 0.72 · shown to Lead" });
      const [block] = yield* collect(leadId, [], "lead");
      yield* repository.insertEvent({
        squire_id: leadId,
        thread_id: null,
        kind: "routed-task",
        state_key: "refused",
        payload_json: null,
        status: "dropped",
        defer_reason: null,
        not_before: NOW,
        batch_id: "lead-refused",
        created_at: NOW,
      });
      const [dropped] = yield* repository.listEvents({ statuses: ["dropped"] });
      yield* repository.insertActionLog({
        squire_id: leadId,
        kind: "event.received",
        room_id: null,
        post_id: null,
        trigger_id: null,
        task_id: null,
        thread_id: null,
        card_id: null,
        event_id: dropped!.id,
        run_id: null,
        invocation_key: null,
        execution_key: null,
        data_json: JSON.stringify({
          batchId: "lead-refused",
          kind: "routed-task",
          [ROOM_CONTEXT_LOG_KEY]: encodeRoomContextWindows([block!]),
        }),
        created_at: NOW,
      });
      const [again] = yield* collect(leadId, [], "lead");
      assert.strictEqual(again?.through, block!.through);
      assert.strictEqual(again?.after, 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rebuilds the stored window after the cursor moved and newer posts arrived", () =>
    Effect.gen(function* () {
      yield* seed;
      const both = yield* stores;
      for (let index = 0; index < 22; index++) yield* post({ author: researchId });
      const blocks = yield* collect(releaseId);
      const batch = [{ ...messageRow(releaseId, 1 as SquireRoomPostId), id: 7 }];
      yield* both.repository.transaction(
        Effect.gen(function* () {
          yield* advanceRoomCursors(both.rooms, { squireId: releaseId, role: "squire", blocks });
          yield* both.repository.insertActionLog({
            squire_id: releaseId,
            kind: "event.received",
            room_id: null,
            post_id: null,
            trigger_id: null,
            task_id: null,
            thread_id: null,
            card_id: null,
            event_id: 7,
            run_id: null,
            invocation_key: null,
            execution_key: null,
            data_json: JSON.stringify({
              batchId: "batch-7",
              kind: "message",
              [ROOM_CONTEXT_LOG_KEY]: encodeRoomContextWindows(blocks),
            }),
            created_at: NOW,
          });
        }),
      );
      yield* post({ author: researchId, body: "after the batch" });
      const windows = yield* readRoomContextWindows(both.repository, {
        squireId: releaseId,
        batchId: "batch-7",
        batch,
      });
      assert.deepStrictEqual(yield* roomContextFromWindows(both, windows), blocks);
      // Another batch's id finds nothing to show again.
      assert.lengthOf(
        yield* readRoomContextWindows(both.repository, {
          squireId: releaseId,
          batchId: "batch-8",
          batch,
        }),
        0,
      );
    }).pipe(Effect.provide(testLayer)),
  );
});
