/**
 * Room context: a member that was not woken gets its unseen
 * posts on its next delivered batch, at most 20 posts or 4,000 characters per
 * room (newest kept) plus a count of older ones, and its read cursor advances
 * in that batch's transaction; a batch the orchestrator refuses rewinds it in
 * the transaction that drops the batch. The Lead gets the same for its rooms.
 *
 * Plain functions over the stores, because `SquireDelivery` sits below
 * `SquireRooms` in the layer.
 */
import {
  type SquireId,
  SquireEvent,
  SquireRoomId,
  SquireRouting,
  isUnknownUnionMember,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import type * as SquireRepository from "./SquireRepository.ts";
import { sentInUserStartedTurn } from "./squireMessageGuards.ts";
import type * as SquireRoomStore from "./SquireRoomStore.ts";

const ROOM_CONTEXT_MAX_POSTS = 20;
export const ROOM_CONTEXT_MAX_CHARS = 4_000;

export interface RoomContextPost {
  readonly postId: number;
  readonly author: string;
  readonly authorKind: SquireRepository.SquireRoomPostRow["author_kind"];
  readonly body: string;
  readonly createdAt: string;
  /** A Squire's words: its post, or the Lead's from a turn no user started. */
  readonly squireText: boolean;
}

export interface RoomContextBlock {
  readonly roomId: SquireRoomId;
  readonly topic: string;
  /** Oldest first, bounded. */
  readonly posts: ReadonlyArray<RoomContextPost>;
  /** Unseen posts left out by the bound. */
  readonly olderCount: number;
  /** The cursor this batch advances to (the newest unseen post). */
  readonly through: number;
  /** The cursor the window starts after (exclusive). */
  readonly after: number;
}

type Stores = {
  readonly repository: SquireRepository.SquireRepository["Service"];
  readonly rooms: SquireRoomStore.SquireRoomStore["Service"];
};
type Squire = Pick<SquireRepository.SquireRow, "id" | "role">;
type Post = SquireRepository.SquireRoomPostRow;

/**
 * What a batch showed, stored on its first `event.received` row so a
 * re-dispatch renders the same text after the cursors have moved.
 */
export const RoomContextWindow = Schema.Struct({
  roomId: SquireRoomId,
  after: Schema.Int,
  through: Schema.Int,
  postIds: Schema.Array(Schema.Int),
  olderCount: Schema.Int,
});
export type RoomContextWindow = typeof RoomContextWindow.Type;
const RoomContextWindows = Schema.fromJsonString(Schema.Array(RoomContextWindow));
const encodeWindows = Schema.encodeSync(RoomContextWindows);
const decodeWindows = Schema.decodeUnknownOption(RoomContextWindows);
const decodeLogData = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(SquireEvent));
const decodeRouting = Schema.decodeUnknownOption(Schema.fromJsonString(SquireRouting));

/** The `event.received` data key that holds the windows. */
export const ROOM_CONTEXT_LOG_KEY = "roomContext";

export const encodeRoomContextWindows = (blocks: ReadonlyArray<RoomContextBlock>) =>
  encodeWindows(
    blocks.map((block) => ({
      roomId: block.roomId,
      after: block.after,
      through: block.through,
      postIds: block.posts.map((post) => post.postId),
      olderCount: block.olderCount,
    })),
  );

const windowsOf = (dataJson: string): ReadonlyArray<RoomContextWindow> => {
  const data = Option.getOrNull(decodeLogData(dataJson));
  const stored = data?.[ROOM_CONTEXT_LOG_KEY];
  return stored === undefined ? [] : Option.getOrElse(decodeWindows(stored), () => []);
};

/**
 * A post the Jev router showed to the Lead without waking it: the
 * routed post itself, or the room's "· shown to Lead" system row.
 */
const isShownToLead = (post: Pick<Post, "author_kind" | "body" | "routing_json">) => {
  if (post.author_kind === "system" && post.body.endsWith("shown to Lead")) return true;
  const via = Option.getOrNull(decodeRouting(post.routing_json))?.via;
  return via !== undefined && !isUnknownUnionMember(via) && via.kind === "jev" && via.shownToLead;
};

const memberKind = (role: Squire["role"]) =>
  role === "lead" ? ("lead" as const) : ("squire" as const);

/** Posts this Squire receives, or will, as `message` events: they are never context too. */
const messagePostIds = (rows: ReadonlyArray<SquireRepository.SquireEventRow>) => {
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.kind !== "message") continue;
    const event = Option.getOrNull(decodeEvent(row.payload_json ?? ""));
    if (event === null || isUnknownUnionMember(event) || event.type !== "message") continue;
    if (event.postId !== undefined) ids.add(event.postId);
  }
  return ids;
};

const authorNames = Effect.fn("squireRoomContext.authorNames")(function* (
  repository: Stores["repository"],
  posts: ReadonlyArray<Post>,
) {
  const names = new Map<string, string>();
  for (const post of posts) {
    if (post.author_id === null || names.has(post.author_id)) continue;
    if (post.author_kind !== "squire" && post.author_kind !== "lead") continue;
    const found = yield* repository.getSquire(post.author_id as SquireId);
    names.set(post.author_id, Option.isSome(found) ? found.value.name : post.author_id);
  }
  return (post: Post) => {
    switch (post.author_kind) {
      case "user":
        return "the user";
      case "system":
        return "system";
      default:
        return names.get(post.author_id ?? "") ?? post.author_id ?? post.author_kind;
    }
  };
});

const toPosts = Effect.fn("squireRoomContext.toPosts")(function* (
  repository: Stores["repository"],
  posts: ReadonlyArray<Post>,
) {
  const author = yield* authorNames(repository, posts);
  const shown: Array<RoomContextPost> = [];
  for (const post of posts) {
    shown.push({
      postId: post.id,
      author: author(post),
      authorKind: post.author_kind,
      body: post.body,
      createdAt: post.created_at,
      squireText:
        post.author_kind === "squire" ||
        (post.author_kind === "lead" &&
          !(yield* sentInUserStartedTurn(repository, post.message_key))),
    });
  }
  return shown;
});

/**
 * A Squire's words in the context make it model input, like a
 * Squire's message, so the batch acts with `message` origin (cards only, no
 * rules). The user's and system posts do not, nor the Lead's from a turn the
 * user started.
 */
export const hasSquireAuthoredPost = (blocks: ReadonlyArray<Pick<RoomContextBlock, "posts">>) =>
  blocks.some((block) => block.posts.some((post) => post.squireText));

/** Newest kept: the longest run of the newest posts within both bounds. */
const bound = (posts: ReadonlyArray<Post>) => {
  let chars = 0;
  let start = posts.length;
  while (start > 0 && posts.length - start < ROOM_CONTEXT_MAX_POSTS) {
    const next = posts[start - 1]!.body.length;
    if (chars + next > ROOM_CONTEXT_MAX_CHARS) break;
    chars += next;
    start--;
  }
  return { kept: posts.slice(start), olderCount: start };
};

/**
 * The newest window per room the Lead was shown outside its memberships. A
 * refused batch's rows are dropped, so its windows never count as shown.
 */
const LEAD_WINDOW_SCAN = 200;
const leadCursors = Effect.fn("squireRoomContext.leadCursors")(function* (
  repository: Stores["repository"],
  leadId: SquireId,
) {
  const rows = (yield* repository.listActionLogDesc({
    squireId: leadId,
    kinds: ["event.received"],
    limit: LEAD_WINDOW_SCAN,
  })).filter((row) => row.event_id !== null && windowsOf(row.data_json).length > 0);
  const dropped = new Set(
    rows.length === 0
      ? []
      : (yield* repository.listEvents({
          statuses: ["dropped"],
          ids: rows.map((row) => row.event_id!),
        })).map((event) => event.id),
  );
  const cursors = new Map<string, number>();
  for (const row of rows) {
    if (dropped.has(row.event_id!)) continue;
    for (const window of windowsOf(row.data_json)) {
      cursors.set(window.roomId, Math.max(cursors.get(window.roomId) ?? 0, window.through));
    }
  }
  return cursors;
});

/**
 * The context a batch for `squireId` carries; posts already in the batch as
 * `message` events are excluded and still advance the cursor.
 */
export const collectRoomContext = Effect.fn("squireRoomContext.collectRoomContext")(function* (
  stores: Stores,
  input: {
    readonly squire: Pick<SquireRepository.SquireRow, "id" | "role">;
    readonly batch: ReadonlyArray<SquireRepository.SquireEventRow>;
  },
): Effect.fn.Return<ReadonlyArray<RoomContextBlock>, PersistenceSqlError> {
  const { repository, rooms } = stores;
  const { squire } = input;
  const member = { member_kind: memberKind(squire.role), member_id: squire.id };
  const waiting = yield* repository.listEventsByStatus({
    squireId: squire.id,
    statuses: ["pending", "deferred", "batched"],
  });
  const asMessages = messagePostIds([...input.batch, ...waiting]);

  const memberRooms = yield* rooms.listRoomsOf({ member, status: "open" });
  const candidates: Array<{ room: (typeof memberRooms)[number]; after: number }> = [];
  for (const room of memberRooms) {
    const row = (yield* rooms.listMembers(room.id)).find(
      (entry) => entry.member_kind === member.member_kind && entry.member_id === member.member_id,
    );
    candidates.push({ room, after: row?.read_cursor ?? 0 });
  }
  // The Lead also hears rooms it is not in once Jev shows it a post there.
  const shownOnly = new Set<string>();
  if (squire.role === "lead") {
    const joined = new Set<string>(memberRooms.map((room) => room.id));
    const cursors = yield* leadCursors(repository, squire.id);
    for (const room of yield* rooms.listRooms({ status: "open" })) {
      if (joined.has(room.id)) continue;
      candidates.push({ room, after: cursors.get(room.id) ?? 0 });
      shownOnly.add(room.id);
    }
  }

  const blocks: Array<RoomContextBlock> = [];
  for (const { room, after } of candidates) {
    const unseen = yield* rooms.listPostsAfter({ roomId: room.id, after });
    const through = unseen.at(-1)?.id;
    if (through === undefined) continue;
    if (shownOnly.has(room.id) && !unseen.some(isShownToLead)) continue;
    const shown = unseen.filter(
      (post) =>
        !asMessages.has(post.id) &&
        !(post.author_kind === member.member_kind && post.author_id === squire.id),
    );
    const { kept, olderCount } = bound(shown);
    blocks.push({
      roomId: room.id,
      topic: room.topic,
      posts: yield* toPosts(repository, kept),
      olderCount,
      through,
      after,
    });
  }
  return blocks;
});

/** Inside the batch's transaction; cursors only move forward. */
export const advanceRoomCursors = (
  rooms: SquireRoomStore.SquireRoomStore["Service"],
  input: {
    readonly squireId: SquireId;
    readonly role: SquireRepository.SquireRow["role"];
    readonly blocks: ReadonlyArray<Pick<RoomContextBlock, "roomId" | "through">>;
  },
): Effect.Effect<void, PersistenceSqlError> =>
  Effect.forEach(
    input.blocks,
    (block) =>
      rooms.advanceReadCursor({
        roomId: block.roomId,
        member: { member_kind: memberKind(input.role), member_id: input.squireId },
        to: block.through,
      }),
    { discard: true },
  );

/**
 * Undoes `advanceRoomCursors` for a refused batch, inside the transaction
 * that drops it, so its posts ride the next batch. A cursor that moved past
 * the window since is left alone.
 */
export const rewindRoomCursors = (
  rooms: SquireRoomStore.SquireRoomStore["Service"],
  input: {
    readonly squireId: SquireId;
    readonly role: SquireRepository.SquireRow["role"];
    readonly windows: ReadonlyArray<Pick<RoomContextWindow, "roomId" | "after" | "through">>;
  },
): Effect.Effect<void, PersistenceSqlError> =>
  Effect.forEach(
    input.windows,
    (window) =>
      rooms.rewindReadCursor({
        roomId: window.roomId,
        member: { member_kind: memberKind(input.role), member_id: input.squireId },
        from: window.through,
        to: window.after,
      }),
    { discard: true },
  );

/**
 * The windows a batch stored on its first `event.received` row; none when it
 * carried no context. The batch in flight is the Squire's newest, so its rows
 * are the newest of that kind.
 */
export const readRoomContextWindows = Effect.fn("squireRoomContext.readRoomContextWindows")(
  function* (
    repository: Stores["repository"],
    input: {
      readonly squireId: SquireId;
      readonly batchId: string;
      readonly batch: ReadonlyArray<SquireRepository.SquireEventRow>;
    },
  ): Effect.fn.Return<ReadonlyArray<RoomContextWindow>, PersistenceSqlError> {
    const firstId = Math.min(...input.batch.map((row) => row.id));
    const rows = yield* repository.listActionLogDesc({
      squireId: input.squireId,
      kinds: ["event.received"],
      limit: input.batch.length + 8,
    });
    const first = rows.find(
      (row) =>
        row.event_id === firstId &&
        Option.getOrNull(decodeLogData(row.data_json))?.batchId === input.batchId,
    );
    return first === undefined ? [] : windowsOf(first.data_json);
  },
);

/**
 * The hops of the bot posts (a Squire's or the Lead's, never the reader's
 * own) the batch's stored room context showed, so a message sent in its turn
 * counts them toward the hop limit.
 */
export const shownBotPostHops = Effect.fn("squireRoomContext.shownBotPostHops")(function* (
  stores: Stores,
  input: {
    readonly squireId: SquireId;
    readonly batchId: string;
    readonly batch: ReadonlyArray<SquireRepository.SquireEventRow>;
  },
): Effect.fn.Return<ReadonlyArray<number>, PersistenceSqlError> {
  if (input.batch.length === 0) return [];
  const windows = yield* readRoomContextWindows(stores.repository, input);
  const hops: Array<number> = [];
  for (const window of windows) {
    const ids = new Set(window.postIds);
    for (const post of yield* stores.rooms.listPostsAfter({
      roomId: window.roomId,
      after: window.after,
      through: window.through,
    })) {
      if (!ids.has(post.id) || !isBotPost(post, input.squireId)) continue;
      hops.push(post.hop);
    }
  }
  return hops;
});

/** A post by a Squire or the Lead other than `readerId`. */
export const isBotPost = (post: Pick<Post, "author_kind" | "author_id">, readerId: SquireId) =>
  (post.author_kind === "squire" || post.author_kind === "lead") && post.author_id !== readerId;

/** Rebuilds the blocks a stored window showed, for a re-dispatch. */
export const roomContextFromWindows = (
  stores: Stores,
  windows: ReadonlyArray<RoomContextWindow>,
): Effect.Effect<ReadonlyArray<RoomContextBlock>, PersistenceSqlError> =>
  Effect.forEach(windows, (window) =>
    Effect.gen(function* () {
      const room = yield* stores.rooms.getRoom(window.roomId);
      const ids = new Set(window.postIds);
      const posts = (yield* stores.rooms.listPostsAfter({
        roomId: window.roomId,
        after: window.after,
        through: window.through,
      })).filter((post) => ids.has(post.id));
      return {
        roomId: window.roomId,
        topic: Option.isSome(room) ? room.value.topic : window.roomId,
        posts: yield* toPosts(stores.repository, posts),
        olderCount: window.olderCount,
        through: window.through,
        after: window.after,
      } satisfies RoomContextBlock;
    }),
  );
