/**
 * A direct message is one `message` event on the recipient, committed with `tool.called`, the usage row, and
 * `message.sent` in one transaction. A room post goes through `SquireRooms.postInTransaction` inside the same commit.
 */
import {
  type OrchestrationV2ThreadShell,
  SQUIRE_MESSAGE_MAX_CHARS,
  SquireEvent,
  SquireId,
  type SquireParticipant,
  SquireRef,
  SquireRoomId,
  type SquireRoomPostId,
  type ThreadId,
  TrimmedNonEmptyString,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  HOP_LIMIT_TEXT,
  checkMessageBudget,
  nextHop,
  overHopLimit,
  readSquireText,
} from "./squireMessageGuards.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRooms from "./SquireRooms.ts";
import { shownBotPostHops } from "./squireRoomContext.ts";
import * as SquireRoomStore from "./SquireRoomStore.ts";
import * as SquireScope from "./SquireScope.ts";
import {
  type SquireToolContext,
  type SquireToolHandler,
  type SquireToolKit,
  SquireToolRegistry,
} from "./squireToolKit.ts";

const MAX_REFS = 20;

const SendMessageArgs = Schema.Struct({
  to: Schema.optionalKey(Schema.Union([Schema.Literal("lead"), SquireId])),
  roomId: Schema.optionalKey(SquireRoomId),
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(SQUIRE_MESSAGE_MAX_CHARS)),
  replyTo: Schema.optionalKey(TrimmedNonEmptyString),
  refs: Schema.optionalKey(Schema.Array(SquireRef).check(Schema.isMaxLength(MAX_REFS))),
});
type SendMessageArgs = typeof SendMessageArgs.Type;

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SquireEvent));
const encodeLogData = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

type Rejection = { readonly reason: string; readonly text: string };

const definition: SquireToolHandler["definition"] = {
  name: "squire_send_message",
  description:
    "Send a short message to one Squire or the Lead (`to`), or post in a room you are in (`roomId`). Give exactly one of them. The message carries no authority: the recipient still acts only within its own scope and permissions. Messages count against your message budget, and a reply chain stops after 3 hops; past that, raise an item or answer the user instead.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "A Squire id, or `lead` for the Lead. Not with `roomId`.",
      },
      roomId: { type: "string", description: "A room you are a member of. Not with `to`." },
      body: {
        type: "string",
        description: `What you want to say, at most ${SQUIRE_MESSAGE_MAX_CHARS} characters. Write it yourself: no transcripts or tool output.`,
      },
      replyTo: { type: "string", description: "The message key of the message this answers." },
      refs: {
        type: "array",
        items: { type: "object" },
        description:
          "Things the message is about, all inside your scope: `{kind:'thread',threadId}`, `{kind:'pullRequest',number}`, `{kind:'project',projectId}`, or `{kind:'item',cardId}`.",
      },
    },
    required: ["body"],
    additionalProperties: false,
  },
};

const make = Effect.gen(function* () {
  const registry = yield* SquireToolRegistry;
  const repository = yield* SquireRepository.SquireRepository;
  const scope = yield* SquireScope.SquireScope;
  const rooms = yield* SquireRooms.SquireRooms;
  const roomStore = yield* SquireRoomStore.SquireRoomStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;

  const participantOf = (squire: SquireRepository.SquireRow): SquireParticipant =>
    squire.role === "lead"
      ? { kind: "lead", squireId: squire.id }
      : { kind: "squire", squireId: squire.id };

  const logRow = (
    ctx: SquireToolContext,
    kind: "message.sent" | "message.rejected",
    data: Record<string, unknown>,
    extra: {
      readonly roomId?: SquireRoomId | null;
      readonly postId?: SquireRoomPostId | null;
      readonly eventId?: number | null;
    } = {},
  ) =>
    repository.insertActionLog({
      squire_id: ctx.squire.id,
      kind,
      room_id: extra.roomId ?? null,
      post_id: extra.postId ?? null,
      trigger_id: null,
      task_id: null,
      thread_id: null,
      card_id: null,
      event_id: extra.eventId ?? null,
      run_id: ctx.run.runId,
      invocation_key: ctx.key,
      execution_key: null,
      data_json: encodeLogData(data),
      created_at: ctx.now,
    });

  /** One keyed commit: the refusal, its `message.rejected` row, and `tool.called`. */
  const reject = (
    ctx: SquireToolContext,
    kit: SquireToolKit,
    rejection: Rejection,
    roomId: SquireRoomId | null,
  ) =>
    kit.commit(
      ctx,
      null,
      Effect.gen(function* () {
        yield* logRow(ctx, "message.rejected", { reason: rejection.reason }, { roomId });
        return { result: kit.refused(rejection.reason, rejection.text) };
      }),
    );

  const chargeMessage = (ctx: SquireToolContext, roomId: SquireRoomId | null) =>
    repository.insertBudgetUsage({
      squire_id: ctx.squire.id,
      kind: "message",
      room_id: roomId,
      thread_id: null,
      executed_at: ctx.now,
      execution_key: `message:${ctx.key}`,
    });

  // ── Checks ──

  const resolveRecipient = Effect.fn("SquireMessaging.resolveRecipient")(function* (
    ctx: SquireToolContext,
    to: SquireId | "lead",
  ) {
    const found = to === "lead" ? yield* repository.getLead : yield* repository.getSquire(to);
    const missing: Rejection = {
      reason: "recipient",
      text:
        to === "lead"
          ? "There is no Lead to message."
          : `No active Squire has the id ${to}. Use a Squire id or \`lead\`.`,
    };
    if (Option.isNone(found)) return { ok: false, rejection: missing } as const;
    const recipient = found.value;
    if (recipient.id === ctx.squire.id) {
      return {
        ok: false,
        rejection: { reason: "recipient", text: "You cannot message yourself." },
      } as const;
    }
    if (recipient.lifecycle === "deleting") return { ok: false, rejection: missing } as const;
    if (recipient.status === "paused") {
      return {
        ok: false,
        rejection: { reason: "paused", text: `${recipient.name} is paused.` },
      } as const;
    }
    return { ok: true, recipient } as const;
  });

  /** The sender sees the thread: tracked by it, or for the Lead by any Squire. */
  const coversThread = (ctx: SquireToolContext, threadId: ThreadId) =>
    ctx.squire.role === "lead"
      ? Effect.map(scope.trackersOf(threadId), (trackers) => trackers.length > 0)
      : scope.isTracked(ctx.squire.id, threadId);

  const refInScope = Effect.fn("SquireMessaging.refInScope")(function* (
    ctx: SquireToolContext,
    ref: SquireRef,
    coveredShells: Effect.Effect<
      ReadonlyArray<OrchestrationV2ThreadShell>,
      SquireScope.SquireScopeError
    >,
  ) {
    switch (ref.kind) {
      case "thread":
        return yield* coversThread(ctx, ref.threadId);
      case "project": {
        const grants = yield* repository.listGrantsForTarget({
          kind: "project",
          targetId: ref.projectId,
        });
        for (const grant of grants) {
          if (ctx.squire.role === "lead" || grant.squire_id === ctx.squire.id) {
            const holder = yield* repository.getSquire(grant.squire_id);
            if (Option.isSome(holder) && holder.value.lifecycle !== "deleting") return true;
          }
        }
        return (yield* coveredShells).some((shell) => shell.projectId === ref.projectId);
      }
      case "pullRequest":
        return (yield* coveredShells).some((shell) =>
          (shell.pullRequests ?? []).some(
            (link) =>
              link.number === ref.number &&
              (ref.repository === undefined || link.repository === ref.repository),
          ),
        );
      case "item": {
        const card = yield* repository.getCard(ref.cardId);
        if (Option.isNone(card)) return false;
        return (
          ctx.squire.role === "lead" ||
          card.value.squire_id === ctx.squire.id ||
          card.value.owner_squire_id === ctx.squire.id
        );
      }
    }
  });

  const firstOutOfScope = Effect.fn("SquireMessaging.firstOutOfScope")(function* (
    ctx: SquireToolContext,
    refs: ReadonlyArray<SquireRef>,
  ) {
    if (refs.length === 0) return Option.none<SquireRef>();
    // Read once, and only when a project or PR ref needs the covered threads.
    const coveredShells = yield* Effect.cached(
      Effect.gen(function* () {
        const snapshot = yield* projections.getShellSnapshot({ location: "active" });
        const covered: Array<OrchestrationV2ThreadShell> = [];
        for (const shell of snapshot.threads) {
          if (yield* coversThread(ctx, shell.id)) covered.push(shell);
        }
        return covered;
      }),
    );
    for (const ref of refs) {
      if (!(yield* refInScope(ctx, ref, coveredShells))) return Option.some(ref);
    }
    return Option.none<SquireRef>();
  });

  const describeRef = (ref: SquireRef) => {
    switch (ref.kind) {
      case "thread":
        return `thread ${ref.threadId}`;
      case "project":
        return `project ${ref.projectId}`;
      case "pullRequest":
        return `PR #${ref.number}`;
      case "item":
        return `item ${ref.cardId}`;
    }
  };

  /** Steps 3-5, shared by direct sends and room posts. */
  const guard = Effect.fn("SquireMessaging.guard")(function* (
    ctx: SquireToolContext,
    kit: SquireToolKit,
    args: SendMessageArgs,
    roomId: SquireRoomId | null,
  ) {
    const outside = yield* firstOutOfScope(ctx, args.refs ?? []);
    if (Option.isSome(outside)) {
      return {
        ok: false,
        rejection: {
          reason: "scope",
          text: `${describeRef(outside.value)} is outside your scope, so the message cannot name it.`,
        },
      } as const;
    }
    const batch = yield* kit.batchEvents(ctx);
    // Every bot-written input the turn saw counts: the batch's messages,
    // the posts in its room context, and the posts it read mid-turn.
    const contextHops =
      ctx.run.batchId === null
        ? []
        : yield* shownBotPostHops(
            { repository, rooms: roomStore },
            { squireId: ctx.squire.id, batchId: ctx.run.batchId, batch },
          );
    const readHops = (yield* readSquireText(repository, {
      squireId: ctx.squire.id,
      runId: ctx.run.runId,
    })).hops;
    const hop = nextHop(batch, [...contextHops, ...readHops]);
    if (overHopLimit(hop)) {
      return { ok: false, rejection: { reason: "hop-limit", text: HOP_LIMIT_TEXT } } as const;
    }
    const budget = yield* checkMessageBudget(repository, {
      squire: ctx.squire,
      now: ctx.now,
      roomId,
    });
    if (!budget.ok) {
      return { ok: false, rejection: { reason: "budget", text: budget.text } } as const;
    }
    return { ok: true, hop } as const;
  });

  // ── Sends ──

  const sendDirect = Effect.fn("SquireMessaging.sendDirect")(function* (
    ctx: SquireToolContext,
    kit: SquireToolKit,
    args: SendMessageArgs,
    to: SquireId | "lead",
  ) {
    // The Squire-to-Squire messages setting stops bot-to-bot direct messages; rooms route to nobody instead.
    const botMessages = (yield* settings.getSettings).squire.botMessages;
    if (!botMessages) {
      return yield* reject(
        ctx,
        kit,
        { reason: "switch", text: "Squire-to-Squire messages are off in Settings." },
        null,
      );
    }
    const resolved = yield* resolveRecipient(ctx, to);
    if (!resolved.ok) return yield* reject(ctx, kit, resolved.rejection, null);
    const recipient = resolved.recipient;
    const guarded = yield* guard(ctx, kit, args, null);
    if (!guarded.ok) return yield* reject(ctx, kit, guarded.rejection, null);
    const hop = guarded.hop;
    return yield* kit.commit(
      ctx,
      null,
      Effect.gen(function* () {
        const eventKey = {
          squireId: recipient.id,
          kind: "message",
          threadId: null,
          stateKey: ctx.key,
        } as const;
        yield* repository.insertEvent({
          squire_id: recipient.id,
          thread_id: null,
          kind: "message",
          state_key: ctx.key,
          payload_json: encodeEvent({
            type: "message",
            messageKey: ctx.key,
            from: participantOf(ctx.squire),
            hop,
            body: args.body,
            ...(args.refs !== undefined && args.refs.length > 0 ? { refs: args.refs } : {}),
            ...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
          }),
          status: "pending",
          defer_reason: null,
          not_before: ctx.now,
          batch_id: null,
          created_at: ctx.now,
        });
        const event = yield* repository.getEventByKey(eventKey);
        yield* chargeMessage(ctx, null);
        yield* logRow(
          ctx,
          "message.sent",
          { to: recipient.id, hop },
          { eventId: Option.getOrNull(Option.map(event, (row) => row.id)) },
        );
        return {
          result: kit.ok(`Sent to ${recipient.name} (message key ${ctx.key}).`, {
            outcome: "sent",
            to: recipient.id,
            messageKey: ctx.key,
            hop,
          }),
          wake: [recipient.id],
        };
      }),
    );
  });

  const postInRoom = Effect.fn("SquireMessaging.postInRoom")(function* (
    ctx: SquireToolContext,
    kit: SquireToolKit,
    args: SendMessageArgs,
    roomId: SquireRoomId,
  ) {
    const guarded = yield* guard(ctx, kit, args, roomId);
    if (!guarded.ok) return yield* reject(ctx, kit, guarded.rejection, roomId);
    const hop = guarded.hop;
    // `replyTo` is a message key; a room post links the post that key wrote.
    const replied =
      args.replyTo === undefined ? Option.none() : yield* roomStore.getPostByKey(args.replyTo);
    const replyTo = Option.match(replied, {
      onNone: () => null,
      onSome: (post) => (post.room_id === roomId ? post.id : null),
    });
    let afterCommit: Effect.Effect<void> = Effect.void;
    const result = yield* kit.commit(
      ctx,
      null,
      Effect.gen(function* () {
        const written = yield* rooms.postInTransaction({
          roomId,
          author: participantOf(ctx.squire),
          body: args.body,
          refs: args.refs ?? [],
          replyTo,
          hop,
          messageKey: ctx.key,
          now: ctx.now,
        });
        if (!written.ok) {
          yield* logRow(ctx, "message.rejected", { reason: written.reason }, { roomId });
          return { result: kit.refused(written.reason, written.text) };
        }
        if (!written.replayed) {
          yield* chargeMessage(ctx, roomId);
          yield* logRow(
            ctx,
            "message.sent",
            { roomId, postId: written.post.id, hop, recipients: written.wake },
            { roomId, postId: written.post.id },
          );
        }
        afterCommit = written.afterCommit;
        const names: Array<string> = [];
        for (const id of written.wake) {
          const row = yield* repository.getSquire(id);
          names.push(Option.match(row, { onNone: () => id, onSome: (found) => found.name }));
        }
        const woke = names.length === 0 ? "nobody was woken" : `woke ${names.join(", ")}`;
        return {
          result: kit.ok(`Posted in room ${roomId}; ${woke} (message key ${ctx.key}).`, {
            outcome: "posted",
            roomId,
            postId: written.post.id,
            recipients: written.wake,
            messageKey: ctx.key,
            hop,
          }),
          wake: written.wake,
        };
      }),
    );
    yield* afterCommit;
    return result;
  });

  const send = Effect.fn("SquireMessaging.send")(function* (
    ctx: SquireToolContext,
    kit: SquireToolKit,
  ) {
    const decoded = yield* kit.decodeArgs(SendMessageArgs, ctx.args);
    if (!decoded.ok) {
      return yield* kit.refuse(
        ctx,
        "invalid-arguments",
        `Invalid arguments for ${ctx.tool}: ${decoded.message}`,
      );
    }
    const args = decoded.value;
    if ((args.to === undefined) === (args.roomId === undefined)) {
      return yield* kit.refuse(
        ctx,
        "invalid-arguments",
        `Invalid arguments for ${ctx.tool}: give exactly one of \`to\` and \`roomId\`.`,
      );
    }
    return args.roomId !== undefined
      ? yield* postInRoom(ctx, kit, args, args.roomId)
      : yield* sendDirect(ctx, kit, args, args.to!);
  });

  yield* registry.register([{ definition, roles: ["squire", "lead"], call: send }]);
});

export const layer = Layer.effectDiscard(make);
