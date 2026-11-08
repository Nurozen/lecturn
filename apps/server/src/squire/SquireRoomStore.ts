/**
 * Shares `SquireRepository`'s `SqlClient`, so its statements join an enclosing `repository.transaction`.
 * Writes publish no change of their own: callers run them inside `SquireRepository.transaction`, which publishes
 * once after the commit, so the snapshot stream and the clock see every room write.
 */
import { SquireId, SquireRoomId, SquireRoomPostId } from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { SquireRoomPostRow } from "./SquireRepository.ts";

export { SquireRoomPostRow };

const Text = Schema.String;
const NullableText = Schema.NullOr(Schema.String);
const Count = Schema.Int;

export const SquireRoomDbRow = Schema.Struct({
  id: SquireRoomId,
  topic: Text,
  /** `SquireRef[]` JSON. */
  about_json: Text,
  status: Schema.Literals(["open", "closed"]),
  muted: Count,
  bot_messaging: Schema.Literals(["on", "off"]),
  idle_ttl_seconds: Count,
  creator_kind: Schema.Literals(["user", "lead", "proposal"]),
  proposal_event_id: Schema.NullOr(Count),
  last_post_at: Text,
  /** `idle`, `members`, `user`, `lead`; null while open. */
  closed_reason: NullableText,
  create_request_id: NullableText,
  revision: Count,
  created_at: Text,
  updated_at: Text,
});
export type SquireRoomDbRow = typeof SquireRoomDbRow.Type;

export const SquireRoomMemberRow = Schema.Struct({
  room_id: SquireRoomId,
  member_kind: Schema.Literals(["squire", "lead", "user"]),
  /** A Squire id, or `user`. */
  member_id: Text,
  /** The newest post id attached as context or delivered to this member. */
  read_cursor: Count,
  /** User member only: the newest post id the user has seen. */
  user_seen_cursor: Schema.NullOr(Count),
});
export type SquireRoomMemberRow = typeof SquireRoomMemberRow.Type;
export type SquireRoomMemberKey = Pick<SquireRoomMemberRow, "member_kind" | "member_id">;

export const USER_MEMBER_ID = "user";

type Result<A> = Effect.Effect<A, PersistenceSqlError>;
type RoomPatch = Partial<Omit<SquireRoomDbRow, "id" | "revision" | "created_at" | "updated_at">>;

const decodeRooms = Schema.decodeUnknownEffect(Schema.Array(SquireRoomDbRow));
const decodeMembers = Schema.decodeUnknownEffect(Schema.Array(SquireRoomMemberRow));
const decodePosts = Schema.decodeUnknownEffect(Schema.Array(SquireRoomPostRow));
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Count })));
const decodeCount = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ n: Count })));
const decodeSquireIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ member_id: SquireId })),
);

export class SquireRoomStore extends Context.Service<
  SquireRoomStore,
  {
    readonly insertRoom: (row: SquireRoomDbRow) => Result<void>;
    readonly getRoom: (id: SquireRoomId) => Result<Option.Option<SquireRoomDbRow>>;
    readonly getRoomByCreateRequestId: (
      requestId: string,
    ) => Result<Option.Option<SquireRoomDbRow>>;
    /** Oldest first. */
    readonly listRooms: (filter?: {
      readonly status?: SquireRoomDbRow["status"];
    }) => Result<ReadonlyArray<SquireRoomDbRow>>;
    /**
     * Applies `patch`, bumps `revision`, and stamps `updated_at`. With
     * `expectedRevision`, None when the row moved on (compare-and-set).
     */
    readonly updateRoom: (input: {
      readonly id: SquireRoomId;
      readonly patch: RoomPatch;
      readonly updatedAt: string;
      readonly expectedRevision?: number;
      /** Only from these statuses (e.g. close only an open room). */
      readonly fromStatuses?: ReadonlyArray<SquireRoomDbRow["status"]>;
    }) => Result<Option.Option<SquireRoomDbRow>>;

    /**
     * Stamps a post's time without bumping `revision`, so a header edit's
     * `expectedRevision` survives posts landing meanwhile.
     */
    readonly touchLastPost: (input: {
      readonly roomId: SquireRoomId;
      readonly at: string;
    }) => Result<void>;

    /** Insertion order (the order members were added). */
    readonly listMembers: (roomId: SquireRoomId) => Result<ReadonlyArray<SquireRoomMemberRow>>;
    /** Rooms the member belongs to, oldest first. */
    readonly listRoomsOf: (input: {
      readonly member: SquireRoomMemberKey;
      readonly status?: SquireRoomDbRow["status"];
    }) => Result<ReadonlyArray<SquireRoomDbRow>>;
    /** False when the member was already there (its cursors are kept). */
    readonly addMember: (row: SquireRoomMemberRow) => Result<boolean>;
    readonly removeMember: (input: {
      readonly roomId: SquireRoomId;
      readonly member: SquireRoomMemberKey;
    }) => Result<boolean>;
    /** Moves the cursor forward only; returns whether it moved. */
    readonly advanceReadCursor: (input: {
      readonly roomId: SquireRoomId;
      readonly member: SquireRoomMemberKey;
      readonly to: number;
    }) => Result<boolean>;
    /**
     * Moves the cursor back to `to` only while it still stands at `from`, so a
     * later advance survives; returns whether it moved.
     */
    readonly rewindReadCursor: (input: {
      readonly roomId: SquireRoomId;
      readonly member: SquireRoomMemberKey;
      readonly from: number;
      readonly to: number;
    }) => Result<boolean>;
    /** Moves the user's seen cursor forward only; returns whether it moved. */
    readonly advanceUserSeenCursor: (input: {
      readonly roomId: SquireRoomId;
      readonly to: number;
    }) => Result<boolean>;
    /** Open rooms of each Squire member, for the 3-per-Squire cap. */
    readonly countOpenRoomsOf: (squireId: SquireId) => Result<number>;
    readonly countOpenRooms: Result<number>;

    /** Unique on `message_key`: None when the key already has a post. */
    readonly insertPost: (
      row: Omit<SquireRoomPostRow, "id">,
    ) => Result<Option.Option<SquireRoomPostId>>;
    readonly getPost: (id: SquireRoomPostId) => Result<Option.Option<SquireRoomPostRow>>;
    readonly getPostByKey: (messageKey: string) => Result<Option.Option<SquireRoomPostRow>>;
    /** Newest first, `before` exclusive. */
    readonly listPostsDesc: (input: {
      readonly roomId: SquireRoomId;
      readonly before?: number;
      readonly limit: number;
    }) => Result<ReadonlyArray<SquireRoomPostRow>>;
    /** Oldest first, `after` exclusive, `through` inclusive when given. */
    readonly listPostsAfter: (input: {
      readonly roomId: SquireRoomId;
      readonly after: number;
      readonly through?: number;
    }) => Result<ReadonlyArray<SquireRoomPostRow>>;
    readonly countPostsAfter: (input: {
      readonly roomId: SquireRoomId;
      readonly after: number;
    }) => Result<number>;
    /**
     * Rewrites a post's routing. With `expectedRoutingJson`, only while the
     * stored routing still equals it (Jev routing's compare-and-set on `pending`).
     */
    readonly setPostRouting: (input: {
      readonly id: SquireRoomPostId;
      readonly routingJson: string;
      readonly expectedRoutingJson?: string;
    }) => Result<boolean>;
    /** Posts whose routing is still `{"via":{"kind":"pending"},...}`, oldest first. */
    readonly listPendingRoutingPosts: Result<ReadonlyArray<SquireRoomPostRow>>;
    /** The newest post id in the room, 0 when empty. */
    readonly latestPostId: (roomId: SquireRoomId) => Result<number>;
    /** Squire members of open rooms the Squire belongs to (excluding itself). */
    readonly listRoomMateIds: (squireId: SquireId) => Result<ReadonlyArray<SquireId>>;
  }
>()("lecturn/squire/SquireRoomStore") {}

/** The stored form of a still-pending routing; `setPostRouting` compares against it. */
export const PENDING_ROUTING_JSON = JSON.stringify({ via: { kind: "pending" }, recipients: [] });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const run = <A>(operation: string, effect: Effect.Effect<A, SqlError | Schema.SchemaError>) =>
    effect.pipe(Effect.mapError(toPersistenceSqlError(`SquireRoomStore.${operation}`)));
  const changedRows = sql`SELECT changes() AS n`.pipe(
    Effect.flatMap(decodeCount),
    Effect.map((rows) => rows[0]?.n ?? 0),
  );
  const firstRoom = (rows: unknown) => decodeRooms(rows).pipe(Effect.map(Option.fromIterable));
  const memberWhere = (roomId: SquireRoomId, member: SquireRoomMemberKey) =>
    sql`room_id = ${roomId} AND member_kind = ${member.member_kind} AND member_id = ${member.member_id}`;

  return SquireRoomStore.of({
    insertRoom: Effect.fn("SquireRoomStore.insertRoom")(function (row) {
      return run("insertRoom", sql`INSERT INTO squire_room ${sql.insert(row)}`.pipe(Effect.asVoid));
    }),
    getRoom: Effect.fn("SquireRoomStore.getRoom")(function (id) {
      return run(
        "getRoom",
        sql`SELECT * FROM squire_room WHERE id = ${id}`.pipe(
          Effect.flatMap(decodeRooms),
          Effect.map(Option.fromIterable),
        ),
      );
    }),
    getRoomByCreateRequestId: Effect.fn("SquireRoomStore.getRoomByCreateRequestId")(
      function (requestId) {
        return run(
          "getRoomByCreateRequestId",
          sql`SELECT * FROM squire_room WHERE create_request_id = ${requestId}`.pipe(
            Effect.flatMap(decodeRooms),
            Effect.map(Option.fromIterable),
          ),
        );
      },
    ),
    listRooms: Effect.fn("SquireRoomStore.listRooms")(function (filter = {}) {
      return run(
        "listRooms",
        (filter.status === undefined
          ? sql`SELECT * FROM squire_room ORDER BY created_at, rowid`
          : sql`SELECT * FROM squire_room WHERE status = ${filter.status}
              ORDER BY created_at, rowid`
        ).pipe(Effect.flatMap(decodeRooms)),
      );
    }),
    updateRoom: Effect.fn("SquireRoomStore.updateRoom")(function ({
      id,
      patch,
      updatedAt,
      expectedRevision,
      fromStatuses,
    }) {
      const columns = Object.fromEntries(
        Object.entries({ ...patch, updated_at: updatedAt }).filter(
          ([column, value]) =>
            value !== undefined && !["id", "revision", "created_at"].includes(column),
        ),
      );
      const revisionCheck =
        expectedRevision === undefined ? sql`1 = 1` : sql`revision = ${expectedRevision}`;
      const statusCheck =
        fromStatuses === undefined || fromStatuses.length === 0
          ? sql`1 = 1`
          : sql`status IN ${sql.in(fromStatuses)}`;
      return run(
        "updateRoom",
        sql`UPDATE squire_room SET ${sql.update(columns)}, revision = revision + 1
          WHERE id = ${id} AND ${revisionCheck} AND ${statusCheck} RETURNING *`.pipe(
          Effect.flatMap(firstRoom),
        ),
      );
    }),
    touchLastPost: Effect.fn("SquireRoomStore.touchLastPost")(function ({ roomId, at }) {
      return run(
        "touchLastPost",
        sql`UPDATE squire_room SET last_post_at = ${at} WHERE id = ${roomId}`.pipe(Effect.asVoid),
      );
    }),
    listMembers: Effect.fn("SquireRoomStore.listMembers")(function (roomId) {
      return run(
        "listMembers",
        sql`SELECT * FROM squire_room_member WHERE room_id = ${roomId} ORDER BY rowid`.pipe(
          Effect.flatMap(decodeMembers),
        ),
      );
    }),
    listRoomsOf: Effect.fn("SquireRoomStore.listRoomsOf")(function ({ member, status }) {
      return run(
        "listRoomsOf",
        sql`SELECT room.* FROM squire_room AS room
          JOIN squire_room_member AS member ON member.room_id = room.id
          WHERE member.member_kind = ${member.member_kind} AND member.member_id = ${member.member_id}
            AND ${status === undefined ? sql`1 = 1` : sql`room.status = ${status}`}
          ORDER BY room.created_at, room.rowid`.pipe(Effect.flatMap(decodeRooms)),
      );
    }),
    addMember: Effect.fn("SquireRoomStore.addMember")(function (row) {
      return run(
        "addMember",
        sql`INSERT OR IGNORE INTO squire_room_member ${sql.insert(row)}`.pipe(
          Effect.andThen(changedRows),
          Effect.map((n) => n > 0),
        ),
      );
    }),
    removeMember: Effect.fn("SquireRoomStore.removeMember")(function ({ roomId, member }) {
      return run(
        "removeMember",
        sql`DELETE FROM squire_room_member WHERE ${memberWhere(roomId, member)}`.pipe(
          Effect.andThen(changedRows),
          Effect.map((n) => n > 0),
        ),
      );
    }),
    advanceReadCursor: Effect.fn("SquireRoomStore.advanceReadCursor")(function ({
      roomId,
      member,
      to,
    }) {
      return run(
        "advanceReadCursor",
        sql`UPDATE squire_room_member SET read_cursor = ${to}
          WHERE ${memberWhere(roomId, member)} AND read_cursor < ${to}`.pipe(
          Effect.andThen(changedRows),
          Effect.map((n) => n > 0),
        ),
      );
    }),
    rewindReadCursor: Effect.fn("SquireRoomStore.rewindReadCursor")(function ({
      roomId,
      member,
      from,
      to,
    }) {
      return run(
        "rewindReadCursor",
        sql`UPDATE squire_room_member SET read_cursor = ${to}
          WHERE ${memberWhere(roomId, member)} AND read_cursor = ${from}`.pipe(
          Effect.andThen(changedRows),
          Effect.map((n) => n > 0),
        ),
      );
    }),
    advanceUserSeenCursor: Effect.fn("SquireRoomStore.advanceUserSeenCursor")(function ({
      roomId,
      to,
    }) {
      return run(
        "advanceUserSeenCursor",
        sql`UPDATE squire_room_member SET user_seen_cursor = ${to}
          WHERE room_id = ${roomId} AND member_kind = 'user'
            AND ifnull(user_seen_cursor, 0) < ${to}`.pipe(
          Effect.andThen(changedRows),
          Effect.map((n) => n > 0),
        ),
      );
    }),
    countOpenRoomsOf: Effect.fn("SquireRoomStore.countOpenRoomsOf")(function (squireId) {
      return run(
        "countOpenRoomsOf",
        sql`SELECT count(*) AS n FROM squire_room AS room
          JOIN squire_room_member AS member ON member.room_id = room.id
          WHERE room.status = 'open' AND member.member_kind = 'squire'
            AND member.member_id = ${squireId}`.pipe(
          Effect.flatMap(decodeCount),
          Effect.map((rows) => rows[0]?.n ?? 0),
        ),
      );
    }),
    countOpenRooms: run(
      "countOpenRooms",
      sql`SELECT count(*) AS n FROM squire_room WHERE status = 'open'`.pipe(
        Effect.flatMap(decodeCount),
        Effect.map((rows) => rows[0]?.n ?? 0),
      ),
    ),
    insertPost: Effect.fn("SquireRoomStore.insertPost")(function (row) {
      return run(
        "insertPost",
        sql`INSERT OR IGNORE INTO squire_room_post ${sql.insert(row)} RETURNING id`.pipe(
          Effect.flatMap(decodeIds),
          Effect.map((rows) =>
            Option.map(Option.fromIterable(rows), (inserted) => SquireRoomPostId.make(inserted.id)),
          ),
        ),
      );
    }),
    getPost: Effect.fn("SquireRoomStore.getPost")(function (id) {
      return run(
        "getPost",
        sql`SELECT * FROM squire_room_post WHERE id = ${id}`.pipe(
          Effect.flatMap(decodePosts),
          Effect.map(Option.fromIterable),
        ),
      );
    }),
    getPostByKey: Effect.fn("SquireRoomStore.getPostByKey")(function (messageKey) {
      return run(
        "getPostByKey",
        sql`SELECT * FROM squire_room_post WHERE message_key = ${messageKey}`.pipe(
          Effect.flatMap(decodePosts),
          Effect.map(Option.fromIterable),
        ),
      );
    }),
    listPostsDesc: Effect.fn("SquireRoomStore.listPostsDesc")(function ({ roomId, before, limit }) {
      return run(
        "listPostsDesc",
        sql`SELECT * FROM squire_room_post WHERE room_id = ${roomId}
          AND ${before === undefined ? sql`1 = 1` : sql`id < ${before}`}
          ORDER BY id DESC LIMIT ${limit}`.pipe(Effect.flatMap(decodePosts)),
      );
    }),
    listPostsAfter: Effect.fn("SquireRoomStore.listPostsAfter")(function ({
      roomId,
      after,
      through,
    }) {
      return run(
        "listPostsAfter",
        sql`SELECT * FROM squire_room_post WHERE room_id = ${roomId} AND id > ${after}
          AND ${through === undefined ? sql`1 = 1` : sql`id <= ${through}`}
          ORDER BY id`.pipe(Effect.flatMap(decodePosts)),
      );
    }),
    countPostsAfter: Effect.fn("SquireRoomStore.countPostsAfter")(function ({ roomId, after }) {
      return run(
        "countPostsAfter",
        sql`SELECT count(*) AS n FROM squire_room_post WHERE room_id = ${roomId} AND id > ${after}`.pipe(
          Effect.flatMap(decodeCount),
          Effect.map((rows) => rows[0]?.n ?? 0),
        ),
      );
    }),
    setPostRouting: Effect.fn("SquireRoomStore.setPostRouting")(function ({
      id,
      routingJson,
      expectedRoutingJson,
    }) {
      return run(
        "setPostRouting",
        sql`UPDATE squire_room_post SET routing_json = ${routingJson}
          WHERE id = ${id} AND ${
            expectedRoutingJson === undefined
              ? sql`1 = 1`
              : sql`routing_json = ${expectedRoutingJson}`
          }`.pipe(
          Effect.andThen(changedRows),
          Effect.map((n) => n > 0),
        ),
      );
    }),
    listPendingRoutingPosts: run(
      "listPendingRoutingPosts",
      sql`SELECT * FROM squire_room_post WHERE routing_json = ${PENDING_ROUTING_JSON}
        ORDER BY id`.pipe(Effect.flatMap(decodePosts)),
    ),
    latestPostId: Effect.fn("SquireRoomStore.latestPostId")(function (roomId) {
      return run(
        "latestPostId",
        sql`SELECT ifnull(max(id), 0) AS n FROM squire_room_post WHERE room_id = ${roomId}`.pipe(
          Effect.flatMap(decodeCount),
          Effect.map((rows) => rows[0]?.n ?? 0),
        ),
      );
    }),
    listRoomMateIds: Effect.fn("SquireRoomStore.listRoomMateIds")(function (squireId) {
      return run(
        "listRoomMateIds",
        sql`SELECT DISTINCT other.member_id FROM squire_room_member AS mine
          JOIN squire_room AS room ON room.id = mine.room_id AND room.status = 'open'
          JOIN squire_room_member AS other ON other.room_id = mine.room_id
            AND other.member_kind = 'squire' AND other.member_id != ${squireId}
          WHERE mine.member_kind IN ('squire', 'lead') AND mine.member_id = ${squireId}
          ORDER BY other.member_id`.pipe(
          Effect.flatMap(decodeSquireIds),
          Effect.map((rows) => rows.map((row) => row.member_id)),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(SquireRoomStore, make);
