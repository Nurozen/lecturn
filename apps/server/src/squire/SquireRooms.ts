/**
 * Squire rooms (P19.2, P19.3, P19.6, D62): the room record, its members and
 * cursors, and its log. A room is not a thread: posting appends a
 * `squire_room_post` and, in the same transaction, one `squire_event` of kind
 * `message` per member to wake (keyed by the post's message key), which
 * `SquireDelivery` turns into home-thread messages. Every other member gets
 * the post as context on its next batch (`squireRoomContext.ts`).
 *
 * Caps and member changes run under the policy lock. Room posts never create
 * Notify intents or push.
 */
import {
  SquireError,
  SquireEvent,
  SquireId,
  type SquireParticipant,
  SquireRef,
  type SquireRoom,
  type SquireRoomCloseInput,
  type SquireRoomCreateInput,
  SquireRoomId,
  type SquireRoomMarkReadInput,
  type SquireRoomMarkReadResult,
  type SquireRoomPost,
  type SquireRoomPostId,
  type SquireRoomPostInput,
  type SquireRoomPostResult,
  type SquireRoomPostsInput,
  type SquireRoomPostsResult,
  type SquireRoomReopenInput,
  type SquireRoomRerouteInput,
  type SquireRoomResult,
  type SquireRoomUpdateInput,
  SQUIRE_MAX_OPEN_ROOMS,
  SQUIRE_MAX_OPEN_ROOMS_PER_SQUIRE,
  SquireRouting,
  SquireCardId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  parseSquireActionCommandId,
  type SquireActionVerb,
  type SquireRoomOpenIntent,
} from "./squireActionIntent.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquireJevRouter from "./SquireJevRouter.ts";
import { orSquireError } from "./SquireLifecycle.ts";
import { checkMessageBudget } from "./squireMessageGuards.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquireRepository from "./SquireRepository.ts";
import { quotedLines, type RoutingRef, routeRoomPost } from "./squireRoomRouting.ts";
import * as SquireRoomStore from "./SquireRoomStore.ts";
import * as SquireScope from "./SquireScope.ts";
import type { SquireScopeError } from "./SquireScope.ts";
import { touchUserActivity } from "./squireUserActivity.ts";

/** Why a post, open, or close was refused; `text` is shown to the caller. */
export interface RoomRefusal {
  readonly ok: false;
  /** `closed`, `not-member`, `not-found`, `cap`, `members`, `scope`, `switch`, `budget`, `paused`. */
  readonly reason: string;
  readonly text: string;
}

export interface RoomPostWrite {
  readonly roomId: SquireRoomId;
  /** A user, a Squire, or the Lead; `system` rows are written by the room itself. */
  readonly author: SquireParticipant;
  readonly body: string;
  readonly refs: ReadonlyArray<SquireRef>;
  readonly replyTo: SquireRoomPostId | null;
  /** 0 for a user post (P19.7); the sender's hop for a bot post (`squireMessageGuards.nextHop`). */
  readonly hop: number;
  /** The tool invocation key, the RPC `requestId`, or `reroute:<postId>:<requestId>`. */
  readonly messageKey: string;
  readonly now: string;
}

export interface RoomPostWritten {
  readonly ok: true;
  readonly post: SquireRoomPost;
  /** Squires and the Lead whose `message` rows this post wrote as `pending`. */
  readonly wake: ReadonlyArray<SquireId>;
  /** Run after the enclosing transaction commits (the Jev request, D55); a no-op otherwise. */
  readonly afterCommit: Effect.Effect<void>;
  /** True when the message key already had a post: nothing was written. */
  readonly replayed: boolean;
}

/** The P19.6 open checks for a Lead open; the user's open checks members and caps only. */
export interface RoomOpenRequest {
  readonly by: "user" | "lead";
  readonly members: ReadonlyArray<SquireId>;
  readonly includesLead: boolean;
  readonly about: ReadonlyArray<SquireRef>;
  readonly now: string;
}

export type RoomOpenOutcome =
  | { readonly ok: true; readonly room: SquireRoom }
  | { readonly ok: false; readonly to: "open" | "outdated"; readonly reason: string };

export class SquireRooms extends Context.Service<
  SquireRooms,
  {
    // ── User RPCs (7b.7); each touches the inactivity clock (P3.6) ──
    readonly create: (
      input: typeof SquireRoomCreateInput.Type,
    ) => Effect.Effect<typeof SquireRoomResult.Type, SquireError>;
    readonly update: (
      input: typeof SquireRoomUpdateInput.Type,
    ) => Effect.Effect<typeof SquireRoomResult.Type, SquireError>;
    readonly close: (
      input: typeof SquireRoomCloseInput.Type,
    ) => Effect.Effect<typeof SquireRoomResult.Type, SquireError>;
    readonly reopen: (
      input: typeof SquireRoomReopenInput.Type,
    ) => Effect.Effect<typeof SquireRoomResult.Type, SquireError>;
    /** The `requestId` is the message key, so a retry is one post. */
    readonly userPost: (
      input: typeof SquireRoomPostInput.Type,
    ) => Effect.Effect<typeof SquireRoomPostResult.Type, SquireError>;
    /** User only; a new post row with `rerouted_from`, key `reroute:<postId>:<requestId>`. */
    readonly reroute: (
      input: typeof SquireRoomRerouteInput.Type,
    ) => Effect.Effect<typeof SquireRoomPostResult.Type, SquireError>;
    readonly markRead: (
      input: typeof SquireRoomMarkReadInput.Type,
    ) => Effect.Effect<typeof SquireRoomMarkReadResult.Type, SquireError>;
    /** Read only; newest first, `before` exclusive. */
    readonly posts: (
      input: typeof SquireRoomPostsInput.Type,
    ) => Effect.Effect<typeof SquireRoomPostsResult.Type, SquireError>;
    readonly get: (roomId: SquireRoomId) => Effect.Effect<Option.Option<SquireRoom>, SquireError>;

    // ── Server seams ──
    /**
     * Appends a post and its recipients' `message` rows inside the caller's
     * `repository.transaction` (the tool's commit, or the RPC's own). Routing
     * per `squireRoomRouting.routeRoomPost`; bot posts with the room's bot
     * messaging or the environment switch off route to nobody. Callers wake
     * `wake` and run `afterCommit` after the commit.
     */
    readonly postInTransaction: (
      input: RoomPostWrite,
    ) => Effect.Effect<RoomPostWritten | RoomRefusal, PersistenceSqlError | SquireScopeError>;
    /** P19.6 checks (members, scope cover of an `about` ref, caps, switch, members' budgets). */
    readonly checkOpen: (
      request: RoomOpenRequest,
    ) => Effect.Effect<{ readonly ok: true } | RoomRefusal, PersistenceSqlError | SquireScopeError>;
    /**
     * A Lead open's execution (Auto hold or accepted proposal card): re-checks,
     * then commits the room and the `action.executed` row (unique
     * `executionKey`) in one transaction, under the policy lock. A replay with
     * a committed key returns the room it opened.
     */
    readonly applyOpen: (
      intent: SquireRoomOpenIntent,
      options: {
        readonly executionKey: string;
        readonly now: string;
        readonly verb: SquireActionVerb;
      },
    ) => Effect.Effect<RoomOpenOutcome, SquireError>;
    /** Closes inside the caller's transaction, with a system row; false when not open. */
    readonly closeInTransaction: (input: {
      readonly roomId: SquireRoomId;
      readonly reason: "idle" | "members" | "user" | "lead";
      readonly now: string;
    }) => Effect.Effect<boolean, PersistenceSqlError>;

    // ── Clock (A9) ──
    /** Closes rooms idle past their TTL (system row "Closed after <ttl> idle"). */
    readonly due: (now: DateTime.Utc) => Effect.Effect<void, PersistenceSqlError>;
    readonly nextDueAt: Effect.Effect<Option.Option<DateTime.Utc>, PersistenceSqlError>;
  }
>()("lecturn/squire/SquireRooms") {}

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SquireEvent));
const encodeRouting = Schema.encodeSync(Schema.fromJsonString(SquireRouting));
const decodeRouting = Schema.decodeUnknownOption(Schema.fromJsonString(SquireRouting));
const RefsJson = Schema.fromJsonString(Schema.Array(SquireRef));
const encodeRefs = Schema.encodeSync(RefsJson);
const decodeRefs = Schema.decodeUnknownOption(RefsJson);
const encodeLogData = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const DEFAULT_PAGE = 50;
/** Enough history for quotes and rule (d), which looks back 2 minutes. */
const RECENT_POSTS = 50;
const HOUR_SECONDS = 3600;
const SYSTEM_ROUTING_JSON = encodeRouting({
  via: { kind: "rule", rule: "none", match: "system" },
  recipients: [],
});
const PULL_REQUEST_IN_BODY = /#(\d+)/g;

type Ok = { readonly ok: true };
type RuleOrFallback = {
  readonly via: Extract<SquireRouting["via"], { readonly kind: "rule" | "fallback" }>;
  readonly recipients: ReadonlyArray<SquireId>;
};
const ok: Ok = { ok: true };
const refusal = (reason: string, text: string): RoomRefusal => ({ ok: false, reason, text });

/** Deterministic, so a retried create or execution lands on the same room. */
const roomIdFor = (key: string) => SquireRoomId.make(`room:${key}`);

const ERROR_CODES: Readonly<Record<string, SquireError["code"]>> = {
  "not-found": "not_found",
  cap: "limit_reached",
  members: "invalid_request",
  paused: "paused",
  scope: "out_of_scope",
  switch: "permission_denied",
  budget: "budget_exhausted",
  closed: "invalid_request",
  "not-member": "permission_denied",
};
const toError = (refused: RoomRefusal) =>
  new SquireError({
    code: ERROR_CODES[refused.reason] ?? "invalid_request",
    message: refused.text,
  });
const failWith = (code: SquireError["code"], message: string) =>
  Effect.fail(new SquireError({ code, message }));

const participantOf = (row: SquireRoomStore.SquireRoomPostRow): SquireParticipant => {
  switch (row.author_kind) {
    case "squire":
    case "lead":
      return { kind: row.author_kind, squireId: SquireId.make(row.author_id ?? "") };
    case "user":
      return { kind: "user" };
    case "system":
      return { kind: "system" };
  }
};

const authorColumns = (author: SquireParticipant) =>
  author.kind === "squire" || author.kind === "lead"
    ? { author_kind: author.kind, author_id: author.squireId }
    : { author_kind: author.kind, author_id: null };

const toPost = (row: SquireRoomStore.SquireRoomPostRow): SquireRoomPost => ({
  id: row.id,
  messageKey: row.message_key,
  roomId: row.room_id,
  author: participantOf(row),
  body: row.body,
  replyTo: row.reply_to,
  refs: Option.getOrElse(decodeRefs(row.refs_json), () => []),
  hop: row.hop,
  routing: Option.getOrElse(decodeRouting(row.routing_json), (): SquireRouting => ({
    via: { kind: "pending" },
    recipients: [],
  })),
  reroutedFrom: row.rerouted_from,
  createdAt: row.created_at,
});

const toRoom = (
  row: SquireRoomStore.SquireRoomDbRow,
  members: ReadonlyArray<SquireRoomStore.SquireRoomMemberRow>,
): SquireRoom => ({
  id: row.id,
  topic: row.topic,
  about: Option.getOrElse(decodeRefs(row.about_json), () => []),
  status: row.status,
  muted: row.muted !== 0,
  botMessaging: row.bot_messaging === "on",
  idleTtlSeconds: row.idle_ttl_seconds,
  creator: row.creator_kind,
  members: squireMemberIds(members),
  includesLead: members.some((member) => member.member_kind === "lead"),
  includesUser: members.some((member) => member.member_kind === "user"),
  lastPostAt: row.last_post_at,
  closedReason: row.closed_reason,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const squireMemberIds = (members: ReadonlyArray<SquireRoomStore.SquireRoomMemberRow>) =>
  members
    .filter((member) => member.member_kind === "squire")
    .map((member) => SquireId.make(member.member_id));

const isRoutingRef = (ref: SquireRef): ref is RoutingRef => ref.kind !== "item";

const refKey = (ref: RoutingRef) => {
  switch (ref.kind) {
    case "thread":
      return `thread:${ref.threadId}`;
    case "project":
      return `project:${ref.projectId}`;
    case "pullRequest":
      return `pr:${ref.number}:${ref.repository ?? ""}`;
  }
};

/** A superset of the `#<n>` refs routing finds, so every one has a precomputed cover. */
const bodyPullRequests = (body: string): ReadonlyArray<RoutingRef> =>
  [...body.matchAll(PULL_REQUEST_IN_BODY)]
    .map((match) => Number(match[1]))
    .filter((number) => Number.isSafeInteger(number) && number > 0)
    .map((number) => ({ kind: "pullRequest", number }));

const idleAt = (room: SquireRoomStore.SquireRoomDbRow) =>
  DateTime.add(DateTime.makeUnsafe(room.last_post_at), { seconds: room.idle_ttl_seconds });

const closeText = (reason: "idle" | "members" | "user" | "lead", ttlSeconds: number) => {
  switch (reason) {
    case "idle":
      return `Closed after ${Math.round(ttlSeconds / HOUR_SECONDS)} h idle`;
    case "members":
      return "Closed: fewer than 2 Squires";
    case "user":
      return "Closed by you";
    case "lead":
      return "Closed by the Lead";
  }
};

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const store = yield* SquireRoomStore.SquireRoomStore;
  const { withPolicyLock } = yield* SquirePolicyLock.SquirePolicyLock;
  const scope = yield* SquireScope.SquireScope;
  const delivery = yield* SquireDelivery.SquireDelivery;
  const jev = yield* SquireJevRouter.SquireJevRouting;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // Fails closed: an unreadable switch routes bot posts to nobody.
  const roomSettings = settings.getSettings.pipe(
    Effect.map((current) => ({
      botMessages: current.squire.botMessages,
      idleTtlHours: current.squire.roomIdleTtlHours,
    })),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not read the Squire room settings", { cause }).pipe(
        Effect.as({ botMessages: false, idleTtlHours: 24 }),
      ),
    ),
  );

  const membersOf = (roomId: SquireRoomId) => store.listMembers(roomId);
  const loadRoom = (roomId: SquireRoomId) =>
    Effect.gen(function* () {
      const row = yield* store.getRoom(roomId);
      if (Option.isNone(row)) return Option.none<SquireRoom>();
      return Option.some(toRoom(row.value, yield* membersOf(roomId)));
    });
  const requireRoomRow = (roomId: SquireRoomId) =>
    Effect.flatMap(store.getRoom(roomId), (row) =>
      Option.match(row, {
        onNone: () => failWith("not_found", "That room does not exist."),
        onSome: Effect.succeed,
      }),
    );
  const requireRoom = (roomId: SquireRoomId) =>
    Effect.flatMap(loadRoom(roomId), (room) =>
      Option.match(room, {
        onNone: () => failWith("not_found", "That room does not exist."),
        onSome: Effect.succeed,
      }),
    );
  const liveLead = Effect.map(repository.getLead, (lead) =>
    Option.filter(lead, (row) => row.lifecycle !== "deleting"),
  );
  const requireLead = Effect.flatMap(liveLead, (lead) =>
    Option.match(lead, {
      onNone: () => failWith("invalid_request", "There is no Lead to add to the room."),
      onSome: Effect.succeed,
    }),
  );

  // Room-level rows belong to the Lead when there is one, else to `fallback`.
  const logRoom = (input: {
    readonly fallback: SquireId | null;
    readonly kind: string;
    readonly roomId: SquireRoomId;
    readonly postId?: SquireRoomPostId | null;
    readonly data: Record<string, unknown>;
    readonly now: string;
  }) =>
    Effect.gen(function* () {
      const owner = Option.match(yield* liveLead, {
        onNone: () => input.fallback,
        onSome: (lead) => lead.id,
      });
      if (owner === null) return;
      yield* repository.insertActionLog({
        squire_id: owner,
        kind: input.kind,
        room_id: input.roomId,
        post_id: input.postId ?? null,
        trigger_id: null,
        task_id: null,
        thread_id: null,
        card_id: null,
        event_id: null,
        run_id: null,
        invocation_key: null,
        execution_key: null,
        data_json: encodeLogData(input.data),
        created_at: input.now,
      });
    });

  const insertSystemPost = (roomId: SquireRoomId, suffix: string, body: string, now: string) =>
    store.insertPost({
      message_key: `system:${roomId}:${suffix}`,
      room_id: roomId,
      author_kind: "system",
      author_id: null,
      body,
      reply_to: null,
      refs_json: "[]",
      hop: 0,
      routing_json: SYSTEM_ROUTING_JSON,
      rerouted_from: null,
      created_at: now,
    });

  const addMembers = (input: {
    readonly roomId: SquireRoomId;
    readonly squires: ReadonlyArray<SquireId>;
    readonly leadId: SquireId | null;
    readonly user: boolean;
    readonly cursor: number;
  }) =>
    Effect.gen(function* () {
      for (const squireId of input.squires) {
        yield* store.addMember({
          room_id: input.roomId,
          member_kind: "squire",
          member_id: squireId,
          read_cursor: input.cursor,
          user_seen_cursor: null,
        });
      }
      if (input.leadId !== null) {
        yield* store.addMember({
          room_id: input.roomId,
          member_kind: "lead",
          member_id: input.leadId,
          read_cursor: input.cursor,
          user_seen_cursor: null,
        });
      }
      if (input.user) {
        yield* store.addMember({
          room_id: input.roomId,
          member_kind: "user",
          member_id: SquireRoomStore.USER_MEMBER_ID,
          read_cursor: input.cursor,
          user_seen_cursor: input.cursor,
        });
      }
    });

  /**
   * 2 to 6 distinct Squires, none deleting. Members in `kept` stay even when
   * paused, so an edit of a room with a paused member is not refused for it.
   */
  const checkMembers = (members: ReadonlyArray<SquireId>, kept: ReadonlySet<SquireId>) =>
    Effect.gen(function* () {
      const unique = [...new Set(members)];
      if (unique.length !== members.length) {
        return refusal("members", "A room lists each Squire once.");
      }
      if (unique.length < 2 || unique.length > 6) {
        return refusal("members", "A room has 2 to 6 Squires.");
      }
      const rows: Array<SquireRepository.SquireRow> = [];
      for (const squireId of unique) {
        const row = yield* repository.getSquire(squireId);
        if (
          Option.isNone(row) ||
          row.value.role !== "squire" ||
          row.value.lifecycle === "deleting"
        ) {
          return refusal("members", "Every room member must be a Squire in this environment.");
        }
        if (row.value.status !== "active" && !kept.has(squireId)) {
          return refusal("paused", `${row.value.name} is paused.`);
        }
        rows.push(row.value);
      }
      return { ok: true as const, rows };
    });

  const checkCaps = (members: ReadonlyArray<SquireRepository.SquireRow>, opening: boolean) =>
    Effect.gen(function* () {
      if (opening && (yield* store.countOpenRooms) >= SQUIRE_MAX_OPEN_ROOMS) {
        return refusal("cap", `At most ${SQUIRE_MAX_OPEN_ROOMS} rooms can be open at once.`);
      }
      for (const row of members) {
        if ((yield* store.countOpenRoomsOf(row.id)) >= SQUIRE_MAX_OPEN_ROOMS_PER_SQUIRE) {
          return refusal(
            "cap",
            `${row.name} is already in ${SQUIRE_MAX_OPEN_ROOMS_PER_SQUIRE} open rooms.`,
          );
        }
      }
      return ok;
    });

  /** Of `candidates`, the Squires whose scope covers the ref (P2). */
  const coverAmong = (ref: RoutingRef, candidates: ReadonlyArray<SquireId>) =>
    Effect.gen(function* () {
      if (candidates.length === 0) return [];
      switch (ref.kind) {
        case "thread": {
          const trackers = yield* scope.trackersOf(ref.threadId);
          return candidates.filter((id) => trackers.includes(id));
        }
        case "pullRequest": {
          const linked = (yield* projections.getThreadsWithPullRequests()).filter((thread) =>
            (thread.pullRequests ?? []).some(
              (link) =>
                link.number === ref.number &&
                (ref.repository === undefined || link.repository === ref.repository),
            ),
          );
          const covered = new Set<SquireId>();
          for (const thread of linked) {
            for (const id of yield* scope.trackersOf(thread.id)) covered.add(id);
          }
          return candidates.filter((id) => covered.has(id));
        }
        case "project": {
          const coverers = yield* scope.projectCoverersOf(ref.projectId);
          return candidates.filter((id) => coverers.includes(id));
        }
      }
    });

  const replayed = (row: SquireRoomStore.SquireRoomPostRow): RoomPostWritten => ({
    ok: true,
    post: toPost(row),
    wake: [],
    afterCommit: Effect.void,
    replayed: true,
  });

  const messageRow = (input: {
    readonly recipient: SquireId;
    readonly messageKey: string;
    readonly payload: typeof SquireEvent.Type;
    readonly now: string;
    readonly deferUntil: string | null;
  }) =>
    repository.insertEvent({
      squire_id: input.recipient,
      thread_id: null,
      kind: "message",
      state_key: input.messageKey,
      payload_json: encodeEvent(input.payload),
      status: input.deferUntil === null ? "pending" : "deferred",
      defer_reason: input.deferUntil === null ? null : "routing",
      not_before: input.deferUntil ?? input.now,
      batch_id: null,
      created_at: input.now,
    });

  const postInTransaction: SquireRooms["Service"]["postInTransaction"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* store.getPostByKey(input.messageKey);
      if (Option.isSome(existing)) return replayed(existing.value);
      const room = yield* store.getRoom(input.roomId);
      if (Option.isNone(room)) return refusal("not-found", "That room does not exist.");
      if (room.value.status === "closed") {
        return refusal("closed", "This room is closed. Reopen it to post.");
      }
      const { author } = input;
      if (author.kind === "system") {
        return refusal("not-member", "System rows are written by the room itself.");
      }
      const members = yield* membersOf(input.roomId);
      const memberIds = squireMemberIds(members);
      if (author.kind === "squire" && !memberIds.includes(author.squireId)) {
        return refusal("not-member", "Only members can post in this room.");
      }
      if (author.kind === "user") {
        yield* addMembers({
          roomId: input.roomId,
          squires: [],
          leadId: null,
          user: true,
          cursor: 0,
        });
      }

      const routingMembers: Array<{
        squireId: SquireId;
        name: string;
        status: SquireRepository.SquireRow["status"];
      }> = [];
      for (const squireId of memberIds) {
        const row = yield* repository.getSquire(squireId);
        if (Option.isSome(row) && row.value.lifecycle !== "deleting") {
          routingMembers.push({ squireId, name: row.value.name, status: row.value.status });
        }
      }
      const leadRow = yield* liveLead;
      const lead = Option.match(leadRow, {
        onNone: () => null,
        onSome: (row) => ({ squireId: row.id, name: row.name }),
      });
      const { botMessages } = yield* roomSettings;
      const recent = yield* store.listPostsDesc({ roomId: input.roomId, limit: RECENT_POSTS });
      const repliedPost =
        input.replyTo === null
          ? Option.none<SquireRoomStore.SquireRoomPostRow>()
          : Option.filter(
              yield* store.getPost(input.replyTo),
              (post) => post.room_id === input.roomId,
            );
      const quotedAuthors = quotedLines(input.body).flatMap((line) => {
        if (line.length === 0) return [];
        const source = recent.find(
          (post) => post.author_kind !== "system" && post.body.includes(line),
        );
        return source === undefined ? [] : [participantOf(source)];
      });
      const routable = routingMembers.map((member) => member.squireId);
      const cover = new Map<string, ReadonlyArray<SquireId>>();
      for (const ref of [...input.refs.filter(isRoutingRef), ...bodyPullRequests(input.body)]) {
        const key = refKey(ref);
        if (!cover.has(key)) cover.set(key, yield* coverAmong(ref, routable));
      }
      const decision = routeRoomPost({
        author,
        body: input.body,
        refs: input.refs,
        replyToAuthor: Option.match(repliedPost, { onNone: () => null, onSome: participantOf }),
        quotedAuthors,
        members: routingMembers,
        lead,
        botMessagingOn: room.value.bot_messaging === "on" && botMessages,
        coverOf: (ref) => cover.get(refKey(ref)) ?? [],
        recentMemberPosts: recent.flatMap((post) =>
          post.author_kind === "squire" &&
          post.author_id !== null &&
          routable.some((id) => id === post.author_id)
            ? [{ squireId: SquireId.make(post.author_id), createdAt: post.created_at }]
            : [],
        ),
        now: input.now,
      });

      // D55: only rule (e) delivering to the Lead may go to Jev first.
      const toLead =
        decision.jevEligible && lead !== null && decision.recipients.includes(lead.squireId);
      const availability = toLead ? yield* jev.availability : null;
      const routing: RuleOrFallback =
        availability !== null && !availability.available
          ? {
              via: { kind: "fallback", reason: availability.reason },
              recipients: decision.recipients,
            }
          : { via: decision.via, recipients: decision.recipients };
      const pending = availability !== null && availability.available;
      const inserted = yield* store.insertPost({
        message_key: input.messageKey,
        room_id: input.roomId,
        ...authorColumns(author),
        body: input.body,
        reply_to: Option.isSome(repliedPost) ? repliedPost.value.id : null,
        refs_json: encodeRefs(input.refs),
        hop: input.hop,
        routing_json: pending ? SquireRoomStore.PENDING_ROUTING_JSON : encodeRouting(routing),
        rerouted_from: null,
        created_at: input.now,
      });
      if (Option.isNone(inserted)) {
        const raced = yield* store.getPostByKey(input.messageKey);
        if (Option.isSome(raced)) return replayed(raced.value);
        return refusal("not-found", "The post could not be written.");
      }
      const postId = inserted.value;
      const deferUntil = DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(input.now), {
          milliseconds: SquireJevRouter.JEV_DEADLINE_MS,
        }),
      );
      const wake: Array<SquireId> = [];
      for (const recipient of decision.recipients) {
        const deferred = pending && recipient === lead?.squireId;
        yield* messageRow({
          recipient,
          messageKey: input.messageKey,
          payload: {
            type: "message",
            messageKey: input.messageKey,
            from: author,
            roomId: input.roomId,
            postId,
            hop: input.hop,
            body: input.body,
            ...(input.refs.length > 0 ? { refs: input.refs } : {}),
            ...(Option.isSome(repliedPost) ? { replyTo: repliedPost.value.message_key } : {}),
          },
          now: input.now,
          deferUntil: deferred ? deferUntil : null,
        });
        if (!deferred) wake.push(recipient);
      }
      yield* store.touchLastPost({ roomId: input.roomId, at: input.now });
      if (author.kind === "user") {
        yield* store.advanceUserSeenCursor({ roomId: input.roomId, to: postId });
      }
      const fallback = author.kind === "user" ? (memberIds[0] ?? null) : author.squireId;
      // A pending post's `room.routed` row is the Jev router's to write.
      if (!pending) {
        yield* logRoom({
          fallback,
          kind: "room.routed",
          roomId: input.roomId,
          postId,
          data: { via: routing.via, recipients: routing.recipients },
          now: input.now,
        });
      }
      if (routing.via.kind === "fallback") {
        yield* logRoom({
          fallback,
          kind: "room.routing-fallback",
          roomId: input.roomId,
          postId,
          data: { reason: routing.via.reason },
          now: input.now,
        });
      }
      const post = toPost({
        id: postId,
        message_key: input.messageKey,
        room_id: input.roomId,
        ...authorColumns(author),
        body: input.body,
        reply_to: Option.isSome(repliedPost) ? repliedPost.value.id : null,
        refs_json: encodeRefs(input.refs),
        hop: input.hop,
        routing_json: pending ? SquireRoomStore.PENDING_ROUTING_JSON : encodeRouting(routing),
        rerouted_from: null,
        created_at: input.now,
      });
      return {
        ok: true,
        post,
        wake,
        afterCommit:
          availability !== null && availability.available
            ? jev.begin({ postId, fundingGeneration: availability.fundingGeneration })
            : Effect.void,
        replayed: false,
      } satisfies RoomPostWritten;
    });

  const closeInTransaction: SquireRooms["Service"]["closeInTransaction"] = ({
    roomId,
    reason,
    now,
  }) =>
    Effect.gen(function* () {
      const closed = yield* store.updateRoom({
        id: roomId,
        patch: { status: "closed", closed_reason: reason },
        updatedAt: now,
        fromStatuses: ["open"],
      });
      if (Option.isNone(closed)) return false;
      yield* insertSystemPost(
        roomId,
        `closed:${closed.value.revision}`,
        closeText(reason, closed.value.idle_ttl_seconds),
        now,
      );
      return true;
    });

  // The user saw their own system row, so it does not make the room unread.
  const seenThroughLatest = (roomId: SquireRoomId) =>
    Effect.flatMap(store.latestPostId(roomId), (latest) =>
      store.advanceUserSeenCursor({ roomId, to: latest }),
    );

  const touched = <A, E>(now: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.tap(() => touchUserActivity(repository, now)));

  const create: SquireRooms["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      return yield* touched(
        now,
        withPolicyLock(
          Effect.gen(function* () {
            const existing = yield* store.getRoomByCreateRequestId(input.requestId);
            if (Option.isSome(existing)) {
              return { room: toRoom(existing.value, yield* membersOf(existing.value.id)) };
            }
            const members = yield* checkMembers(input.members, new Set());
            if (!members.ok) return yield* toError(members);
            const caps = yield* checkCaps(members.rows, true);
            if (!caps.ok) return yield* toError(caps);
            const lead = input.includesLead ? yield* requireLead : null;
            const { idleTtlHours } = yield* roomSettings;
            const row: SquireRoomStore.SquireRoomDbRow = {
              id: roomIdFor(`create:${input.requestId}`),
              topic: input.topic,
              about_json: encodeRefs(input.about ?? []),
              status: "open",
              muted: 0,
              bot_messaging: "on",
              idle_ttl_seconds: (input.idleTtlHours ?? idleTtlHours) * HOUR_SECONDS,
              creator_kind: "user",
              proposal_event_id: null,
              last_post_at: now,
              closed_reason: null,
              create_request_id: input.requestId,
              revision: 0,
              created_at: now,
              updated_at: now,
            };
            yield* repository.transaction(
              Effect.gen(function* () {
                yield* store.insertRoom(row);
                yield* addMembers({
                  roomId: row.id,
                  squires: members.rows.map((member) => member.id),
                  leadId: lead?.id ?? null,
                  user: true,
                  cursor: 0,
                });
                yield* logRoom({
                  fallback: members.rows[0]?.id ?? null,
                  kind: "room.opened",
                  roomId: row.id,
                  data: { by: "user", members: members.rows.map((member) => member.id) },
                  now,
                });
              }),
            );
            return { room: toRoom(row, yield* membersOf(row.id)) };
          }),
        ),
      );
    }).pipe(orSquireError("open the room"));

  const update: SquireRooms["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      return yield* touched(
        now,
        withPolicyLock(
          Effect.gen(function* () {
            const current = yield* requireRoomRow(input.roomId);
            const conflict = failWith(
              "revision_conflict",
              "The room changed since you opened it. Reload and try again.",
            );
            if (current.revision !== input.expectedRevision) return yield* conflict;
            const members = yield* membersOf(input.roomId);
            const currentIds = squireMemberIds(members);
            let added: ReadonlyArray<SquireId> = [];
            let removed: ReadonlyArray<SquireId> = [];
            if (input.members !== undefined) {
              const next = input.members;
              const checked = yield* checkMembers(next, new Set(currentIds));
              if (!checked.ok) return yield* toError(checked);
              added = next.filter((id) => !currentIds.includes(id));
              removed = currentIds.filter((id) => !next.includes(id));
              if (current.status === "open") {
                const caps = yield* checkCaps(
                  checked.rows.filter((row) => added.includes(row.id)),
                  false,
                );
                if (!caps.ok) return yield* toError(caps);
              }
            }
            const leadMember = members.find((member) => member.member_kind === "lead");
            const addLead =
              input.includesLead === true && leadMember === undefined ? yield* requireLead : null;
            const removeLead = input.includesLead === false ? leadMember : undefined;
            const updated = yield* repository.transaction(
              Effect.gen(function* () {
                const row = yield* store.updateRoom({
                  id: input.roomId,
                  patch: {
                    ...(input.topic === undefined ? {} : { topic: input.topic }),
                    ...(input.muted === undefined ? {} : { muted: input.muted ? 1 : 0 }),
                    ...(input.botMessaging === undefined
                      ? {}
                      : { bot_messaging: input.botMessaging ? ("on" as const) : ("off" as const) }),
                    ...(input.idleTtlHours === undefined
                      ? {}
                      : { idle_ttl_seconds: input.idleTtlHours * HOUR_SECONDS }),
                  },
                  updatedAt: now,
                  expectedRevision: input.expectedRevision,
                });
                if (Option.isNone(row)) return yield* conflict;
                // New members start at the present: the room's history is not theirs to act on.
                yield* addMembers({
                  roomId: input.roomId,
                  squires: added,
                  leadId: addLead?.id ?? null,
                  user: false,
                  cursor: yield* store.latestPostId(input.roomId),
                });
                for (const squireId of removed) {
                  yield* store.removeMember({
                    roomId: input.roomId,
                    member: { member_kind: "squire", member_id: squireId },
                  });
                }
                if (removeLead !== undefined) {
                  yield* store.removeMember({ roomId: input.roomId, member: removeLead });
                }
                return row.value;
              }),
            );
            return { room: toRoom(updated, yield* membersOf(input.roomId)) };
          }),
        ),
      );
    }).pipe(orSquireError("update the room"));

  const close: SquireRooms["Service"]["close"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      return yield* touched(
        now,
        Effect.gen(function* () {
          const before = yield* requireRoom(input.roomId);
          yield* repository.transaction(
            Effect.gen(function* () {
              if (!(yield* closeInTransaction({ roomId: input.roomId, reason: "user", now }))) {
                return;
              }
              yield* seenThroughLatest(input.roomId);
              yield* logRoom({
                fallback: before.members[0] ?? null,
                kind: "room.closed",
                roomId: input.roomId,
                data: { by: "user", reason: "user" },
                now,
              });
            }),
          );
          return { room: yield* requireRoom(input.roomId) };
        }),
      );
    }).pipe(orSquireError("close the room"));

  const reopen: SquireRooms["Service"]["reopen"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      return yield* touched(
        now,
        withPolicyLock(
          Effect.gen(function* () {
            const current = yield* requireRoom(input.roomId);
            if (current.status === "open") return { room: current };
            if (current.members.length < 2) {
              return yield* failWith("invalid_request", "A room needs 2 Squires to reopen.");
            }
            const members = yield* checkMembers(current.members, new Set(current.members));
            if (!members.ok) return yield* toError(members);
            const caps = yield* checkCaps(members.rows, true);
            if (!caps.ok) return yield* toError(caps);
            yield* repository.transaction(
              Effect.gen(function* () {
                const reopened = yield* store.updateRoom({
                  id: input.roomId,
                  patch: { status: "open", closed_reason: null, last_post_at: now },
                  updatedAt: now,
                  fromStatuses: ["closed"],
                });
                if (Option.isNone(reopened)) return;
                yield* insertSystemPost(
                  input.roomId,
                  `reopened:${reopened.value.revision}`,
                  "Reopened by you",
                  now,
                );
                yield* seenThroughLatest(input.roomId);
                yield* logRoom({
                  fallback: current.members[0] ?? null,
                  kind: "room.reopened",
                  roomId: input.roomId,
                  data: { by: "user" },
                  now,
                });
              }),
            );
            return { room: yield* requireRoom(input.roomId) };
          }),
        ),
      );
    }).pipe(orSquireError("reopen the room"));

  const userPost: SquireRooms["Service"]["userPost"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const written = yield* repository.transaction(
        postInTransaction({
          roomId: input.roomId,
          author: { kind: "user" },
          body: input.body,
          refs: input.refs ?? [],
          replyTo: input.replyTo ?? null,
          hop: 0,
          messageKey: input.requestId,
          now,
        }),
      );
      if (!written.ok) return yield* toError(written);
      yield* Effect.forEach(written.wake, delivery.wake, { discard: true });
      yield* written.afterCommit;
      yield* touchUserActivity(repository, now);
      return { post: written.post };
    }).pipe(orSquireError("post in the room"));

  const reroute: SquireRooms["Service"]["reroute"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const messageKey = `reroute:${input.postId}:${input.requestId}`;
      const written = yield* repository.transaction(
        Effect.gen(function* () {
          const existing = yield* store.getPostByKey(messageKey);
          if (Option.isSome(existing)) {
            return { post: toPost(existing.value), wake: [] as ReadonlyArray<SquireId> };
          }
          const original = yield* Effect.flatMap(store.getPost(input.postId), (post) =>
            Option.match(post, {
              onNone: () => failWith("not_found", "That post does not exist."),
              onSome: Effect.succeed,
            }),
          );
          if (original.author_kind === "system") {
            return yield* failWith("invalid_request", "A system row cannot be rerouted.");
          }
          const room = yield* requireRoom(original.room_id);
          if (room.status === "closed") {
            return yield* failWith("invalid_request", "This room is closed. Reopen it first.");
          }
          const lead = yield* liveLead;
          const toLead = Option.isSome(lead) && lead.value.id === input.to;
          if (!toLead && !room.members.includes(input.to)) {
            return yield* failWith(
              "invalid_request",
              "Reroute to a member of the room or the Lead.",
            );
          }
          const target = yield* repository.getSquire(input.to);
          if (Option.isSome(target) && target.value.status !== "active") {
            return yield* failWith("paused", `${target.value.name} is paused.`);
          }
          const author = participantOf(original);
          const routingJson = encodeRouting({
            via: { kind: "rule", rule: "mention", match: "rerouted by you" },
            recipients: [input.to],
          });
          const row = {
            message_key: messageKey,
            room_id: original.room_id,
            author_kind: original.author_kind,
            author_id: original.author_id,
            body: original.body,
            reply_to: original.reply_to,
            refs_json: original.refs_json,
            hop: original.hop,
            routing_json: routingJson,
            rerouted_from: original.id,
            created_at: now,
          };
          const inserted = yield* store.insertPost(row);
          if (Option.isNone(inserted)) {
            return yield* failWith("not_available", "The reroute could not be written. Try again.");
          }
          const replied =
            original.reply_to === null ? Option.none() : yield* store.getPost(original.reply_to);
          const refs = toPost({ ...row, id: inserted.value }).refs;
          yield* messageRow({
            recipient: input.to,
            messageKey,
            payload: {
              type: "message",
              messageKey,
              from: author,
              roomId: original.room_id,
              postId: inserted.value,
              hop: original.hop,
              body: original.body,
              ...(refs.length > 0 ? { refs } : {}),
              ...(Option.isSome(replied) ? { replyTo: replied.value.message_key } : {}),
            },
            now,
            deferUntil: null,
          });
          yield* store.touchLastPost({ roomId: original.room_id, at: now });
          yield* store.advanceUserSeenCursor({ roomId: original.room_id, to: inserted.value });
          yield* logRoom({
            fallback: input.to,
            kind: "room.rerouted",
            roomId: original.room_id,
            postId: inserted.value,
            data: { from: original.id, to: input.to },
            now,
          });
          return { post: toPost({ ...row, id: inserted.value }), wake: [input.to] };
        }),
      );
      yield* Effect.forEach(written.wake, delivery.wake, { discard: true });
      yield* touchUserActivity(repository, now);
      return { post: written.post };
    }).pipe(orSquireError("reroute the post"));

  const markRead: SquireRooms["Service"]["markRead"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* requireRoomRow(input.roomId);
      yield* repository.transaction(
        store.advanceUserSeenCursor({ roomId: input.roomId, to: input.throughPostId }),
      );
      yield* touchUserActivity(repository, now);
      return {};
    }).pipe(orSquireError("mark the room read"));

  const posts: SquireRooms["Service"]["posts"] = (input) =>
    Effect.gen(function* () {
      const room = yield* requireRoom(input.roomId);
      const limit = input.limit ?? DEFAULT_PAGE;
      const rows = yield* store.listPostsDesc({
        roomId: input.roomId,
        ...(input.before === undefined ? {} : { before: input.before }),
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      return {
        room,
        posts: page.map(toPost),
        nextBefore: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    }).pipe(orSquireError("read the room"));

  const get: SquireRooms["Service"]["get"] = (roomId) =>
    loadRoom(roomId).pipe(orSquireError("read the room"));

  const checkOpen: SquireRooms["Service"]["checkOpen"] = (request) =>
    Effect.gen(function* () {
      const members = yield* checkMembers(request.members, new Set());
      if (!members.ok) return members;
      if (request.by === "lead") {
        const about = request.about.filter(isRoutingRef);
        for (const row of members.rows) {
          let covers = false;
          for (const ref of about) {
            if ((yield* coverAmong(ref, [row.id])).length > 0) {
              covers = true;
              break;
            }
          }
          if (!covers) {
            return refusal("scope", `${row.name}'s scope covers none of the room's refs.`);
          }
        }
      }
      const caps = yield* checkCaps(members.rows, true);
      if (!caps.ok) return caps;
      if (request.by === "lead" && !(yield* roomSettings).botMessages) {
        return refusal("switch", "Squire-to-Squire messages are off in Settings.");
      }
      const budgeted = [...members.rows];
      if (request.includesLead) {
        const lead = yield* liveLead;
        if (Option.isSome(lead)) budgeted.push(lead.value);
      }
      for (const row of budgeted) {
        const budget = yield* checkMessageBudget(repository, { squire: row, now: request.now });
        if (!budget.ok) return refusal("budget", `${row.name}: ${budget.text}`);
      }
      return ok;
    });

  const applyOpen: SquireRooms["Service"]["applyOpen"] = (intent, options) =>
    withPolicyLock(
      Effect.gen(function* () {
        const executed = yield* repository.getExecution(options.executionKey);
        if (Option.isSome(executed)) {
          const roomId = executed.value.room_id;
          const room = roomId === null ? Option.none<SquireRoom>() : yield* loadRoom(roomId);
          return Option.match(room, {
            onNone: (): RoomOpenOutcome => ({
              ok: false,
              to: "outdated",
              reason: "the room it opened no longer exists",
            }),
            onSome: (opened): RoomOpenOutcome => ({ ok: true, room: opened }),
          });
        }
        const lead = yield* repository.getSquire(intent.leadId);
        if (
          Option.isNone(lead) ||
          lead.value.role !== "lead" ||
          lead.value.lifecycle === "deleting"
        ) {
          return {
            ok: false,
            to: "outdated",
            reason: "the Lead no longer exists",
          } satisfies RoomOpenOutcome;
        }
        const checked = yield* checkOpen({
          by: "lead",
          members: intent.members,
          includesLead: intent.includesLead,
          about: intent.about,
          now: options.now,
        });
        if (!checked.ok) {
          return { ok: false, to: "open", reason: checked.text } satisfies RoomOpenOutcome;
        }
        const { idleTtlHours } = yield* roomSettings;
        const row: SquireRoomStore.SquireRoomDbRow = {
          id: roomIdFor(`open:${options.executionKey}`),
          topic: intent.topic,
          about_json: encodeRefs(intent.about),
          status: "open",
          muted: 0,
          bot_messaging: "on",
          idle_ttl_seconds: idleTtlHours * HOUR_SECONDS,
          creator_kind: intent.proposalId === null ? "lead" : "proposal",
          proposal_event_id: intent.proposalEventId,
          last_post_at: options.now,
          closed_reason: null,
          create_request_id: null,
          revision: 0,
          created_at: options.now,
          updated_at: options.now,
        };
        const cardId = parseSquireActionCommandId(options.executionKey)?.cardId;
        const opener = `Opened by ${lead.value.name}`;
        const reason = intent.reason.trim().slice(0, 1_000);
        yield* repository.transaction(
          Effect.gen(function* () {
            yield* store.insertRoom(row);
            yield* addMembers({
              roomId: row.id,
              squires: intent.members,
              leadId: intent.includesLead ? intent.leadId : null,
              user: false,
              cursor: 0,
            });
            const postId = yield* insertSystemPost(
              row.id,
              "opened",
              reason.length > 0 ? `${opener} · ${reason}` : opener,
              options.now,
            );
            yield* logRoom({
              fallback: intent.leadId,
              kind: "room.opened",
              roomId: row.id,
              postId: Option.getOrNull(postId),
              data: {
                by: row.creator_kind,
                members: intent.members,
                ...(intent.proposalId === null ? {} : { proposalId: intent.proposalId }),
              },
              now: options.now,
            });
            yield* repository.insertActionLog({
              squire_id: intent.leadId,
              kind: "action.executed",
              room_id: row.id,
              post_id: null,
              trigger_id: null,
              task_id: null,
              thread_id: null,
              card_id: cardId === undefined ? null : SquireCardId.make(cardId),
              event_id: intent.proposalEventId,
              run_id: null,
              invocation_key: null,
              execution_key: options.executionKey,
              data_json: encodeLogData({
                action: "room-open",
                verb: options.verb,
                roomId: row.id,
                topic: intent.topic,
                members: intent.members,
              }),
              created_at: options.now,
            });
          }),
        );
        return { ok: true, room: toRoom(row, yield* membersOf(row.id)) } satisfies RoomOpenOutcome;
      }),
    ).pipe(orSquireError("open the room"));

  const due: SquireRooms["Service"]["due"] = (now) =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(now);
      for (const room of yield* store.listRooms({ status: "open" })) {
        if (DateTime.isGreaterThan(idleAt(room), now)) continue;
        yield* repository.transaction(
          Effect.gen(function* () {
            if (!(yield* closeInTransaction({ roomId: room.id, reason: "idle", now: at }))) return;
            yield* logRoom({
              fallback: squireMemberIds(yield* membersOf(room.id))[0] ?? null,
              kind: "room.closed",
              roomId: room.id,
              data: { by: "clock", reason: "idle" },
              now: at,
            });
          }),
        );
      }
    });

  const nextDueAt: SquireRooms["Service"]["nextDueAt"] = Effect.map(
    store.listRooms({ status: "open" }),
    (rooms) =>
      rooms.reduce<Option.Option<DateTime.Utc>>((earliest, room) => {
        const at = idleAt(room);
        return Option.isSome(earliest) && DateTime.isLessThanOrEqualTo(earliest.value, at)
          ? earliest
          : Option.some(at);
      }, Option.none()),
  );

  return SquireRooms.of({
    create,
    update,
    close,
    reopen,
    userPost,
    reroute,
    markRead,
    posts,
    get,
    postInTransaction,
    checkOpen,
    applyOpen,
    closeInTransaction,
    due,
    nextDueAt,
  });
});

export const layer = Layer.effect(SquireRooms, make);
