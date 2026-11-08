/**
 * A rescope that widens scope is always a proposal, even at Auto; each action logs the state it replaced for `revert`.
 * An execution commits its mutation with its `action.executed` row in one transaction. The policy lock is not
 * reentrant and `SquireService` mutations take it, so mutations here write the store directly.
 * @module squire/SquireControl
 */
import {
  ProjectId,
  SquireCardId,
  SquireCardPayload,
  type SquireControlRevertInput,
  SquireError,
  SquireId,
  type SquireResult,
  ThreadId,
  TrimmedNonEmptyString,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  type SquireActionVerb,
  type SquireControlAction,
  SquireControlBefore,
  type SquireControlIntent,
  type SquireCreateIntent,
  type SquireStoreIntent,
  encodeSquireActionIntent,
  parseSquireActionCommandId,
  squireActionCommandId,
} from "./squireActionIntent.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import { writeLeadItemEvent } from "./squireLeadItems.ts";
import { handOverOrDropQueuedEvents, retireOutOfScope } from "./squireScopeCascade.ts";
import { orSquireError } from "./SquireLifecycle.ts";
import * as squirePolicy from "./squirePolicy.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRules from "./SquireRules.ts";
import * as SquireScope from "./SquireScope.ts";
import * as SquireService from "./SquireService.ts";
import { isSquireThread } from "./squireThread.ts";
import {
  type SquireToolContext,
  type SquireToolHandler,
  type SquireToolKit,
  SquireToolRegistry,
} from "./squireToolKit.ts";
import { policySquireOf } from "./SquireTools.ts";

type CardRow = SquireRepository.SquireCardRow;
type ControlPayload = Extract<SquireCardPayload, { readonly type: "control" }>;
type Grant = { readonly kind: string; readonly targetId: string };

export type SquireControlRefusal = {
  readonly ok: false;
  /** `open`: the card stays a proposal the user can accept; `outdated`: it no longer applies. */
  readonly to: "open" | "outdated";
  readonly reason: string;
};
export type SquireControlOutcome = { readonly ok: true } | SquireControlRefusal;

export class SquireControl extends Context.Service<
  SquireControl,
  {
    /**
     * Executes a held or accepted Squire-store intent. The caller holds the
     * card's owner and target locks; this takes the policy lock itself
     * (except for a Squire create, whose service call takes it). Idempotent
     * on `executionKey`.
     */
    readonly apply: (
      intent: SquireStoreIntent,
      options: {
        readonly executionKey: string;
        readonly now: string;
        readonly verb: SquireActionVerb;
      },
    ) => Effect.Effect<SquireControlOutcome, SquireError>;
    /** `squire.control.revert`: restores what an executed control action replaced. */
    readonly revert: (
      input: typeof SquireControlRevertInput.Type,
    ) => Effect.Effect<typeof SquireResult.Type, SquireError>;
  }
>()("lecturn/squire/SquireControl") {}

const applied: SquireControlOutcome = { ok: true };
const toOpen = (reason: string): SquireControlRefusal => ({ ok: false, to: "open", reason });
const toOutdated = (reason: string): SquireControlRefusal => ({
  ok: false,
  to: "outdated",
  reason,
});

/** A card a concurrent accept or dismiss moved mid-transaction; rolls the transaction back. */
class CardMoved extends Data.TaggedError("CardMoved")<{ readonly reason: string }> {}

const grantKey = (grant: Grant) => `${grant.kind}\u0000${grant.targetId}`;

/** A rescope widens when it adds a grant or removes an exclusion. */
const rescopeWidens = (current: ReadonlyArray<Grant>, next: ReadonlyArray<Grant>) => {
  const before = new Set(current.map(grantKey));
  const after = new Set(next.map(grantKey));
  return (
    next.some((grant) => grant.kind !== "exclusion" && !before.has(grantKey(grant))) ||
    current.some((grant) => grant.kind === "exclusion" && !after.has(grantKey(grant)))
  );
};

/** The intent an accept of a control proposal runs; execution logs the state it replaced. */
export const controlIntentOf = (card: CardRow, payload: ControlPayload): SquireControlIntent => ({
  type: "control",
  action: payload.action,
  leadId: card.squire_id,
  squireId: payload.squireId,
  reason: card.why,
  ...(payload.action === "rescope"
    ? {
        grants: [
          ...(payload.grants ?? []),
          ...(payload.exclusions ?? []).map((threadId) => ({
            kind: "exclusion" as const,
            targetId: threadId,
          })),
        ],
      }
    : {}),
  ...(payload.cardIds === undefined ? {} : { cardIds: payload.cardIds }),
  ...(payload.toSquireId === undefined ? {} : { toSquireId: payload.toSquireId }),
  before: {},
});

const encodeLogData = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodePayload = Schema.encodeSync(Schema.fromJsonString(SquireCardPayload));
const ExecutedControl = Schema.Struct({
  action: Schema.Literal("control"),
  control: Schema.Literals(["pause", "resume", "rescope", "forward", "merge"]),
  squireId: Schema.NullOr(SquireId),
  toSquireId: Schema.optionalKey(SquireId),
  cardIds: Schema.optionalKey(Schema.Array(SquireCardId)),
  before: SquireControlBefore,
});
const decodeExecuted = Schema.decodeUnknownOption(Schema.fromJsonString(ExecutedControl));
const Reverted = Schema.Struct({ logEntryId: Schema.Number, requestId: Schema.String });
const decodeReverted = Schema.decodeUnknownOption(Schema.fromJsonString(Reverted));

// ── Tool arguments ──

const Reason = TrimmedNonEmptyString.check(Schema.isMaxLength(1000));
const StatusArgs = Schema.Struct({ squireId: SquireId, reason: Reason });
const ScopeGrant = Schema.Struct({
  kind: Schema.Literals(["thread", "project", "staveSpace", "staveSaga"]),
  targetId: TrimmedNonEmptyString,
});
const RescopeArgs = Schema.Struct({
  squireId: SquireId,
  grants: Schema.Array(ScopeGrant),
  exclusions: Schema.optionalKey(Schema.Array(ThreadId)),
  reason: Reason,
});
const ForwardArgs = Schema.Struct({ itemId: SquireCardId, toSquireId: SquireId, reason: Reason });

const str = (description: string) => ({ type: "string", description });
const reasonProp = str("Why, in one sentence the user reads on the item.");
const squireIdProp = str("A Squire's id, from squire_list_items.");
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
const MANAGE_NOTE =
  "Uses the Manage Squires permission: at Recommend it becomes a proposal item the user accepts; at Auto it runs after the undo window.";

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const scope = yield* SquireScope.SquireScope;
  const rules = yield* SquireRules.SquireRules;
  const service = yield* SquireService.SquireService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const registry = yield* SquireToolRegistry;
  const { withPolicyLock } = yield* SquirePolicyLock.SquirePolicyLock;
  const delivery = yield* Effect.serviceOption(SquireDelivery.SquireDelivery);

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const wake = (lead: Option.Option<SquireId>) =>
    Option.isSome(lead) && Option.isSome(delivery) ? delivery.value.wake(lead.value) : Effect.void;

  /** A Squire the Lead manages: never the Lead, never one being deleted. */
  const managed = (squireId: SquireId | null | undefined) =>
    squireId == null
      ? Effect.succeed(Option.none<SquireRepository.SquireRow>())
      : repository
          .getSquire(squireId)
          .pipe(
            Effect.map(
              Option.filter((row) => row.role === "squire" && row.lifecycle !== "deleting"),
            ),
          );

  const grantsOf = (squireId: SquireId) =>
    repository
      .listGrants(squireId)
      .pipe(
        Effect.map((rows) =>
          rows.map((row) => ({ kind: row.kind, targetId: row.target_id, origin: row.origin })),
        ),
      );

  /** One open card per (raiser, thread, kind). */
  const openSlotTaken = (squireId: SquireId, card: CardRow) =>
    card.target_thread_id === null
      ? Effect.succeed(false)
      : repository
          .listCards({
            squireId,
            targetThreadId: card.target_thread_id,
            kinds: [card.kind],
            statuses: ["open"],
          })
          .pipe(Effect.map((open) => open.some((other) => other.id !== card.id)));

  // ── Checks, at raise and again at execution ──

  type Checked =
    | {
        readonly ok: true;
        readonly title: string;
        readonly before: SquireControlBefore;
        readonly widens: boolean;
        /** What the forward or merge writes, re-checked by compare-and-set at commit. */
        readonly moves: ReadonlyArray<{
          readonly card: CardRow;
          readonly squireId: SquireId;
          readonly ownerSquireId: SquireId;
        }>;
      }
    | SquireControlRefusal;

  const check = Effect.fn("SquireControl.check")(function* (intent: SquireControlIntent) {
    const none = { widens: false, moves: [] as Array<never> };
    switch (intent.action) {
      case "pause":
      case "resume": {
        const row = yield* managed(intent.squireId);
        if (Option.isNone(row)) return toOutdated("that Squire no longer exists");
        const want = intent.action === "pause" ? "paused" : "active";
        if (row.value.status === want) {
          return toOutdated(`${row.value.name} is already ${want}`);
        }
        return {
          ok: true as const,
          ...none,
          title: `${intent.action === "pause" ? "Pause" : "Resume"} ${row.value.name}`,
          before: { status: row.value.status },
        };
      }
      case "rescope": {
        const row = yield* managed(intent.squireId);
        if (Option.isNone(row)) return toOutdated("that Squire no longer exists");
        const current = yield* grantsOf(row.value.id);
        const next = intent.grants ?? [];
        const same =
          current.length === new Set(next.map(grantKey)).size &&
          current.every((grant) => next.some((other) => grantKey(other) === grantKey(grant)));
        if (same) return toOutdated(`${row.value.name}'s scope already matches`);
        return {
          ok: true as const,
          ...none,
          widens: rescopeWidens(current, next),
          title: `Rescope ${row.value.name}`,
          before: { grants: current },
        };
      }
      case "forward": {
        const card = Option.getOrUndefined(
          yield* repository.getCard(intent.cardIds?.[0] ?? SquireCardId.make("-")),
        );
        if (card === undefined || card.status !== "open") {
          return toOutdated("the item is no longer open");
        }
        if (card.target_thread_id === null) {
          return toOutdated("only an item on a thread can be forwarded");
        }
        const to = yield* managed(intent.toSquireId);
        if (Option.isNone(to)) return toOutdated("that Squire no longer exists");
        if (card.owner_squire_id === to.value.id) {
          return toOutdated(`the item is already ${to.value.name}'s`);
        }
        if (!(yield* scope.isTracked(to.value.id, card.target_thread_id))) {
          return toOpen(`${to.value.name}'s scope does not cover that item's thread`);
        }
        // The Lead's own items stay raised by it; only their owner changes.
        const squireId = card.squire_id === intent.leadId ? card.squire_id : to.value.id;
        if (squireId !== card.squire_id && (yield* openSlotTaken(squireId, card))) {
          return toOpen(
            `${to.value.name} already has an open item for that thread; merge them instead`,
          );
        }
        return {
          ok: true as const,
          widens: false,
          title: `Forward "${card.title}" to ${to.value.name}`,
          before: {
            cards: [{ id: card.id, squireId: card.squire_id, ownerSquireId: card.owner_squire_id }],
          },
          moves: [{ card, squireId, ownerSquireId: to.value.id }],
        };
      }
      case "merge": {
        const ids = [...new Set(intent.cardIds ?? [])];
        if (ids.length < 2) return toOutdated("merging needs two or more items");
        const cards: Array<CardRow> = [];
        for (const id of ids) {
          const card = Option.getOrUndefined(yield* repository.getCard(id));
          if (card === undefined || card.status !== "open") {
            return toOutdated("an item is no longer open");
          }
          cards.push(card);
        }
        const [kept] = cards;
        const duplicates =
          kept!.target_thread_id !== null &&
          cards.every(
            (card) => card.target_thread_id === kept!.target_thread_id && card.kind === kept!.kind,
          ) &&
          new Set(cards.map((card) => card.squire_id)).size === cards.length;
        if (!duplicates) {
          return toOutdated(
            "only duplicates merge: items of one kind on the same thread, each raised by a different Squire",
          );
        }
        return {
          ok: true as const,
          widens: false,
          title: `Merge ${cards.length} duplicate items into "${kept!.title}"`,
          before: {
            cards: cards.map((card) => ({
              id: card.id,
              squireId: card.squire_id,
              ownerSquireId: card.owner_squire_id,
            })),
          },
          moves: [],
        };
      }
    }
  });

  // ── Store mutations (inside a transaction, under the policy lock) ──

  /** Pauses as `SquireService.setStatus` does. Returns the Lead to wake. */
  const pauseRows = Effect.fn("SquireControl.pauseRows")(function* (
    squireId: SquireId,
    now: string,
  ) {
    yield* handOverOrDropQueuedEvents(repository, scope, squireId);
    let lead = Option.none<SquireId>();
    for (const cardId of yield* repository.openHeldCards({ squireId, updatedAt: now })) {
      const card = yield* repository.getCard(cardId);
      if (Option.isNone(card)) continue;
      const woken = yield* writeLeadItemEvent(repository, {
        transition: "raised",
        card: card.value,
        now,
      });
      if (Option.isSome(woken)) lead = woken;
    }
    yield* repository.updateSquire({ id: squireId, patch: { status: "paused" }, updatedAt: now });
    return lead;
  });

  const resumeRows = (squireId: SquireId, now: string) =>
    repository
      .updateSquire({ id: squireId, patch: { status: "active" }, updatedAt: now })
      .pipe(Effect.as(Option.none<SquireId>()));

  /** As `SquireService.update` replaces grants: kept grants keep their origin. */
  const replaceGrants = Effect.fn("SquireControl.replaceGrants")(function* (
    squireId: SquireId,
    grants: ReadonlyArray<Grant & { readonly origin?: "granted" | "created" }>,
    now: string,
  ) {
    const wanted = new Set(grants.map(grantKey));
    for (const grant of yield* repository.listGrants(squireId)) {
      if (!wanted.has(grantKey({ kind: grant.kind, targetId: grant.target_id }))) {
        yield* repository.deleteGrant({ squireId, kind: grant.kind, targetId: grant.target_id });
      }
    }
    for (const grant of grants) {
      yield* repository.insertGrant({
        squire_id: squireId,
        kind: grant.kind as SquireRepository.SquireGrantRow["kind"],
        target_id: grant.targetId,
        origin: grant.origin ?? "granted",
        created_at: now,
      });
    }
    yield* rules.disableOutOfScope(squireId);
    const lead = yield* retireOutOfScope(repository, scope, { squireId, now });
    yield* repository.updateSquire({ id: squireId, patch: {}, updatedAt: now });
    return lead;
  });

  const moveCard = (
    cardId: SquireCardId,
    patch: { readonly squire_id: SquireId; readonly owner_squire_id: SquireId },
    now: string,
  ) =>
    repository
      .updateCard({ id: cardId, fromStatuses: ["open"], patch, updatedAt: now })
      .pipe(
        Effect.flatMap((moved) =>
          Option.isSome(moved)
            ? Effect.void
            : Effect.fail(new CardMoved({ reason: "the item is no longer open" })),
        ),
      );

  const mutate = Effect.fn("SquireControl.mutate")(function* (
    intent: SquireControlIntent,
    checked: Extract<Checked, { readonly ok: true }>,
    now: string,
  ) {
    switch (intent.action) {
      case "pause":
        return yield* pauseRows(intent.squireId!, now);
      case "resume":
        return yield* resumeRows(intent.squireId!, now);
      case "rescope":
        return yield* replaceGrants(intent.squireId!, intent.grants ?? [], now);
      case "forward":
        for (const move of checked.moves) {
          yield* moveCard(
            move.card.id,
            { squire_id: move.squireId, owner_squire_id: move.ownerSquireId },
            now,
          );
        }
        return Option.none<SquireId>();
      case "merge":
        // The kept item stays open; each duplicate is superseded by it.
        for (const cardId of (intent.cardIds ?? []).slice(1)) {
          const moved = yield* repository.updateCard({
            id: cardId,
            fromStatuses: ["open"],
            patch: { status: "outdated", resolution: "superseded", executes_at: null },
            updatedAt: now,
          });
          if (Option.isNone(moved)) {
            return yield* new CardMoved({ reason: "an item is no longer open" });
          }
        }
        return Option.none<SquireId>();
    }
  });

  /** The Lead's own Manage Squires level; `paused` is checked apart. */
  const manageLevel = (lead: SquireRepository.SquireRow) =>
    policySquireOf(lead).permissions.manageSquires ?? "off";

  const applyControl = (
    intent: SquireControlIntent,
    options: {
      readonly executionKey: string;
      readonly now: string;
      readonly verb: SquireActionVerb;
    },
  ) =>
    withPolicyLock(
      Effect.gen(function* () {
        if (Option.isSome(yield* repository.getExecution(options.executionKey))) return applied;
        const lead = yield* repository.getSquire(intent.leadId);
        if (Option.isNone(lead) || lead.value.lifecycle === "deleting") {
          return toOutdated("the Lead no longer exists");
        }
        const level = manageLevel(lead.value);
        if (options.verb === "execute") {
          if (lead.value.status === "paused") return toOpen("the Lead is paused");
          if (level !== "auto") return toOpen("Manage Squires is no longer Auto");
        } else if (level === "off") {
          // The user's own accept needs only a class that is not Off.
          return toOpen("Manage Squires is Off for the Lead");
        }
        const checked = yield* check(intent);
        if (!checked.ok) return checked;
        if (options.verb === "execute" && checked.widens) {
          return toOpen("a rescope that widens scope needs the user's accept");
        }
        const cardId = parseSquireActionCommandId(options.executionKey)?.cardId;
        const committed = yield* repository
          .transaction(
            Effect.gen(function* () {
              const woken = yield* mutate(intent, checked, options.now);
              yield* repository.insertActionLog({
                squire_id: intent.leadId,
                kind: "action.executed",
                room_id: null,
                post_id: null,
                trigger_id: null,
                task_id: null,
                thread_id: checked.moves[0]?.card.target_thread_id ?? null,
                card_id: cardId === undefined ? null : SquireCardId.make(cardId),
                event_id: null,
                run_id: null,
                invocation_key: null,
                execution_key: options.executionKey,
                data_json: encodeLogData({
                  action: "control",
                  control: intent.action,
                  verb: options.verb,
                  squireId: intent.squireId,
                  ...(intent.toSquireId === undefined ? {} : { toSquireId: intent.toSquireId }),
                  ...(intent.cardIds === undefined ? {} : { cardIds: intent.cardIds }),
                  ...(intent.grants === undefined ? {} : { grants: intent.grants }),
                  reason: intent.reason,
                  before: checked.before,
                }),
                created_at: options.now,
              });
              return woken;
            }),
          )
          .pipe(Effect.result);
        if (Result.isFailure(committed)) {
          return committed.failure instanceof CardMoved
            ? toOutdated(committed.failure.reason)
            : yield* Effect.fail(committed.failure);
        }
        yield* wake(committed.success);
        return applied;
      }),
    );

  /** Accepting a Lead proposal creates exactly that Squire; `requestId` makes a retry the same one. */
  const applyCreate = Effect.fn("SquireControl.applyCreate")(function* (
    intent: SquireCreateIntent,
    options: {
      readonly executionKey: string;
      readonly now: string;
      readonly verb: SquireActionVerb;
    },
  ) {
    if (Option.isSome(yield* repository.getExecution(options.executionKey))) return applied;
    const created = yield* service
      .create({ ...intent.input, requestId: intent.requestId })
      .pipe(Effect.result);
    if (Result.isFailure(created)) return toOpen(created.failure.message);
    const lead = yield* repository.getLead;
    const cardId = parseSquireActionCommandId(options.executionKey)?.cardId;
    yield* repository.transaction(
      Effect.gen(function* () {
        if (Option.isSome(yield* repository.getExecution(options.executionKey))) return;
        yield* repository.insertActionLog({
          squire_id: Option.match(lead, {
            onNone: () => created.success.id,
            onSome: (row) => row.id,
          }),
          kind: "action.executed",
          room_id: null,
          post_id: null,
          trigger_id: null,
          task_id: null,
          thread_id: null,
          card_id: cardId === undefined ? null : SquireCardId.make(cardId),
          event_id: null,
          run_id: null,
          invocation_key: null,
          execution_key: options.executionKey,
          data_json: encodeLogData({
            action: "create_squire",
            verb: options.verb,
            squireId: created.success.id,
            requestId: intent.requestId,
          }),
          created_at: options.now,
        });
      }),
    );
    return applied;
  });

  const apply: SquireControl["Service"]["apply"] = (intent, options) =>
    (intent.type === "control" ? applyControl(intent, options) : applyCreate(intent, options)).pipe(
      orSquireError("run the Lead's action"),
      Effect.withSpan("SquireControl.apply", { attributes: { type: intent.type } }),
    );

  // ── Revert (the setup sheet) ──

  const refuse = (message: string) => new SquireError({ code: "invalid_request", message });

  /** Every `control.reverted` row after the action, paged forward. */
  const revertsOf = Effect.fn("SquireControl.revertsOf")(function* (
    leadId: SquireId,
    logEntryId: number,
  ) {
    const found: Array<typeof Reverted.Type> = [];
    let afterId = logEntryId;
    for (;;) {
      const page = yield* repository.listActionLog({
        squireId: leadId,
        kinds: ["control.reverted"],
        afterId,
        limit: 200,
      });
      for (const row of page) {
        const data = decodeReverted(row.data_json);
        if (Option.isSome(data) && data.value.logEntryId === logEntryId) found.push(data.value);
      }
      if (page.length < 200) return found;
      afterId = page.at(-1)!.id;
    }
  });

  const revert: SquireControl["Service"]["revert"] = Effect.fn("SquireControl.revert")(
    function* (input) {
      const affected = yield* withPolicyLock(
        Effect.gen(function* () {
          const lead = yield* repository.getLead;
          if (Option.isNone(lead)) {
            return yield* new SquireError({ code: "not_found", message: "There is no Lead." });
          }
          const leadId = lead.value.id;
          const [row] = yield* repository.listActionLog({
            squireId: leadId,
            kinds: ["action.executed"],
            afterId: input.logEntryId - 1,
            limit: 1,
          });
          const data = row?.id === input.logEntryId ? decodeExecuted(row.data_json) : Option.none();
          if (row === undefined || Option.isNone(data)) {
            return yield* new SquireError({
              code: "not_found",
              message: "That Lead control action no longer exists.",
            });
          }
          const action = data.value;
          const [first] = action.before.cards ?? [];
          const affectedId =
            action.control === "forward" || action.control === "merge"
              ? (first?.ownerSquireId ?? leadId)
              : action.squireId!;
          const prior = yield* revertsOf(leadId, input.logEntryId);
          if (prior.length > 0) {
            if (prior.some((entry) => entry.requestId === input.requestId)) return affectedId;
            return yield* refuse("This control action was already reverted.");
          }
          const now = yield* nowIso;
          const restore = yield* restoreOf(action, now);
          const woken = yield* repository.transaction(
            Effect.gen(function* () {
              const lead = yield* restore;
              yield* repository.insertActionLog({
                squire_id: leadId,
                kind: "control.reverted",
                room_id: null,
                post_id: null,
                trigger_id: null,
                task_id: null,
                thread_id: row.thread_id,
                card_id: row.card_id,
                event_id: null,
                run_id: null,
                invocation_key: null,
                execution_key: null,
                data_json: encodeLogData({
                  logEntryId: input.logEntryId,
                  requestId: input.requestId,
                  control: action.control,
                  squireId: action.squireId,
                  restored: action.before,
                }),
                created_at: now,
              });
              return lead;
            }),
          );
          yield* wake(woken);
          return affectedId;
        }),
      );
      const squire = yield* service.get(affected);
      if (Option.isNone(squire)) {
        return yield* new SquireError({
          code: "not_found",
          message: "This Squire no longer exists.",
        });
      }
      return { squire: squire.value };
    },
    Effect.catchIf(
      (cause): cause is CardMoved => cause instanceof CardMoved,
      (cause) => Effect.fail(refuse(`Not reverted: ${cause.reason}.`)),
    ),
    orSquireError("revert the Lead's action"),
  );

  /** Checks the action can be undone now; the returned effect writes the undo in the caller's transaction. */
  const restoreOf = Effect.fn("SquireControl.restoreOf")(function* (
    action: typeof ExecutedControl.Type,
    now: string,
  ) {
    switch (action.control) {
      case "pause":
      case "resume": {
        const row = yield* managed(action.squireId);
        if (Option.isNone(row)) return yield* refuse("That Squire no longer exists.");
        const status = action.before.status ?? (action.control === "pause" ? "active" : "paused");
        if (row.value.status === status) return Effect.succeed(Option.none<SquireId>());
        return status === "paused" ? pauseRows(row.value.id, now) : resumeRows(row.value.id, now);
      }
      case "rescope": {
        const row = yield* managed(action.squireId);
        if (Option.isNone(row)) return yield* refuse("That Squire no longer exists.");
        return replaceGrants(row.value.id, action.before.grants ?? [], now);
      }
      case "forward": {
        const [was] = action.before.cards ?? [];
        const card =
          was === undefined ? undefined : Option.getOrUndefined(yield* repository.getCard(was.id));
        if (was === undefined || card === undefined || card.status !== "open") {
          return yield* refuse("This item is no longer open, so the forward cannot be undone.");
        }
        if (card.owner_squire_id !== action.toSquireId) {
          return yield* refuse("This item moved again since, so it cannot be forwarded back.");
        }
        if (was.squireId !== card.squire_id && (yield* openSlotTaken(was.squireId, card))) {
          return yield* refuse(
            "The original Squire has a newer open item for that thread, so this cannot move back.",
          );
        }
        return moveCard(
          card.id,
          { squire_id: was.squireId, owner_squire_id: was.ownerSquireId },
          now,
        ).pipe(Effect.as(Option.none<SquireId>()));
      }
      case "merge": {
        const [kept, ...merged] = action.before.cards ?? [];
        const keptRow =
          kept === undefined
            ? undefined
            : Option.getOrUndefined(yield* repository.getCard(kept.id));
        if (keptRow === undefined || keptRow.status !== "open") {
          return yield* refuse("The merged item is no longer open, so it cannot be unmerged.");
        }
        const rows: Array<CardRow> = [];
        for (const entry of merged) {
          const card = Option.getOrUndefined(yield* repository.getCard(entry.id));
          if (
            card === undefined ||
            card.status !== "outdated" ||
            card.resolution !== "superseded"
          ) {
            return yield* refuse("A merged item changed since, so the merge cannot be undone.");
          }
          if (yield* openSlotTaken(card.squire_id, card)) {
            return yield* refuse(
              "A Squire has a newer open item for that thread, so the merge cannot be undone.",
            );
          }
          rows.push(card);
        }
        return Effect.gen(function* () {
          for (const card of rows) {
            const reopened = yield* repository.updateCard({
              id: card.id,
              fromStatuses: ["outdated"],
              patch: { status: "open", resolution: null },
              updatedAt: now,
            });
            if (Option.isNone(reopened)) {
              return yield* new CardMoved({ reason: "a merged item changed since" });
            }
          }
          return Option.none<SquireId>();
        });
      }
    }
  });

  // ── Tool handlers ──

  const validateAdded = Effect.fn("SquireControl.validateAdded")(function* (
    current: ReadonlyArray<Grant>,
    next: ReadonlyArray<Grant>,
  ) {
    const known = new Set(current.map(grantKey));
    for (const grant of next) {
      if (known.has(grantKey(grant))) continue;
      if (grant.kind === "thread") {
        const shell = yield* projections.getThreadShell(ThreadId.make(grant.targetId));
        if (shell === null) return `thread ${grant.targetId} no longer exists`;
        if (isSquireThread(shell)) return "a Squire cannot track a Squire's thread";
      } else if (grant.kind === "project") {
        if (Option.isNone(yield* projects.get(ProjectId.make(grant.targetId)))) {
          return `project ${grant.targetId} no longer exists`;
        }
      }
    }
    return undefined;
  });

  const raise = Effect.fn("SquireControl.raise")(function* (
    ctx: SquireToolContext,
    kit: SquireToolKit,
    intent: SquireControlIntent,
  ) {
    const decision = squirePolicy.decide({
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
    if (decision.level === "off") {
      return yield* kit.refuse(
        ctx,
        decision.reason,
        decision.reason === "paused"
          ? "The Lead is paused, so it cannot manage Squires."
          : "Manage Squires is Off for the Lead, so it cannot pause, resume, rescope, forward, or merge.",
        { decision: { level: "off" } },
      );
    }
    const checked = yield* check(intent);
    if (!checked.ok) {
      return yield* kit.refuse(ctx, "invalid", `Not done: ${checked.reason}.`, {
        decision: { reason: checked.reason },
      });
    }
    if (intent.action === "rescope") {
      const invalid = yield* validateAdded(checked.before.grants ?? [], intent.grants ?? []);
      if (invalid !== undefined) {
        return yield* kit.refuse(ctx, "invalid", `Not done: ${invalid}.`);
      }
    }
    // Only narrowing runs at Auto.
    const held = decision.level === "auto" && !checked.widens;
    const cardId = SquireCardId.make(`card:proposal:${ctx.squire.id}:${ctx.key.slice(0, 24)}`);
    const executesAt = held ? kit.holdUntil(ctx) : null;
    const push = !held && kit.notifyOn(ctx);
    const grants = intent.grants ?? [];
    const payload: ControlPayload = {
      type: "control",
      action: intent.action,
      squireId: intent.squireId,
      ...(intent.action === "rescope"
        ? {
            grants: grants.filter((grant) => grant.kind !== "exclusion"),
            exclusions: grants
              .filter((grant) => grant.kind === "exclusion")
              .map((grant) => ThreadId.make(grant.targetId)),
          }
        : {}),
      ...(intent.cardIds === undefined ? {} : { cardIds: intent.cardIds }),
      ...(intent.toSquireId === undefined ? {} : { toSquireId: intent.toSquireId }),
    };
    const threadId = checked.moves[0]?.card.target_thread_id ?? null;
    return yield* kit.commit(
      ctx,
      null,
      Effect.gen(function* () {
        const denied = yield* kit.deniedRefusal(ctx, {
          kind: "proposal",
          targetThreadId: null,
          projectId: null,
          title: checked.title,
        });
        if (Option.isSome(denied)) return { result: denied.value };
        yield* repository.insertCard({
          id: cardId,
          squire_id: ctx.squire.id,
          owner_squire_id: ctx.squire.id,
          kind: "proposal",
          status: held ? "held" : "open",
          // No target: a control item never takes a thread's one open slot.
          target_thread_id: null,
          project_id: null,
          title: checked.title,
          why: intent.reason,
          payload_json: encodePayload(payload),
          evidence_json: "{}",
          trigger_json: "{}",
          intent_json: held
            ? encodeSquireActionIntent({ ...intent, before: checked.before })
            : null,
          origin: ctx.run.origin === "unknown" ? "event" : ctx.run.origin,
          steer_kind: null,
          routed_task_id: null,
          rule_id: null,
          finding_key: null,
          escalate_at: null,
          opened_at: null,
          executes_at: executesAt,
          expires_at: held
            ? null
            : SquireRepository.squireApprovalExpiresAt(
                {
                  kind: "proposal",
                  origin: ctx.run.origin === "unknown" ? "event" : ctx.run.origin,
                },
                ctx.now,
              ),
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
            control: intent.action,
            squireId: intent.squireId,
            ...(intent.toSquireId === undefined ? {} : { toSquireId: intent.toSquireId }),
            ...(intent.cardIds === undefined ? {} : { cardIds: intent.cardIds }),
            before: checked.before,
            ...(executesAt === null ? {} : { executesAt }),
            ...(checked.widens ? { widens: true } : {}),
          },
          { threadId, cardId },
        );
        yield* kit.logRow(
          ctx,
          "decision.recorded",
          {
            tool: ctx.tool,
            level: held ? "auto" : "recommend",
            reason: checked.widens && decision.level === "auto" ? "widens" : decision.reason,
          },
          { threadId, cardId },
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
              ? `Held: ${checked.title}. It runs at ${executesAt} unless the user presses Undo.`
              : checked.widens && decision.level === "auto"
                ? `Proposed: ${checked.title}. Widening a Squire's scope always waits for the user.`
                : `Proposed: ${checked.title}. The user decides.`,
            {
              cardId,
              status: held ? "held" : "open",
              ...(executesAt === null ? {} : { executesAt }),
            },
          ),
        };
      }),
    );
  });

  const handler = <S extends Schema.Top & { readonly DecodingServices: never }>(
    definitionOf: SquireToolHandler["definition"],
    schema: S,
    intentOf: (args: S["Type"], ctx: SquireToolContext) => SquireControlIntent,
  ): SquireToolHandler => ({
    definition: definitionOf,
    roles: ["lead"],
    call: Effect.fn("SquireControl.call")(function* (ctx, kit) {
      const decoded = yield* kit.decodeArgs(schema, ctx.args);
      if (!decoded.ok) {
        return yield* kit.refuse(
          ctx,
          "invalid-arguments",
          `Invalid arguments for ${ctx.tool}: ${decoded.message}`,
        );
      }
      return yield* raise(ctx, kit, intentOf(decoded.value, ctx));
    }),
  });

  const base = (action: SquireControlAction, ctx: SquireToolContext, reason: string) => ({
    type: "control" as const,
    action,
    leadId: ctx.squire.id,
    reason,
    before: {},
  });

  yield* registry.register([
    handler(
      definition(
        "squire_pause",
        `Pause one of your Squires: it takes no events and its held actions become recommendations. ${MANAGE_NOTE}`,
        { squireId: squireIdProp, reason: reasonProp },
        ["squireId", "reason"],
      ),
      StatusArgs,
      (args, ctx) => ({ ...base("pause", ctx, args.reason), squireId: args.squireId }),
    ),
    handler(
      definition(
        "squire_resume",
        `Resume a paused Squire. ${MANAGE_NOTE}`,
        { squireId: squireIdProp, reason: reasonProp },
        ["squireId", "reason"],
      ),
      StatusArgs,
      (args, ctx) => ({ ...base("resume", ctx, args.reason), squireId: args.squireId }),
    ),
    handler(
      definition(
        "squire_rescope",
        `Replace a Squire's whole scope with these grants and exclusions. Adding a grant or removing an exclusion widens scope and always waits for the user; only narrowing runs at Auto. ${MANAGE_NOTE}`,
        {
          squireId: squireIdProp,
          grants: {
            type: "array",
            description: "Every grant the Squire keeps or gains.",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["thread", "project", "staveSpace", "staveSaga"] },
                targetId: str("The thread, project, Stave space, or saga id."),
              },
              required: ["kind", "targetId"],
              additionalProperties: false,
            },
          },
          exclusions: {
            type: "array",
            description: "Threads inside a granted container the Squire must not track.",
            items: { type: "string" },
          },
          reason: reasonProp,
        },
        ["squireId", "grants", "reason"],
      ),
      RescopeArgs,
      (args, ctx) => ({
        ...base("rescope", ctx, args.reason),
        squireId: args.squireId,
        grants: [
          ...args.grants,
          ...(args.exclusions ?? []).map((threadId) => ({
            kind: "exclusion" as const,
            targetId: threadId,
          })),
        ],
      }),
    ),
    handler(
      definition(
        "squire_forward_item",
        `Move an open item to another Squire whose scope covers the item's thread. ${MANAGE_NOTE}`,
        {
          itemId: str("The item's id, from squire_list_items."),
          toSquireId: squireIdProp,
          reason: reasonProp,
        },
        ["itemId", "toSquireId", "reason"],
      ),
      ForwardArgs,
      (args, ctx) => ({
        ...base("forward", ctx, args.reason),
        squireId: null,
        cardIds: [args.itemId],
        toSquireId: args.toSquireId,
      }),
    ),
  ]);

  return SquireControl.of({ apply, revert });
});

export const layer = Layer.effect(SquireControl, make);
