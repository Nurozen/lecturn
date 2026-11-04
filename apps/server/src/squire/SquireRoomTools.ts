/**
 * Room tools: `squire_propose_room` (Squires),
 * `squire_open_room` and `squire_close_room` (the Lead, Manage Squires), and
 * `squire_read_room` (members; the Lead any room). Proposals are
 * `room-proposed` event rows on the Lead, keyed by proposal id, and expire
 * after 24 h.
 *
 * A Lead open is a Lead control action: at Recommend a proposal card, at
 * Auto a hold `SquireActions` runs through `SquireRooms.applyOpen` after the
 * undo window.
 */
import {
  SquireCardId,
  SquireCardPayload,
  SquireEvent,
  SquireId,
  SquireRef,
  SquireRoomId,
  SquireRoomPostId,
  TrimmedNonEmptyString,
  isUnknownUnionMember,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  type SquireRoomOpenIntent,
  encodeSquireActionIntent,
  squireActionCommandId,
} from "./squireActionIntent.ts";
import * as squirePolicy from "./squirePolicy.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRooms from "./SquireRooms.ts";
import { roomReadMarks, sentInUserStartedTurn } from "./squireMessageGuards.ts";
import { isBotPost } from "./squireRoomContext.ts";
import * as SquireRoomStore from "./SquireRoomStore.ts";
import {
  type SquireToolContext,
  type SquireToolHandler,
  type SquireToolKit,
  SquireToolRegistry,
} from "./squireToolKit.ts";

const ROOM_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
/** `squire_read_room` returns at most this many characters, newest posts kept. */
export const ROOM_READ_MAX_CHARS = 4000;
const SQUIRE_TEXT_NOTE =
  "This read showed another Squire's words, so your actions for the rest of this turn only recommend.";

export class SquireRoomTools extends Context.Service<
  SquireRoomTools,
  {
    /** Logs each proposal past 24 h once (`room.proposed` with `expired`) and drops its row if undelivered. */
    readonly expireProposals: (now: DateTime.Utc) => Effect.Effect<void, PersistenceSqlError>;
    readonly nextExpiryAt: Effect.Effect<Option.Option<DateTime.Utc>, PersistenceSqlError>;
  }
>()("lecturn/squire/SquireRoomTools") {}

type RoomProposalPayload = Extract<SquireCardPayload, { readonly type: "room-proposal" }>;

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SquireEvent));
const encodePayload = Schema.encodeSync(Schema.fromJsonString(SquireCardPayload));
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(SquireCardPayload));
const encodeLogData = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeLogData = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

// ── Tool arguments ──

const Reason = TrimmedNonEmptyString.check(Schema.isMaxLength(1000));
const Topic = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const Members = Schema.Array(SquireId).check(Schema.isMinLength(2), Schema.isMaxLength(6));
const ProposeArgs = Schema.Struct({
  members: Members,
  topic: Topic,
  about: Schema.Array(SquireRef),
  reason: Reason,
});
const OpenArgs = Schema.Struct({
  members: Members,
  topic: Topic,
  about: Schema.Array(SquireRef),
  reason: Reason,
  proposalId: Schema.optionalKey(TrimmedNonEmptyString),
  includesLead: Schema.optionalKey(Schema.Boolean),
});
const CloseArgs = Schema.Struct({ roomId: SquireRoomId, reason: Reason });
const ReadArgs = Schema.Struct({
  roomId: SquireRoomId,
  before: Schema.optionalKey(SquireRoomPostId),
});

const str = (description: string) => ({ type: "string", description });
const refsProp = {
  type: "array",
  description:
    "What the room is about: threads, pull requests, projects, or items. Every member's scope must cover at least one.",
  items: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["thread", "pullRequest", "project", "item"] },
      threadId: { type: "string" },
      number: { type: "integer" },
      repository: { type: "string" },
      projectId: { type: "string" },
      cardId: { type: "string" },
    },
    required: ["kind"],
  },
};
const membersProp = {
  type: "array",
  description: "2 to 6 Squire ids, from squire_list_items.",
  items: { type: "string" },
};
const definition = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: ReadonlyArray<string>,
): SquireToolHandler["definition"] => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const store = yield* SquireRoomStore.SquireRoomStore;
  const rooms = yield* SquireRooms.SquireRooms;
  const settings = yield* ServerSettingsService;
  const registry = yield* SquireToolRegistry;

  const botMessagesOn = settings.getSettings.pipe(
    Effect.map((current) => current.squire.botMessages),
  );

  /** A `room.*` row: on the Lead when one exists (Message events). */
  const roomLog = (input: {
    readonly squireId: SquireId;
    readonly kind: string;
    readonly data: Record<string, unknown>;
    readonly now: string;
    readonly roomId?: SquireRoomId | null;
    readonly eventId?: number | null;
    readonly runId?: string | null;
  }) =>
    repository.insertActionLog({
      squire_id: input.squireId,
      kind: input.kind,
      room_id: input.roomId ?? null,
      post_id: null,
      trigger_id: null,
      task_id: null,
      thread_id: null,
      card_id: null,
      event_id: input.eventId ?? null,
      run_id: input.runId ?? null,
      invocation_key: null,
      execution_key: null,
      data_json: encodeLogData(input.data),
      created_at: input.now,
    });

  const leadLevel = (ctx: SquireToolContext, kit: SquireToolKit) =>
    squirePolicy.decide({
      actionClass: "manageSquires",
      squire: kit.policySquireOf(ctx.squire),
      rules: [],
      target: {
        threadId: null,
        projectId: ctx.squire.home_project_id,
        staveSpaceId: null,
        staveSagaId: null,
      },
      trackers: [],
      budgetRows: [],
      origin: ctx.run.origin,
      now: ctx.now,
    });

  const invalid = (ctx: SquireToolContext, kit: SquireToolKit, message: string) =>
    kit.refuse(ctx, "invalid-arguments", `Invalid arguments for ${ctx.tool}: ${message}`);

  // ── Proposals ──

  const expiresAt = (row: SquireRepository.SquireEventRow) =>
    DateTime.add(DateTime.makeUnsafe(row.created_at), { milliseconds: ROOM_PROPOSAL_TTL_MS });

  /** Proposals not yet expired-logged and not answered by an open (a card, held or not). */
  const unansweredProposals = Effect.gen(function* () {
    const rows = yield* repository.listEvents({
      statuses: ["deferred", "pending", "batched", "delivered", "dropped"],
      kinds: ["room-proposed"],
    });
    if (rows.length === 0) return [];
    const answered = new Set<string>();
    const leads = [...new Set(rows.map((row) => row.squire_id))];
    for (const leadId of leads) {
      for (const card of yield* repository.listCards({ squireId: leadId, kinds: ["proposal"] })) {
        const payload = Option.getOrUndefined(decodePayload(card.payload_json));
        if (
          payload !== undefined &&
          !isUnknownUnionMember(payload) &&
          payload.type === "room-proposal" &&
          payload.proposalId !== null
        ) {
          answered.add(payload.proposalId);
        }
      }
      const earliest = rows
        .filter((row) => row.squire_id === leadId)
        .reduce((min, row) => (row.created_at < min ? row.created_at : min), rows[0]!.created_at);
      const logged = yield* repository.listActionLogAfter({
        squireId: leadId,
        kinds: ["room.proposed"],
        after: DateTime.formatIso(
          DateTime.subtract(DateTime.makeUnsafe(earliest), { milliseconds: 1 }),
        ),
      });
      for (const row of logged) {
        const data = Option.getOrUndefined(decodeLogData(row.data_json));
        if (data?.expired === "true" && typeof data.proposalId === "string") {
          answered.add(data.proposalId);
        }
      }
    }
    return rows.filter((row) => !answered.has(row.state_key));
  });

  const expireProposals: SquireRoomTools["Service"]["expireProposals"] = (now) =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(now);
      for (const row of yield* unansweredProposals) {
        if (DateTime.isGreaterThan(expiresAt(row), now)) continue;
        yield* repository.transaction(
          Effect.gen(function* () {
            yield* roomLog({
              squireId: row.squire_id,
              kind: "room.proposed",
              data: { proposalId: row.state_key, expired: "true" },
              eventId: row.id,
              now: nowIso,
            });
            yield* repository.setEventStatus({
              ids: [row.id],
              fromStatuses: ["deferred", "pending"],
              status: "dropped",
            });
          }),
        );
      }
    }).pipe(Effect.withSpan("SquireRoomTools.expireProposals"));

  const nextExpiryAt: SquireRoomTools["Service"]["nextExpiryAt"] = unansweredProposals.pipe(
    Effect.map((rows) =>
      rows.reduce<Option.Option<DateTime.Utc>>((earliest, row) => {
        const at = expiresAt(row);
        return Option.isNone(earliest) || DateTime.isLessThan(at, earliest.value)
          ? Option.some(at)
          : earliest;
      }, Option.none()),
    ),
  );

  // ── squire_propose_room (Squires) ──

  const propose: SquireToolHandler = {
    definition: definition(
      "squire_propose_room",
      "Propose a room to the Lead: a shared conversation between 2 to 6 Squires about one topic. The Lead decides; an unanswered proposal expires after 24 h.",
      {
        members: membersProp,
        topic: str("The room's topic, at most 120 characters."),
        about: refsProp,
        reason: str("Why the room helps, in one sentence the Lead reads."),
      },
      ["members", "topic", "about", "reason"],
    ),
    roles: ["squire"],
    call: (ctx, kit) =>
      Effect.gen(function* () {
        const args = yield* kit.decodeArgs(ProposeArgs, ctx.args);
        if (!args.ok) return yield* invalid(ctx, kit, args.message);
        const { members, topic, about, reason } = args.value;
        const lead = Option.filter(
          yield* repository.getLead,
          (row) => row.lifecycle !== "deleting",
        );
        if (Option.isNone(lead)) {
          return yield* kit.refuse(ctx, "lead", "There is no Lead to propose a room to.");
        }
        if ((kit.policySquireOf(lead.value).permissions.manageSquires ?? "off") === "off") {
          return yield* kit.refuse(
            ctx,
            "permission",
            "Manage Squires is Off for the Lead, so it cannot open rooms. Not proposed.",
          );
        }
        if (!(yield* botMessagesOn)) {
          return yield* kit.refuse(
            ctx,
            "switch",
            "Squire-to-Squire messages are off in this environment. Not proposed.",
          );
        }
        const leadId = lead.value.id;
        const proposalId = `proposal:${ctx.key.slice(0, 24)}`;
        return yield* kit.commit(
          ctx,
          null,
          Effect.gen(function* () {
            const eventId = yield* repository.insertTriggerEvent({
              squire_id: leadId,
              thread_id: null,
              kind: "room-proposed",
              state_key: proposalId,
              payload_json: encodeEvent({
                type: "room-proposed",
                proposalId,
                fromSquireId: ctx.squire.id,
                members,
                topic,
                about,
                reason,
              }),
              status: "pending",
              defer_reason: null,
              not_before: ctx.now,
              batch_id: null,
              created_at: ctx.now,
            });
            yield* roomLog({
              squireId: leadId,
              kind: "room.proposed",
              data: { proposalId, fromSquireId: ctx.squire.id, members, topic, about, reason },
              eventId: Option.getOrNull(eventId),
              runId: ctx.run.runId,
              now: ctx.now,
            });
            return {
              result: kit.ok(
                `Proposed the room "${topic}" to the Lead (proposal ${proposalId}). The Lead decides; it expires in 24 h.`,
                { proposalId },
              ),
              wake: [leadId],
            };
          }),
        );
      }),
  };

  // ── squire_open_room (Lead) ──

  const open: SquireToolHandler = {
    definition: definition(
      "squire_open_room",
      "Open a room for 2 to 6 of your Squires, or approve a Squire's proposal by passing its proposalId. Every member's scope must cover at least one `about` ref. Uses the Manage Squires permission: at Recommend it becomes a proposal item the user accepts; at Auto it opens after the undo window.",
      {
        members: membersProp,
        topic: str("The room's topic, at most 120 characters."),
        about: refsProp,
        reason: str("Why, in one sentence the user reads on the item."),
        proposalId: str("The proposal being approved, from its room-proposed event."),
        includesLead: { type: "boolean", description: "Whether you join the room yourself." },
      },
      ["members", "topic", "about", "reason"],
    ),
    roles: ["lead"],
    call: (ctx, kit) =>
      Effect.gen(function* () {
        const args = yield* kit.decodeArgs(OpenArgs, ctx.args);
        if (!args.ok) return yield* invalid(ctx, kit, args.message);
        const { members, topic, about, reason } = args.value;
        const includesLead = args.value.includesLead ?? false;
        const proposalId = args.value.proposalId ?? null;
        const decision = leadLevel(ctx, kit);
        if (decision.level === "off") {
          return yield* kit.refuse(
            ctx,
            decision.reason,
            decision.reason === "paused"
              ? "The Lead is paused, so it cannot open rooms."
              : "Manage Squires is Off for the Lead, so it cannot open rooms.",
            { decision: { level: "off" } },
          );
        }
        let proposalEventId: number | null = null;
        if (proposalId !== null) {
          const proposal = yield* repository.getEventByKey({
            squireId: ctx.squire.id,
            kind: "room-proposed",
            threadId: null,
            stateKey: proposalId,
          });
          if (Option.isNone(proposal)) {
            return yield* kit.refuse(ctx, "proposal", `Not opened: no proposal ${proposalId}.`);
          }
          if (!DateTime.isGreaterThan(expiresAt(proposal.value), DateTime.makeUnsafe(ctx.now))) {
            return yield* kit.refuse(
              ctx,
              "proposal",
              `Not opened: proposal ${proposalId} expired after 24 h.`,
            );
          }
          proposalEventId = proposal.value.id;
        }
        const checked = yield* rooms.checkOpen({
          by: "lead",
          members,
          includesLead,
          about,
          now: ctx.now,
        });
        if (!checked.ok) {
          return yield* kit.refuse(ctx, checked.reason, `Not opened: ${checked.text}`, {
            decision: { reason: checked.reason },
          });
        }
        const held = decision.level === "auto";
        const cardId = SquireCardId.make(`card:proposal:${ctx.squire.id}:${ctx.key.slice(0, 24)}`);
        const executesAt = held ? kit.holdUntil(ctx) : null;
        const push = !held && kit.notifyOn(ctx);
        const title = `Open room: ${topic}`;
        const payload: RoomProposalPayload = {
          type: "room-proposal",
          proposalId,
          members,
          includesLead,
          topic,
          about,
        };
        const intent: SquireRoomOpenIntent = {
          type: "room-open",
          leadId: ctx.squire.id,
          members,
          includesLead,
          topic,
          about,
          reason,
          proposalId,
          proposalEventId,
        };
        return yield* kit.commit(
          ctx,
          null,
          Effect.gen(function* () {
            yield* repository.insertCard({
              id: cardId,
              squire_id: ctx.squire.id,
              owner_squire_id: ctx.squire.id,
              kind: "proposal",
              status: held ? "held" : "open",
              // No target: a room item never takes a thread's one open slot.
              target_thread_id: null,
              project_id: null,
              title,
              why: reason,
              payload_json: encodePayload(payload),
              evidence_json: "{}",
              trigger_json: "{}",
              intent_json: held ? encodeSquireActionIntent(intent) : null,
              origin: ctx.run.origin === "unknown" ? "event" : ctx.run.origin,
              steer_kind: null,
              routed_task_id: null,
              rule_id: null,
              finding_key: null,
              escalate_at: null,
              opened_at: null,
              executes_at: executesAt,
              attempt: held ? 1 : 0,
              command_id: held ? squireActionCommandId("execute", cardId, 1) : null,
              execution_key: null,
              dedupe_key: null,
              replaced_count: 0,
              ask_json: null,
              resolution: null,
              created_at: ctx.now,
              updated_at: ctx.now,
            });
            yield* kit.logRow(
              ctx,
              held ? "action.held" : "card.created",
              {
                kind: "proposal",
                origin: ctx.run.origin,
                room: "open",
                members,
                includesLead,
                topic,
                ...(proposalId === null ? {} : { proposalId }),
                ...(executesAt === null ? {} : { executesAt }),
              },
              { cardId },
            );
            yield* kit.logRow(
              ctx,
              "decision.recorded",
              { tool: ctx.tool, level: decision.level, reason: decision.reason },
              { cardId },
            );
            if (push) {
              yield* kit.logRow(
                ctx,
                "notification.pushed",
                { kind: "proposal", source: "card" },
                { cardId },
              );
            }
            return {
              result: kit.ok(
                held
                  ? `Held: ${title}. It opens at ${executesAt} unless the user presses Undo.`
                  : `Proposed: ${title}. The user decides.`,
                {
                  cardId,
                  status: held ? "held" : "open",
                  ...(executesAt === null ? {} : { executesAt }),
                },
              ),
            };
          }),
        );
      }),
  };

  // ── squire_close_room (Lead) ──

  const close: SquireToolHandler = {
    definition: definition(
      "squire_close_room",
      "Close a room now. The user can reopen it. Uses the Manage Squires permission, but runs at once at Recommend and Auto.",
      { roomId: str("The room's id."), reason: str("Why, in one sentence the user reads.") },
      ["roomId", "reason"],
    ),
    roles: ["lead"],
    call: (ctx, kit) =>
      Effect.gen(function* () {
        const args = yield* kit.decodeArgs(CloseArgs, ctx.args);
        if (!args.ok) return yield* invalid(ctx, kit, args.message);
        const { roomId, reason } = args.value;
        const decision = leadLevel(ctx, kit);
        if (decision.level === "off") {
          return yield* kit.refuse(
            ctx,
            decision.reason,
            decision.reason === "paused"
              ? "The Lead is paused, so it cannot close rooms."
              : "Manage Squires is Off for the Lead, so it cannot close rooms.",
            { decision: { level: "off" } },
          );
        }
        const room = yield* store.getRoom(roomId);
        if (Option.isNone(room)) {
          return yield* kit.refuse(ctx, "not-found", `There is no room ${roomId}.`);
        }
        if (room.value.status !== "open") {
          return yield* kit.refuse(ctx, "closed", `The room "${room.value.topic}" is not open.`);
        }
        return yield* kit.commit(
          ctx,
          null,
          Effect.gen(function* () {
            const closed = yield* rooms.closeInTransaction({
              roomId,
              reason: "lead",
              now: ctx.now,
            });
            if (!closed) {
              return {
                result: kit.refused("closed", `The room "${room.value.topic}" is not open.`),
              };
            }
            yield* roomLog({
              squireId: ctx.squire.id,
              kind: "room.closed",
              data: { by: "lead", reason },
              roomId,
              runId: ctx.run.runId,
              now: ctx.now,
            });
            return {
              result: kit.ok(`Closed the room "${room.value.topic}". The user can reopen it.`, {
                roomId,
              }),
            };
          }),
        );
      }),
  };

  // ── squire_read_room (members; the Lead any room) ──

  const nameOf = (names: Map<string, string>, id: string | null) =>
    Effect.gen(function* () {
      if (id === null) return "unknown";
      const known = names.get(id);
      if (known !== undefined) return known;
      const row = yield* repository.getSquire(SquireId.make(id));
      const name = Option.match(row, { onNone: () => id, onSome: (found) => found.name });
      names.set(id, name);
      return name;
    });

  const read: SquireToolHandler = {
    definition: definition(
      "squire_read_room",
      `Read a room you are a member of: its newest posts, at most ${ROOM_READ_MAX_CHARS} characters. Pass \`before\` (a post id) to page back.`,
      {
        roomId: str("The room's id."),
        before: { type: "integer", description: "Only posts older than this post id." },
      },
      ["roomId"],
    ),
    roles: ["squire", "lead"],
    call: (ctx, kit) =>
      Effect.gen(function* () {
        const args = yield* kit.decodeArgs(ReadArgs, ctx.args);
        if (!args.ok) return yield* invalid(ctx, kit, args.message);
        const { roomId, before } = args.value;
        const room = yield* store.getRoom(roomId);
        if (Option.isNone(room)) {
          return yield* kit.refuse(ctx, "not-found", `There is no room ${roomId}.`);
        }
        const members = yield* store.listMembers(roomId);
        const isMember = members.some(
          (member) => member.member_kind !== "user" && member.member_id === ctx.squire.id,
        );
        if (ctx.squire.role !== "lead" && !isMember) {
          return yield* kit.refuse(
            ctx,
            "not-member",
            `You are not a member of the room "${room.value.topic}".`,
          );
        }
        const names = new Map<string, string>();
        const memberNames: Array<string> = [];
        for (const member of members) {
          memberNames.push(
            member.member_kind === "user" ? "the user" : yield* nameOf(names, member.member_id),
          );
        }
        const header = `Room "${room.value.topic}" (${roomId}, ${room.value.status}) · members: ${memberNames.join(", ")}`;
        // A rendered post is over 40 characters, so this page always outlasts the budget.
        const limit = Math.ceil(ROOM_READ_MAX_CHARS / 40) + 1;
        const page = yield* store.listPostsDesc({
          roomId,
          ...(before === undefined ? {} : { before }),
          limit,
        });
        const lines: Array<string> = [];
        const olderNote = (id: number) => `Older posts: call again with before=${id}.`;
        // Reserve room for the header and the paging note.
        let budget =
          ROOM_READ_MAX_CHARS - header.length - olderNote(Number.MAX_SAFE_INTEGER).length - 2;
        let oldest: number | undefined;
        const shownPosts: Array<(typeof page)[number]> = [];
        for (const post of page) {
          const author =
            post.author_kind === "user"
              ? "you (the user)"
              : post.author_kind === "system"
                ? "system"
                : yield* nameOf(names, post.author_id);
          const line = `[post #${post.id} · ${author} · ${post.created_at} · key ${post.message_key}] ${post.body}`;
          const cost = line.length + 1;
          if (cost > budget) {
            // A single post over the budget still shows, cut, so the reader is never stuck.
            if (lines.length === 0) {
              lines.push(line.slice(0, Math.max(budget - 1, 0)));
              shownPosts.push(post);
              oldest = post.id;
            }
            break;
          }
          lines.push(line);
          shownPosts.push(post);
          budget -= cost;
          oldest = post.id;
        }
        // Other bots' posts are model input like their messages: their hops
        // count toward the limit, and a Squire's words leave the rest of the
        // run recommend-only (`readSquireText` reads these marks back).
        let squireText = false;
        let botPostHop: number | null = null;
        for (const post of shownPosts) {
          if (!isBotPost(post, ctx.squire.id)) continue;
          botPostHop = Math.max(botPostHop ?? 0, post.hop);
          if (
            post.author_kind === "squire" ||
            !(yield* sentInUserStartedTurn(repository, post.message_key))
          ) {
            squireText = true;
          }
        }
        const more = oldest !== undefined && page.some((post) => post.id < oldest!);
        const text = [
          header,
          ...(lines.length === 0 ? ["No posts."] : lines.toReversed()),
          ...(more ? [olderNote(oldest!)] : []),
        ].join("\n");
        const note = squireText ? `\n${SQUIRE_TEXT_NOTE}` : "";
        return yield* kit.commit(
          ctx,
          null,
          Effect.succeed({
            result: kit.ok(`${text.slice(0, ROOM_READ_MAX_CHARS)}${note}`, {
              roomId,
              posts: lines.length,
              ...(more ? { before: oldest } : {}),
              ...roomReadMarks({ squireText, botPostHop }),
            }),
          }),
        );
      }),
  };

  yield* registry.register([propose, open, close, read]);

  return SquireRoomTools.of({ expireProposals, nextExpiryAt });
});

export const layer = Layer.effect(SquireRoomTools, make);
