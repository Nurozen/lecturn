import type { EnvironmentId, SquireCardId, SquireId, ThreadId } from "@lecturn/contracts";
import type { RelayAgentActivityState } from "@lecturn/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  type SquireCardStatRow,
  type SquireNotificationIntentRow,
  SquireRepository,
  type SquireRow,
} from "./SquireRepository.ts";

/** Matches the relay's row text cap, so the published state is already within it. */
const TITLE_MAX_LENGTH = 120;
/**
 * A closed card's intent can lack its mobile row only through a race or a
 * crash, which the next publish or startup settles; older ones are not looked up.
 */
const UNSETTLED_INTENT_WINDOW_MS = 24 * 60 * 60_000;

export interface SquireMobileIntent {
  readonly intentId: number;
  readonly cardId: SquireCardId;
  readonly threadId: ThreadId | null;
  readonly inAttention: boolean;
}

/** What the relay publishes for one Squire, and the intents this publish settles. */
export interface SquireRelayRow {
  readonly squireId: SquireId;
  readonly threadId: ThreadId;
  /** Null while the attention set is empty: a removed row can never ring, `completed` would. */
  readonly state: RelayAgentActivityState | null;
  /** Intents still owed their one mobile `notification.delivery` row, oldest first. */
  readonly pending: ReadonlyArray<SquireMobileIntent>;
  /** Some card in the attention set already reached the phone: the row was in attention. */
  readonly alreadyAlerted: boolean;
}

export type SquireMobileTransportGap = "unlinked" | "disabled" | "policy" | "failed";

export type SquireMobileReport =
  /** `wasInAttention` is unknown when this process has not published the row yet. */
  | { readonly kind: "published"; readonly wasInAttention: boolean | undefined }
  | { readonly kind: "no_transport"; readonly reason: SquireMobileTransportGap };

/**
 * The mobile half of Notify. A Squire's attention set is its open cards
 * that carry an intent (`notification.pushed`), minus those held back by
 * desktop presence until they escalate. The relay publishes one row per Squire
 * from it and reports back; the delivery rows are written here.
 */
export class SquireMobileAttention extends Context.Service<
  SquireMobileAttention,
  {
    /** Home threads whose row may have changed; subscribed before it returns. */
    readonly subscribe: Effect.Effect<Stream.Stream<ThreadId>, never, Scope.Scope>;
    readonly homeThreadIds: Effect.Effect<ReadonlyArray<ThreadId>>;
    readonly isHomeThread: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** None when the thread is no Squire's home thread. */
    readonly row: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<Option.Option<SquireRelayRow>, PersistenceSqlError>;
    /** Writes each pending intent's mobile row: `alerted`, `coalesced`, or `no_transport`. */
    readonly record: (
      row: SquireRelayRow,
      report: SquireMobileReport,
    ) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("lecturn/squire/SquireMobileAttention") {}

const DeliveryData = Schema.Struct({
  outcome: Schema.optionalKey(Schema.String),
  surface: Schema.optionalKey(Schema.String),
  intent: Schema.optionalKey(Schema.Number),
});
const decodeDeliveries = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.fromJsonString(DeliveryData))),
);
const decodeDelivery = Schema.decodeUnknownOption(Schema.fromJsonString(DeliveryData));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const truncate = (text: string) =>
  text.length <= TITLE_MAX_LENGTH ? text : `${text.slice(0, TITLE_MAX_LENGTH - 3).trimEnd()}...`;

/** A decision item counts on one row, the Lead's when the Lead raised it. */
const openDecisionCount = (
  stats: ReadonlyArray<SquireCardStatRow>,
  squire: Pick<SquireRow, "id" | "role">,
  leadId: SquireId | null,
) =>
  stats
    .filter(
      (stat) =>
        stat.kind !== "fyi" &&
        stat.status === "open" &&
        (squire.role === "lead"
          ? stat.squire_id === squire.id
          : stat.owner_squire_id === squire.id && stat.squire_id !== leadId),
    )
    .reduce((sum, stat) => sum + stat.n, 0);

/** Pure: the attention set and the unsettled intents of one Squire's intent rows. */
const resolveAttention = (rows: ReadonlyArray<SquireNotificationIntentRow>) => {
  const attention = new Map<SquireCardId, SquireNotificationIntentRow["kind"]>();
  const pending: Array<SquireMobileIntent> = [];
  let alreadyAlerted = false;
  for (const row of rows) {
    const deliveries = Option.getOrElse(decodeDeliveries(row.deliveries_json), () => []);
    const has = (outcome: string) => deliveries.some((data) => data.outcome === outcome);
    const inAttention = row.status === "open" && row.escalate_at === null;
    if (inAttention) attention.set(row.card_id, row.kind);
    const mobile = deliveries.filter(
      (data) =>
        (data.surface === "mobile" && data.intent === row.intent_id) ||
        // The pre-transport placeholder, written once per intent without a surface.
        (data.surface === undefined && data.outcome === "no_transport"),
    );
    if (
      inAttention &&
      mobile.some((data) => data.outcome === "alerted" || data.outcome === "coalesced")
    ) {
      alreadyAlerted = true;
    }
    // A held intent reaches the phone only through escalation; opened or acted on first, never.
    const held = has("deferred_desktop_active") && !has("escalated");
    if (mobile.length === 0 && !held) {
      pending.push({
        intentId: row.intent_id,
        cardId: row.card_id,
        threadId: row.target_thread_id,
        inAttention,
      });
    }
  }
  return { attention, pending, alreadyAlerted };
};

/** Pure: each pending intent's mobile outcome for one publish report. */
const deliveryOutcomes = (row: SquireRelayRow, report: SquireMobileReport) => {
  if (report.kind === "no_transport") {
    return row.pending.map((intent) => ({
      intent,
      data: { outcome: "no_transport", surface: "mobile", reason: report.reason },
    }));
  }
  // The relay rings only on entry into attention, so one intent per entry alerts.
  let inAttention = report.wasInAttention ?? row.alreadyAlerted;
  return row.pending.map((intent) => {
    if (!intent.inAttention) {
      return { intent, data: { outcome: "no_transport", surface: "mobile", reason: "closed" } };
    }
    const outcome = inAttention ? "coalesced" : "alerted";
    inAttention = true;
    return { intent, data: { outcome, surface: "mobile" } };
  });
};

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository;
  const changes = yield* PubSub.unbounded<ReadonlyArray<ThreadId>>();
  const homeThreads = yield* Ref.make(new Map<ThreadId, SquireId>());
  const keys = new Map<SquireId, { readonly threadId: ThreadId | null; readonly key: string }>();

  // Keyed on what a row reads: the Squire's name and home thread and its card
  // counts. An intent, a dismissal, and an escalation each update a card, so
  // other Squire writes (events, logs) cost one comparison and no publish.
  const refresh = Effect.gen(function* () {
    const [squires, stats] = yield* Effect.all([repository.listSquires, repository.listCardStats]);
    const changed = new Set<ThreadId>();
    const seen = new Set<SquireId>();
    const threads = new Map<ThreadId, SquireId>();
    for (const squire of squires) {
      if (squire.lifecycle === "deleting") continue;
      seen.add(squire.id);
      const threadId = squire.home_thread_id;
      if (threadId !== null) threads.set(threadId, squire.id);
      const key = encodeJson([
        squire.name,
        threadId,
        stats.filter((stat) => stat.squire_id === squire.id || stat.owner_squire_id === squire.id),
      ]);
      const previous = keys.get(squire.id);
      if (previous?.key === key) continue;
      if (previous?.threadId != null && previous.threadId !== threadId) {
        changed.add(previous.threadId);
      }
      if (threadId !== null) changed.add(threadId);
      keys.set(squire.id, { threadId, key });
    }
    for (const [id, previous] of keys) {
      if (seen.has(id)) continue;
      keys.delete(id);
      if (previous.threadId !== null) changed.add(previous.threadId);
    }
    yield* Ref.set(homeThreads, threads);
    if (changed.size > 0) yield* PubSub.publish(changes, [...changed]);
  });

  const repositoryChanges = yield* repository.subscribeChanges;
  yield* refresh;
  yield* Stream.runForEach(repositoryChanges, () =>
    refresh.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Squire mobile attention refresh failed", { cause }),
      ),
    ),
  ).pipe(Effect.forkScoped);

  const row: SquireMobileAttention["Service"]["row"] = ({ environmentId, threadId }) =>
    Effect.gen(function* () {
      const squireId = (yield* Ref.get(homeThreads)).get(threadId);
      if (squireId === undefined) return Option.none();
      const found = yield* repository.getSquire(squireId);
      if (
        Option.isNone(found) ||
        found.value.home_thread_id !== threadId ||
        found.value.lifecycle === "deleting"
      ) {
        return Option.none();
      }
      const squire = found.value;
      const now = yield* DateTime.now;
      const [intents, stats, lead] = yield* Effect.all([
        repository.listNotificationIntents({
          squireId,
          since: DateTime.formatIso(
            DateTime.subtract(now, { milliseconds: UNSETTLED_INTENT_WINDOW_MS }),
          ),
        }),
        repository.listCardStats,
        repository.getLead,
      ]);
      const { attention, pending, alreadyAlerted } = resolveAttention(intents);
      const decisions = openDecisionCount(
        stats,
        squire,
        Option.getOrNull(Option.map(lead, (row) => row.id)),
      );
      // Name and counts only: item text never leaves the environment.
      const count =
        decisions > 0
          ? plural(decisions, "open decision")
          : plural([...attention.values()].filter((kind) => kind === "fyi").length, "update");
      const state: RelayAgentActivityState | null =
        attention.size === 0
          ? null
          : {
              environmentId,
              threadId,
              projectTitle: count,
              threadTitle: truncate(squire.name),
              phase: "waiting_for_input",
              headline: count,
              modelTitle: "Squire",
              updatedAt: DateTime.formatIso(now),
              // Clients redirect a home thread to its Squire view.
              deepLink: `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`,
            };
      return Option.some<SquireRelayRow>({ squireId, threadId, state, pending, alreadyAlerted });
    });

  const record: SquireMobileAttention["Service"]["record"] = (row, report) =>
    Effect.gen(function* () {
      if (row.pending.length === 0) return;
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* repository.transaction(
        Effect.forEach(
          deliveryOutcomes(row, report),
          ({ intent, data }) =>
            Effect.gen(function* () {
              // A concurrent publish of the same row may have settled it already.
              const logged = yield* repository.listCardLog({
                cardId: intent.cardId,
                kinds: ["notification.delivery"],
              });
              const settled = logged.some((entry) => {
                const parsed = Option.getOrUndefined(decodeDelivery(entry.data_json));
                return parsed?.surface === "mobile" && parsed.intent === intent.intentId;
              });
              if (settled) return;
              yield* repository.insertActionLog({
                squire_id: row.squireId,
                kind: "notification.delivery",
                room_id: null,
                post_id: null,
                trigger_id: null,
                task_id: null,
                thread_id: intent.threadId,
                card_id: intent.cardId,
                event_id: null,
                run_id: null,
                invocation_key: null,
                execution_key: null,
                data_json: encodeJson({ ...data, intent: intent.intentId }),
                created_at: at,
              });
            }),
          { discard: true },
        ),
      );
    });

  return SquireMobileAttention.of({
    subscribe: PubSub.subscribe(changes).pipe(
      Effect.map((subscription) =>
        Stream.fromSubscription(subscription).pipe(Stream.flattenIterable),
      ),
    ),
    homeThreadIds: Ref.get(homeThreads).pipe(Effect.map((threads) => [...threads.keys()])),
    isHomeThread: (threadId) => Ref.get(homeThreads).pipe(Effect.map((t) => t.has(threadId))),
    row,
    record,
  });
});

export const layer = Layer.effect(SquireMobileAttention, make);
