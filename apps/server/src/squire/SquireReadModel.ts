import {
  ModelSelection,
  type ProjectId,
  type MessageId,
  type RunId,
  Squire,
  SquireActionLogEntry,
  type SquireActionLogListInput,
  type SquireActionLogListResult,
  SquireActionLogKind,
  SquireCardRow,
  SquireError,
  type SquireGesture,
  type SquireId,
  type SquireItemsListInput,
  type SquireItemsListResult,
  type SquireRoomId,
  type SquireRoomRow,
  SquireRuleOffer,
  type SquireSnapshot,
  SquireStoredSummary,
  type SquireSubscribeEvent,
  type SquireSummaryGetInput,
  type SquireSummaryGetResult,
  type SquireTriggerRun,
  type SquireTriggerRunsInput,
  type SquireTriggerRunsResult,
  type SquireTurnOrigin,
  SquireTurnSummary,
  type SquireVocabularyResult,
  type ThreadId,
  SQUIRE_SPEAKING_TOOLS,
} from "@lecturn/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { batchOrigin, deliverMessageId } from "./SquireDelivery.ts";
import { squireCardRowFields } from "./SquireItems.ts";
import { orSquireError } from "./SquireLifecycle.ts";
import * as SquireContainers from "./SquireContainers.ts";
import * as squirePolicy from "./squirePolicy.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRules from "./SquireRules.ts";
import * as SquireScope from "./SquireScope.ts";
import * as SquireSwitch from "./SquireSwitch.ts";
import { toRule } from "./SquireTools.ts";

/**
 * Reads never write. The always-on stream carries compact snapshots only; evidence, card bodies, and logs are fetched
 * by query. Per-Squire `itemsRevision` and `decisionRevision` keep one Squire's FYI from refetching another's queue,
 * and FYI writes never bump `decisionRevision`.
 */
export class SquireReadModel extends Context.Service<
  SquireReadModel,
  {
    /** `snapshot` first, then per-Squire `squire`, `squire-removed`, `lead`, and `room` updates. */
    readonly subscribe: Stream.Stream<SquireSubscribeEvent, SquireError>;
    readonly itemsList: (
      input: typeof SquireItemsListInput.Type,
    ) => Effect.Effect<typeof SquireItemsListResult.Type, SquireError>;
    readonly actionLogList: (
      input: typeof SquireActionLogListInput.Type,
    ) => Effect.Effect<typeof SquireActionLogListResult.Type, SquireError>;
    readonly summaryGet: (
      input: typeof SquireSummaryGetInput.Type,
    ) => Effect.Effect<typeof SquireSummaryGetResult.Type, SquireError>;
    readonly vocabulary: Effect.Effect<typeof SquireVocabularyResult.Type, SquireError>;
    readonly triggerRuns: (
      input: typeof SquireTriggerRunsInput.Type,
    ) => Effect.Effect<typeof SquireTriggerRunsResult.Type, SquireError>;
  }
>()("lecturn/squire/SquireReadModel") {}

type LogRow = SquireRepository.SquireActionLogRow;
type CardStat = SquireRepository.SquireCardStatRow;
type CardStatus = SquireRepository.SquireCardRow["status"];

const RECENT_ACTIVITY = 8;
// A quiet run rarely writes text, so the newest visible message is near the top.
const RECENT_ASSISTANT_MESSAGES = 20;
const DEFAULT_PAGE = 50;
const TRIGGER_RUNS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
// The snapshot reaches every client on every connect, so it carries open rooms
// and recently closed ones only; older rooms stay readable through room posts.
const SNAPSHOT_CLOSED_ROOM_MS = 7 * DAY_MS;
// Thread lifecycle events refresh tracking at once; the TTL catches Stave
// membership changes, which arrive without an event Lecturn sees.
const TRACKING_TTL_MS = 60_000;
/** Thread events that can change which threads a grant covers, or their titles. */
const THREAD_SET_EVENTS: ReadonlySet<string> = new Set([
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.metadata-updated",
]);

/** Statuses of an item still in the queue: the `open` scope of `squire.items.list`. */
const QUEUED_STATUSES: ReadonlyArray<CardStatus> = ["held", "open", "accepting", "executing"];
const queued: ReadonlySet<CardStatus> = new Set(QUEUED_STATUSES);
/** The queued statuses a view lists under "Needs a decision": every one but `held`. */
const waitingOnDecision: ReadonlySet<CardStatus> = new Set(
  QUEUED_STATUSES.filter((status) => status !== "held"),
);
const TRIGGER_KINDS = ["trigger.received", "trigger.rate-limited", "trigger.rejected"];
const RUN_ITEM_KINDS = ["card.created", "action.held"];

const decodeModel = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const parseJson = (text: string | null) =>
  text === null ? Effect.succeed(null) : decodeJson(text);
const decodeSquire = Schema.decodeUnknownEffect(Squire);
const decodeCardRow = Schema.decodeUnknownEffect(SquireCardRow);
const decodeLogEntry = Schema.decodeUnknownEffect(SquireActionLogEntry);
const decodeStoredSummary = Schema.decodeUnknownEffect(SquireStoredSummary);
const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(SquireTurnSummary));
const decodeLogKind = Schema.decodeUnknownSync(SquireActionLogKind);
const decodeMembers = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const LogData = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeLogData = Schema.decodeUnknownOption(LogData);

// Comparison keys only; never parsed back.
const toKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const logData = (row: Pick<LogRow, "data_json">): Readonly<Record<string, unknown>> =>
  Option.getOrElse(decodeLogData(row.data_json), () => ({}));

/**
 * The figure's gesture for one log row; `previous` is the Squire's row just before
 * it, so only the first `event.received` of a delivery batch starts one.
 * Squire creation has no log row, so clients play `greet` from the snapshot.
 */
export const squireActivityGesture = (
  row: Pick<LogRow, "kind" | "data_json">,
  previous?: Pick<LogRow, "kind" | "data_json">,
): SquireGesture | undefined => {
  const data = logData(row);
  switch (row.kind) {
    case "event.received": {
      if (
        previous?.kind === "event.received" &&
        data.batchId !== undefined &&
        logData(previous).batchId === data.batchId
      ) {
        return undefined;
      }
      return data.kind === "voice-note" ? "listen" : "ponder";
    }
    case "action.held":
      return "glance";
    case "action.executed":
      if (data.action === "create_thread" || data.action === "create_squire") return "flourish";
      return data.verb === "accept" ? "nod" : undefined;
    default:
      return undefined;
  }
};

interface HeldEntry {
  readonly cardId: SquireSnapshot["held"][number]["cardId"];
  readonly kind: SquireSnapshot["held"][number]["kind"];
  readonly targetThreadId: ThreadId | null;
  readonly heldOverCardId?: SquireSnapshot["held"][number]["cardId"];
  readonly executesAtMs: number;
}

/** A snapshot whose holds keep their absolute time, so the comparison key never ticks. */
interface Entry {
  readonly base: Omit<SquireSnapshot, "held">;
  readonly held: ReadonlyArray<HeldEntry>;
  readonly key: string;
}

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

interface EnvState {
  readonly generation: number;
  readonly threadSet: number;
  /** Counts home-thread runs that ended; a run's reply reaches no Squire table. */
  readonly homeRunsEnded: number;
  readonly homeThreads: ReadonlySet<ThreadId>;
  readonly lead: SquireId | null;
  readonly entries: ReadonlyMap<SquireId, Entry>;
  readonly rooms: ReadonlyMap<SquireRoomId, { readonly row: SquireRoomRow; readonly key: string }>;
  /** Titles of every tracked thread, for the vocabulary. */
  readonly titles: ReadonlyMap<ThreadId, string>;
}

interface Revisions {
  readonly itemsKey: string;
  readonly decisionKey: string;
  readonly items: number;
  readonly decision: number;
}

interface Tracking {
  readonly key: string;
  readonly at: number;
  readonly bySquire: ReadonlyMap<SquireId, ReadonlyArray<ThreadId>>;
  readonly titles: ReadonlyMap<ThreadId, string>;
  /** Threads tracked by two or more Squires, the only ones a conflict can name. */
  readonly shared: ReadonlyArray<{
    readonly target: squirePolicy.SquirePolicyTarget & { readonly threadId: ThreadId };
    readonly trackers: ReadonlyArray<SquireId>;
  }>;
}

const statKey = (stat: CardStat) =>
  `${stat.squire_id}|${stat.owner_squire_id}|${stat.kind}|${stat.status}|${stat.n}|${stat.last_updated_at}`;
const fingerprint = (stats: ReadonlyArray<CardStat>) => stats.map(statKey).toSorted().join("\n");

const notFound = (message: string) => new SquireError({ code: "not_found", message });

const toRoomRow = (row: SquireRepository.SquireRoomListRow): SquireRoomRow => ({
  id: row.id,
  topic: row.topic,
  status: row.status,
  muted: row.muted !== 0,
  members: Option.getOrElse(decodeMembers(row.members_json), () => []) as SquireRoomRow["members"],
  includesLead: row.includes_lead !== 0,
  unread: row.muted === 0 && row.user_unseen !== 0,
  lastPostAt: row.last_post_at,
});

const renderEntry = (entry: Entry, nowMs: number): SquireSnapshot => ({
  ...entry.base,
  held: entry.held.map(({ executesAtMs, ...held }) => ({
    ...held,
    executesInMs: Math.max(0, Math.round(executesAtMs - nowMs)),
  })),
});

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const scope = yield* SquireScope.SquireScope;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;

  // Revisions live in memory and restart with the process. Clients compare
  // them by inequality only, so counting starts from the boot second: a
  // restart then changes every revision and clients refetch once.
  const revisionBase = Math.floor((yield* Clock.currentTimeMillis) / 1000) % 1_000_000_000;
  const revisions = new Map<SquireId, Revisions>();
  const cache = yield* Ref.make(Option.none<EnvState>());
  const trackingCache = yield* Ref.make(Option.none<Tracking>());
  const refreshLock = Semaphore.makeUnsafe(1);

  // A new thread in a granted project changes a Squire's tracked count without
  // any Squire write, so thread lifecycle events refresh the snapshot too.
  const threadSet = yield* Ref.make(0);
  const threadSetChanges = yield* PubSub.sliding<void>(1);
  const homeRunsEnded = yield* Ref.make(0);
  const lastMessages = new Map<
    SquireId,
    {
      readonly homeThreadId: ThreadId;
      readonly homeRunsEnded: number;
      readonly at: string | undefined;
    }
  >();
  const rules = yield* Effect.serviceOption(SquireRules.SquireRules);
  const eventStore = yield* Effect.serviceOption(OrchestrationEventStore.OrchestrationEventStore);
  const fixtureStave = yield* Effect.serviceOption(SquireContainers.SquireFixtureStave);
  const squireSwitch = yield* SquireSwitch.SquireSwitch;
  const threadSetChanged = Ref.update(threadSet, (n) => n + 1).pipe(
    Effect.andThen(PubSub.publish(threadSetChanges, undefined)),
  );
  // Followed only while Squires are on; each on period first counts as a
  // change, since the off period's thread events went unseen.
  if (Option.isSome(eventStore)) {
    const store = eventStore.value;
    yield* Effect.forkScoped(
      squireSwitch.whileOn(
        Effect.gen(function* () {
          const highWater = yield* store.latestApplicationSequence.pipe(Effect.option);
          yield* threadSetChanged;
          if (Option.isNone(highWater)) return;
          yield* Stream.runForEach(
            store.streamApplicationEvents({ afterSequence: highWater.value }),
            (stored) =>
              Effect.gen(function* () {
                if (!("event" in stored)) return;
                const { event } = stored;
                if (THREAD_SET_EVENTS.has(event.type)) return yield* threadSetChanged;
                if (
                  event.type !== "run.updated" ||
                  !TERMINAL_RUN_STATUSES.has(event.payload.status)
                ) {
                  return;
                }
                const state = yield* Ref.get(cache);
                if (Option.isNone(state) || !state.value.homeThreads.has(event.threadId)) return;
                yield* Ref.update(homeRunsEnded, (n) => n + 1);
                yield* PubSub.publish(threadSetChanges, undefined);
              }),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Squire thread-set follower stopped; tracking refreshes by TTL.", {
                cause,
              }),
            ),
          );
        }),
      ),
    );
  }

  // Runs per Squire row inside compute, which owns the span.
  const toSquire = Effect.fnUntraced(function* (
    row: SquireRepository.SquireRow,
    grants: ReadonlyArray<SquireRepository.SquireGrantRow>,
  ) {
    return yield* decodeSquire({
      id: row.id,
      role: row.role,
      name: row.name,
      lifecycle: row.lifecycle,
      status: row.status,
      homeProjectId: row.home_project_id,
      homeThreadId: row.home_thread_id,
      providerInstanceId: row.provider_instance_id,
      modelSelection:
        row.model_selection_json === null ? null : yield* decodeModel(row.model_selection_json),
      summaryModelSelection:
        row.summary_model_selection_json === null
          ? null
          : yield* decodeModel(row.summary_model_selection_json),
      brief: row.brief,
      grants: grants.map((grant) => ({
        kind: grant.kind,
        targetId: grant.target_id,
        origin: grant.origin,
        createdAt: grant.created_at,
      })),
      events: yield* parseJson(row.events_json),
      permissions: yield* parseJson(row.permissions_json),
      budgets: yield* parseJson(row.budgets_json),
      undoWindowSeconds: row.undo_window_seconds,
      companion: yield* parseJson(row.companion_json),
      digest: yield* parseJson(row.digest_json),
      sweep: yield* parseJson(row.sweep_json),
      onboardedAt: row.onboarded_at,
      automationPausedAt: row.automation_paused_at,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  });

  /** Which active threads each Squire tracks, recomputed on a grant change or after the TTL. */
  const loadTracking = Effect.fn("SquireReadModel.loadTracking")(function* (
    grantsBySquire: ReadonlyMap<SquireId, ReadonlyArray<string>>,
  ) {
    const grantsKey = [...grantsBySquire]
      .map(([id, grants]) => `${id}:${grants.join(",")}`)
      .join(";");
    const key = `${yield* Ref.get(threadSet)}|${grantsKey}`;
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(trackingCache);
    if (
      Option.isSome(cached) &&
      cached.value.key === key &&
      nowMs - cached.value.at < TRACKING_TTL_MS
    ) {
      return cached.value;
    }
    const bySquire = new Map<SquireId, Array<ThreadId>>();
    const titles = new Map<ThreadId, string>();
    const shared: Array<Tracking["shared"][number]> = [];
    // No grants, nothing tracked: skip reading every thread shell.
    if ([...grantsBySquire.values()].some((grants) => grants.length > 0)) {
      const snapshot = yield* projections.getShellSnapshot({ location: "active" });
      for (const shell of snapshot.threads) {
        const trackers = yield* scope.trackersOf(shell.id);
        if (trackers.length === 0) continue;
        titles.set(shell.id, shell.title);
        for (const id of trackers) {
          const list = bySquire.get(id) ?? [];
          list.push(shell.id);
          bySquire.set(id, list);
        }
        if (trackers.length > 1) {
          const target = yield* scope.targetOf(shell.id);
          if (Option.isSome(target)) shared.push({ target: target.value, trackers });
        }
      }
    }
    const tracking: Tracking = { key, at: nowMs, bySquire, titles, shared };
    yield* Ref.set(trackingCache, Option.some(tracking));
    return tracking;
  });

  /** Container names for the watch scope line: a name, never an id. */
  const containerNames = (
    grants: ReadonlyArray<SquireRepository.SquireGrantRow>,
    projectShells: ReadonlyArray<{
      readonly id: ProjectId;
      readonly title: string;
      readonly stave?: { readonly spaceId: string } | null | undefined;
    }>,
  ) =>
    Effect.forEach(grants, (grant) =>
      Effect.gen(function* () {
        switch (grant.kind) {
          case "project":
            return [
              projectShells.find((shell) => shell.id === grant.target_id)?.title ??
                "Removed project",
            ];
          case "staveSpace":
          case "staveSaga": {
            const name = yield* SquireContainers.staveContainerName(
              projectShells,
              fixtureStave,
              grant.target_id,
            );
            return [
              Option.getOrElse(name, () =>
                grant.kind === "staveSaga" ? "Stave saga" : "Stave space",
              ),
            ];
          }
          default:
            return [];
        }
      }),
    ).pipe(Effect.map((names) => [...new Set(names.flat())]));

  // Per-row helper inside compute, untraced like toSquire.
  const budgetOf = Effect.fnUntraced(function* (squire: Squire, nowMs: number) {
    const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const usage = yield* repository.listBudgetUsage({
      squireId: squire.id,
      since: DateTime.formatIso(DateTime.makeUnsafe(nowMs - DAY_MS)),
    });
    const budgetRows = usage.map((row): squirePolicy.SquirePolicyBudgetRow => ({
      kind: row.kind,
      threadId: row.thread_id,
      executedAt: row.executed_at,
    }));
    // The same rolling day `squirePolicy.checkBudget` counts.
    const used = (kind: "steer" | "thread") =>
      budgetRows.filter((row) => row.kind === kind && Date.parse(row.executedAt) + DAY_MS > nowMs)
        .length;
    const until = (["steer", "createThread"] as const).flatMap((actionClass) => {
      const check = squirePolicy.checkBudget({
        actionClass,
        budgets: squire.budgets,
        threadId: null,
        budgetRows,
        now,
      });
      return check.exhausted && check.recommendingUntil !== undefined
        ? [check.recommendingUntil]
        : [];
    });
    const recommendingUntil = until.toSorted().at(-1);
    return {
      steersLeft: Math.max(0, squire.budgets.steersPerDay - used("steer")),
      threadsLeft: Math.max(0, squire.budgets.threadsPerDay - used("thread")),
      ...(recommendingUntil === undefined ? {} : { recommendingUntil }),
    };
  });

  /** The clients' rule: stayed quiet, raised and notified nothing, and the user did not write in it. */
  const quietRunsOf = Effect.fnUntraced(function* (
    squireId: SquireId,
    homeThreadId: ThreadId,
    runIds: ReadonlyArray<RunId>,
  ) {
    const logged = yield* repository.listActionLogForRuns({
      squireId,
      kinds: ["quiet.recorded", "tool.called"],
      runIds,
    });
    const quiet = new Set(
      logged.flatMap((row) => (row.kind === "quiet.recorded" ? [row.run_id] : [])),
    );
    for (const row of logged) {
      const tool = row.kind === "tool.called" ? logData(row).tool : undefined;
      if (typeof tool === "string" && SQUIRE_SPEAKING_TOOLS.has(tool)) quiet.delete(row.run_id);
    }
    const candidates = runIds.filter((runId) => quiet.has(runId));
    if (candidates.length === 0) return quiet;
    const { messages } = yield* projections.getThreadRecords(homeThreadId, ["messages"], {
      messageRoles: ["user"],
      messageRunIds: candidates,
    });
    for (const message of messages) {
      if (message.createdBy === "user") quiet.delete(message.runId);
    }
    return quiet;
  });

  /** The newest message a run that stayed quiet did not write; re-read only when a home run ends. */
  const lastMessageAtOf = Effect.fnUntraced(function* (squire: Squire, homeRunsVersion: number) {
    const homeThreadId = squire.homeThreadId;
    if (homeThreadId === null) return undefined;
    const known = lastMessages.get(squire.id);
    if (known?.homeThreadId === homeThreadId && known.homeRunsEnded === homeRunsVersion) {
      return known.at;
    }
    const messages = yield* projections.listRecentAssistantMessages(
      homeThreadId,
      RECENT_ASSISTANT_MESSAGES,
    );
    const quietRuns = yield* quietRunsOf(squire.id, homeThreadId, [
      ...new Set(messages.flatMap((message) => message.runId ?? [])),
    ]);
    const at = messages.find(
      (message) => message.runId === null || !quietRuns.has(message.runId),
    )?.updatedAt;
    lastMessages.set(squire.id, { homeThreadId, homeRunsEnded: homeRunsVersion, at });
    return at;
  });

  const recentActivity = (squireId: SquireId) =>
    repository.listActionLogDesc({ squireId, limit: RECENT_ACTIVITY + 1 }).pipe(
      Effect.map((newest) => {
        // The extra, older row is context only: it tells whether a batch started before the window.
        const rows = newest.toReversed();
        const skip = rows.length - Math.min(rows.length, RECENT_ACTIVITY);
        return rows.slice(skip).map((row, index) => {
          const gesture = squireActivityGesture(row, rows[skip + index - 1]);
          return {
            sequence: row.id,
            kind: decodeLogKind(row.kind),
            at: row.created_at,
            ...(gesture === undefined ? {} : { gesture }),
          };
        });
      }),
    );

  const compute = Effect.fn("SquireReadModel.compute")(function* (
    generation: number,
    threadSetVersion: number,
    homeRunsVersion: number,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const rows = (yield* repository.listSquires).filter((row) => row.lifecycle !== "deleting");
    const leadId = rows.find((row) => row.role === "lead")?.id ?? null;
    const stats = yield* repository.listCardStats;
    const heldCards = yield* repository.listCards({ statuses: ["held"] });
    // A hold is not an item, so it sits beside the open card of the same raiser, thread,
    // and kind instead of replacing it. Read here so the pairing follows that card as it moves.
    const heldOver = new Map<SquireCardRow["id"], SquireCardRow["id"]>();
    for (const card of heldCards) {
      if (card.target_thread_id === null) continue;
      const [open] = yield* repository.listCards({
        squireId: card.squire_id,
        targetThreadId: card.target_thread_id,
        kinds: [card.kind],
        statuses: ["open"],
      });
      if (open !== undefined) heldOver.set(card.id, open.id);
    }
    const projectShells = yield* projects.listShells();

    const grantsOf = new Map<SquireId, ReadonlyArray<SquireRepository.SquireGrantRow>>();
    const records = new Map<SquireId, Squire>();
    for (const row of rows) {
      const grants = yield* repository.listGrants(row.id);
      grantsOf.set(row.id, grants);
      const record = yield* toSquire(row, grants).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.logWarning("Squire record does not decode; left out of the snapshot", {
              squireId: row.id,
              cause,
            }).pipe(Effect.as(Option.none<Squire>())),
        }),
      );
      if (Option.isSome(record)) records.set(row.id, record.value);
    }
    const tracking = yield* loadTracking(
      new Map(
        [...grantsOf]
          .filter(([id]) => records.get(id)?.role === "squire")
          .map(([id, grants]) => [id, grants.map((grant) => `${grant.kind}=${grant.target_id}`)]),
      ),
    );

    const rulesOf = new Map<
      SquireId,
      ReadonlyArray<squirePolicy.SquirePolicyTracker["rules"][number]>
    >();
    // Per-row helper inside compute, untraced like toSquire.
    const trackerOf = Effect.fnUntraced(function* (id: SquireId) {
      const squire = records.get(id);
      if (squire === undefined) return Option.none<squirePolicy.SquirePolicyTracker>();
      const rules =
        rulesOf.get(id) ??
        (yield* repository
          .listRules({ squireId: id, status: "active" })
          .pipe(
            Effect.map((ruleRows) =>
              ruleRows.flatMap((ruleRow) => Option.toArray(toRule(ruleRow))),
            ),
          ));
      rulesOf.set(id, rules);
      return Option.some<squirePolicy.SquirePolicyTracker>({ squire, rules });
    });

    const entries = new Map<SquireId, Entry>();
    for (const row of rows) {
      const squire = records.get(row.id);
      if (squire === undefined) continue;
      const id = squire.id;
      const isLead = id === leadId;
      // The Lead's queue is every Squire's items; a Squire's is what it raised or owns.
      const inQueue = (stat: Pick<CardStat, "squire_id" | "owner_squire_id">) =>
        isLead || stat.squire_id === id || stat.owner_squire_id === id;
      // An approval counts only in the chat where it renders: the raiser's.
      const countsHere = (card: { readonly squire_id: SquireId }) => card.squire_id === id;
      const queueStats = stats.filter(inQueue);
      const decisionStats = stats.filter(
        (stat) => stat.kind !== "fyi" && (stat.squire_id === id || stat.owner_squire_id === id),
      );

      const itemsKey = fingerprint(queueStats);
      const decisionKey = fingerprint(decisionStats);
      const previous = revisions.get(id);
      const next: Revisions =
        previous === undefined
          ? { itemsKey, decisionKey, items: revisionBase, decision: revisionBase }
          : {
              itemsKey,
              decisionKey,
              items: previous.items + (previous.itemsKey === itemsKey ? 0 : 1),
              decision: previous.decision + (previous.decisionKey === decisionKey ? 0 : 1),
            };
      revisions.set(id, next);

      const countsByKind = { steer: 0, question: 0, overlap: 0, proposal: 0, fyi: 0 };
      for (const stat of queueStats) {
        if (queued.has(stat.status)) countsByKind[stat.kind] += stat.n;
      }
      const decisionCounted = stats.filter(
        (stat) => stat.kind !== "fyi" && waitingOnDecision.has(stat.status) && countsHere(stat),
      );
      const openDecisionCount = decisionCounted.reduce((sum, stat) => sum + stat.n, 0);
      const held = heldCards.flatMap((card): ReadonlyArray<HeldEntry> => {
        if (!countsHere(card) || card.executes_at === null) return [];
        const heldOverCardId = heldOver.get(card.id);
        return [
          {
            cardId: card.id,
            kind: card.kind,
            targetThreadId: card.target_thread_id,
            ...(heldOverCardId === undefined ? {} : { heldOverCardId }),
            executesAtMs: Date.parse(card.executes_at),
          },
        ];
      });

      const tracked = tracking.bySquire.get(id) ?? [];
      const conflicts: Array<SquireSnapshot["conflicts"][number]> = [];
      if (squire.role === "squire" && tracking.shared.length > 0) {
        const self = yield* trackerOf(id);
        const mine = tracking.shared.filter((thread) => thread.trackers.includes(id));
        if (Option.isSome(self) && mine.length > 0) {
          const threads = [];
          for (const thread of mine) {
            const trackers = [];
            for (const trackerId of thread.trackers) {
              const tracker = yield* trackerOf(trackerId);
              if (Option.isSome(tracker)) trackers.push(tracker.value);
            }
            threads.push({ target: thread.target, trackers });
          }
          conflicts.push(...squirePolicy.conflicts(self.value, threads));
        }
      }

      const { brief: _brief, ...record } = squire;
      const lastMessageAt = yield* lastMessageAtOf(squire, homeRunsVersion);
      const base: Entry["base"] = {
        squire: record,
        openDecisionCount,
        countsByKind,
        budget: yield* budgetOf(squire, nowMs),
        conflicts,
        trackedCount: tracked.length,
        containerNames: yield* containerNames(grantsOf.get(id) ?? [], projectShells),
        recentActivity: yield* recentActivity(id),
        itemsRevision: next.items,
        decisionRevision: next.decision,
        ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
      };
      entries.set(id, { base, held, key: toKey([base, held]) });
    }
    for (const id of revisions.keys()) {
      if (!entries.has(id)) revisions.delete(id);
    }

    const rooms = new Map<SquireRoomId, { readonly row: SquireRoomRow; readonly key: string }>();
    const closedSince = DateTime.formatIso(DateTime.makeUnsafe(nowMs - SNAPSHOT_CLOSED_ROOM_MS));
    for (const roomRow of yield* repository.listRoomRows({ closedSince })) {
      const row = toRoomRow(roomRow);
      rooms.set(row.id, { row, key: toKey(row) });
    }
    const state: EnvState = {
      generation,
      threadSet: threadSetVersion,
      homeRunsEnded: homeRunsVersion,
      homeThreads: new Set(
        rows.flatMap((row) => (row.home_thread_id === null ? [] : [row.home_thread_id])),
      ),
      lead: leadId,
      entries,
      rooms,
      titles: tracking.titles,
    };
    return state;
  });

  // One computation per repository change, shared by every subscriber and
  // query; the change generation is read first, so a write that lands during
  // the computation is picked up by the next caller.
  const current = refreshLock.withPermits(1)(
    Effect.gen(function* () {
      const generation = yield* repository.changeGeneration;
      const threadSetVersion = yield* Ref.get(threadSet);
      const homeRunsVersion = yield* Ref.get(homeRunsEnded);
      const cached = yield* Ref.get(cache);
      if (
        Option.isSome(cached) &&
        cached.value.generation === generation &&
        cached.value.threadSet === threadSetVersion &&
        cached.value.homeRunsEnded === homeRunsVersion
      ) {
        return cached.value;
      }
      const state = yield* compute(generation, threadSetVersion, homeRunsVersion);
      yield* Ref.set(cache, Option.some(state));
      return state;
    }),
  );

  const snapshotEvent = (state: EnvState, nowMs: number): SquireSubscribeEvent => ({
    type: "snapshot",
    snapshot: {
      lead: state.lead,
      squires: [...state.entries.values()].map((entry) => renderEntry(entry, nowMs)),
      rooms: [...state.rooms.values()].map(({ row }) => row),
    },
  });

  const diff = (
    previous: EnvState,
    next: EnvState,
    nowMs: number,
  ): ReadonlyArray<SquireSubscribeEvent> => {
    const events: Array<SquireSubscribeEvent> = [];
    for (const [id, entry] of next.entries) {
      if (previous.entries.get(id)?.key !== entry.key) {
        events.push({ type: "squire", entry: renderEntry(entry, nowMs) });
      }
    }
    for (const id of previous.entries.keys()) {
      if (!next.entries.has(id)) events.push({ type: "squire-removed", squireId: id });
    }
    // After the entries, so a client meets the new Lead's entry before the pointer.
    if (previous.lead !== next.lead) events.push({ type: "lead", lead: next.lead });
    for (const [id, room] of next.rooms) {
      if (previous.rooms.get(id)?.key !== room.key) events.push({ type: "room", row: room.row });
    }
    return events;
  };

  const subscribe: SquireReadModel["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribed before the first read, so no change between them is lost.
      const changes = Stream.merge(
        yield* repository.subscribeChanges,
        Stream.fromSubscription(yield* PubSub.subscribe(threadSetChanges)),
      );
      const first = yield* current.pipe(orSquireError("read Squires"));
      const updates = changes.pipe(
        Stream.mapAccumEffect(
          (): EnvState => first,
          (previous, _change: void) =>
            Effect.gen(function* () {
              const next = yield* current;
              const nowMs = yield* Clock.currentTimeMillis;
              return [next, diff(previous, next, nowMs)] as const;
            }).pipe(
              // A failed refresh skips one update; the next change retries from the last state.
              Effect.catchCause((cause) =>
                Effect.logWarning("Squire snapshot refresh failed", { cause }).pipe(
                  Effect.as([previous, []] as const),
                ),
              ),
            ),
        ),
      );
      const nowMs = yield* Clock.currentTimeMillis;
      return Stream.concat(Stream.make(snapshotEvent(first, nowMs)), updates);
    }),
  );

  const requireSquire = (squireId: SquireId) =>
    repository
      .getSquire(squireId)
      .pipe(
        Effect.flatMap((row) =>
          Option.isNone(row) || row.value.lifecycle === "deleting"
            ? Effect.fail(notFound("This Squire no longer exists."))
            : Effect.succeed(row.value),
        ),
      );

  /** Only where a row can still act on it: open, and expired so "Always allow next time" still works. */
  const allowRuleOfferOf = (row: SquireRepository.SquireCardRow) =>
    Option.isSome(rules) &&
    (row.status === "open" || (row.status === "outdated" && row.resolution === "expired"))
      ? rules.value.offerFor(row)
      : Effect.succeed(Option.none<typeof SquireRuleOffer.Type>());

  const itemsList: SquireReadModel["Service"]["itemsList"] = Effect.fn("SquireReadModel.itemsList")(
    function* (input) {
      const squire = yield* requireSquire(input.squireId);
      const limit = input.limit ?? DEFAULT_PAGE;
      const page = yield* repository.listCardsPage({
        ...(squire.role === "lead" ? {} : { queueOf: squire.id }),
        ...(input.scope === "open" ? { statuses: QUEUED_STATUSES } : {}),
        ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        ...(input.before === undefined ? {} : { before: input.before }),
        limit: limit + 1,
      });
      const shown = page.slice(0, limit);
      const items = yield* Effect.forEach(shown, (row) =>
        Effect.flatMap(allowRuleOfferOf(row), (allowRuleOffer) =>
          decodeCardRow({
            ...squireCardRowFields(row),
            ...(Option.isSome(allowRuleOffer) ? { allowRuleOffer: allowRuleOffer.value } : {}),
          }),
        ),
      );
      const state = yield* current;
      const itemsRevision = state.entries.get(squire.id)?.base.itemsRevision ?? revisionBase;
      return {
        items,
        nextBefore: page.length > limit ? (shown.at(-1)?.created_at ?? null) : null,
        itemsRevision,
      };
    },
    orSquireError("list items"),
  );

  const actionLogList: SquireReadModel["Service"]["actionLogList"] = Effect.fn(
    "SquireReadModel.actionLogList",
  )(function* (input) {
    yield* requireSquire(input.squireId);
    const limit = input.limit ?? DEFAULT_PAGE;
    const page = yield* repository.listActionLogDesc({
      squireId: input.squireId,
      ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
      ...(input.before === undefined ? {} : { beforeId: input.before }),
      limit: limit + 1,
    });
    const shown = page.slice(0, limit);
    const entries = yield* Effect.forEach(shown, (row) =>
      decodeLogEntry({
        id: row.id,
        squireId: row.squire_id,
        kind: row.kind,
        threadId: row.thread_id,
        cardId: row.card_id,
        eventId: row.event_id,
        runId: row.run_id,
        roomId: row.room_id,
        postId: row.post_id,
        triggerId: row.trigger_id,
        taskId: row.task_id,
        data: logData(row),
        createdAt: row.created_at,
      }),
    );
    return {
      entries,
      nextBefore: page.length > limit ? (shown.at(-1)?.id ?? null) : null,
    };
  }, orSquireError("list the activity log"));

  const summaryGet: SquireReadModel["Service"]["summaryGet"] = Effect.fn(
    "SquireReadModel.summaryGet",
  )(function* (input) {
    const rows =
      input.runId === undefined
        ? yield* repository.listLatestRunSummaries(input.threadId)
        : yield* repository.listRunSummaries({ thread_id: input.threadId, run_id: input.runId });
    // The terminal summary once the run ends, else the latest provisional one.
    const row = rows.find((candidate) => candidate.stage === "terminal") ?? rows.at(-1);
    if (row === undefined) return { summary: null };
    const summary = yield* decodeSummary(row.summary_json);
    return {
      summary: yield* decodeStoredSummary({
        threadId: row.thread_id,
        runId: row.run_id,
        stage: row.stage,
        status: row.status,
        // A row settled by a restart keeps the JSON written before generation.
        summary: row.status === "partial" ? { ...summary, summaryStatus: "partial" } : summary,
        updatedAt: row.updated_at,
      }),
    };
  }, orSquireError("read the summary"));

  const vocabulary: SquireReadModel["Service"]["vocabulary"] = Effect.gen(function* () {
    const state = yield* current;
    const projectShells = yield* projects.listShells();
    const seen = new Set<string>();
    const terms: Array<string> = [];
    const add = (term: string) => {
      const trimmed = term.trim();
      if (trimmed === "" || seen.has(trimmed.toLowerCase())) return;
      seen.add(trimmed.toLowerCase());
      terms.push(trimmed);
    };
    for (const entry of state.entries.values()) add(entry.base.squire.name);
    for (const title of state.titles.values()) add(title);
    for (const shell of projectShells) add(shell.title);
    return { terms };
  }).pipe(orSquireError("read the vocabulary"));

  const originOf = (value: unknown): SquireTurnOrigin =>
    value === "webhook" ? "webhook" : value === "test" ? "test" : "event";

  const triggerRuns: SquireReadModel["Service"]["triggerRuns"] = Effect.fn(
    "SquireReadModel.triggerRuns",
  )(function* (input) {
    const trigger = yield* repository.getTrigger(input.triggerId);
    if (Option.isNone(trigger)) return yield* notFound("This trigger no longer exists.");
    const squire = yield* repository.getSquire(trigger.value.squire_id);
    const logRows = yield* repository.listActionLogDesc({
      squireId: trigger.value.squire_id,
      triggerId: input.triggerId,
      kinds: TRIGGER_KINDS,
      limit: TRIGGER_RUNS,
    });
    const eventIds = logRows.flatMap((row) =>
      row.kind === "trigger.received" && row.event_id !== null ? [row.event_id] : [],
    );
    const events =
      eventIds.length === 0
        ? []
        : yield* repository.listEvents({
            statuses: ["deferred", "pending", "batched", "delivered", "dropped"],
            ids: eventIds,
          });
    const eventById = new Map(events.map((event) => [event.id, event]));

    // A delivered run's items are the cards its Squire turn raised; the turn
    // is found through the batch's deterministic message id.
    const homeThreadId = Option.getOrNull(squire)?.home_thread_id ?? null;
    // Another Squire's post in the batch's room context made it `message`,
    // and a user-started Lead turn's message kept `lead`, which the rows
    // alone cannot tell; one batch sent one message.
    const messageIdsOf = new Map<string, ReadonlyArray<MessageId>>();
    for (const event of events) {
      if (event.status !== "delivered" || event.batch_id === null) continue;
      if (messageIdsOf.has(event.batch_id)) continue;
      const origin = batchOrigin(yield* repository.listBatch(event.batch_id));
      messageIdsOf.set(
        event.batch_id,
        [...new Set([origin, "message" as const, "lead" as const])].map((candidate) =>
          deliverMessageId(candidate, event.batch_id!),
        ),
      );
    }
    const runOfBatch = new Map<string, RunId>();
    if (homeThreadId !== null && messageIdsOf.size > 0) {
      const { messages } = yield* projections.getThreadRecords(homeThreadId, ["messages"], {
        messageIds: [...messageIdsOf.values()].flat(),
      });
      for (const [batchId, messageIds] of messageIdsOf) {
        const runId = messages.find((message) => messageIds.includes(message.id))?.runId;
        if (runId) runOfBatch.set(batchId, runId);
      }
    }
    const raised = yield* repository.listActionLogForRuns({
      squireId: trigger.value.squire_id,
      kinds: RUN_ITEM_KINDS,
      runIds: [...runOfBatch.values()],
    });
    const cardsOfRun = new Map<string, Set<string>>();
    for (const row of raised) {
      if (row.run_id === null || row.card_id === null) continue;
      const cards = cardsOfRun.get(row.run_id) ?? new Set();
      cards.add(row.card_id);
      cardsOfRun.set(row.run_id, cards);
    }

    const runs = logRows.map((row): SquireTriggerRun => {
      const data = logData(row);
      const at = row.created_at;
      if (row.kind === "trigger.rate-limited") {
        return { at, origin: originOf(data.origin), outcome: "rate-limited", itemCount: 0 };
      }
      if (row.kind === "trigger.rejected") {
        return { at, origin: "webhook", outcome: "failed", itemCount: 0 };
      }
      const origin = originOf(data.origin);
      const event = row.event_id === null ? undefined : eventById.get(row.event_id);
      if (event === undefined || event.status === "dropped") {
        return { at, origin, outcome: "failed", itemCount: 0 };
      }
      if (event.status !== "delivered" || event.batch_id === null) {
        return { at, origin, outcome: "pending", itemCount: 0 };
      }
      const runId = runOfBatch.get(event.batch_id);
      const itemCount = runId === undefined ? 0 : (cardsOfRun.get(runId)?.size ?? 0);
      return { at, origin, outcome: itemCount > 0 ? "items-raised" : "quiet", itemCount };
    });
    return { runs };
  }, orSquireError("list trigger runs"));

  return SquireReadModel.of({
    subscribe,
    itemsList,
    actionLogList,
    summaryGet,
    vocabulary,
    triggerRuns,
  });
});

/** Requires SquireRepository, SquireScope, ProjectionStoreV2, and ProjectStoreV2; never writes. */
export const layer = Layer.effect(SquireReadModel, make);
