import {
  SQUIRE_RULE_LIMIT_TEXT,
  UnknownUnionMember,
  WS_METHODS,
  type EnvironmentId,
  type ProviderApprovalDecision,
  type Squire,
  type SquireCard,
  type SquireCardKind,
  type SquireCardPayload,
  type SquireCardResolution,
  type SquireCardRow,
  type SquireGrantInput,
  type SquireId,
  type SquireParticipant,
  type SquirePermissions,
  type SquirePullRequestSnapshot,
  type SquireRoom,
  type SquireRoomId,
  type SquireRoomPost,
  type SquireRoomPostId,
  type SquireRoomRow,
  type SquireRoutingReceipt,
  type SquireRouting,
  type SquireRule,
  type SquireRuleOffer,
  type SquireSnapshot,
  type SquireSteerKind,
  type SquireSubscribeEvent,
} from "@lecturn/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request, requestGuarded, type EnvironmentUnaryRpcTag } from "../rpc/client.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import {
  squireGestureEvents,
  squireIndicatorState,
  type SquireGestureTrigger,
  type SquireIndicatorState,
} from "./squireIndicator.ts";

export {
  squireFigureState,
  type SquireFigureState,
  type SquireGesture,
  type SquireIndicatorState,
  type SquireIndicatorStateName,
} from "./squireIndicator.ts";

// ── Snapshot state ────────────────────────────────────────────

export interface SquireSnapshotEntry extends SquireSnapshot {
  /** Local clock time this entry arrived; holds count down from here, never from server time. */
  readonly receivedAt: number;
}

export interface SquireEnvironmentState {
  readonly lead: SquireId | null;
  readonly squires: ReadonlyArray<SquireSnapshotEntry>;
  readonly rooms: ReadonlyArray<SquireRoomRow>;
}

const upsert = <A>(
  values: ReadonlyArray<A>,
  value: A,
  sameId: (existing: A) => boolean,
): ReadonlyArray<A> => {
  const index = values.findIndex(sameId);
  if (index === -1) return [...values, value];
  const next = values.slice();
  next[index] = value;
  return next;
};

/** Updates before the first `snapshot` and update types this build does not know are skipped. */
export function applySquireSubscribeEvent(
  state: SquireEnvironmentState | null,
  event: SquireSubscribeEvent,
  now: number,
): SquireEnvironmentState | null {
  if (event instanceof UnknownUnionMember) return state;
  if (event.type === "snapshot") {
    return {
      lead: event.snapshot.lead,
      squires: event.snapshot.squires.map((entry) => ({ ...entry, receivedAt: now })),
      rooms: event.snapshot.rooms,
    };
  }
  if (state === null) return null;
  switch (event.type) {
    case "squire":
      return {
        ...state,
        squires: upsert(
          state.squires,
          { ...event.entry, receivedAt: now },
          (existing) => existing.squire.id === event.entry.squire.id,
        ),
      };
    case "squire-removed":
      return {
        ...state,
        squires: state.squires.filter((entry) => entry.squire.id !== event.squireId),
      };
    case "lead":
      return { ...state, lead: event.lead };
    case "room":
      return {
        ...state,
        rooms: upsert(state.rooms, event.row, (existing) => existing.id === event.row.id),
      };
  }
}

/** Only a client that may operate calls ensure, and only once there is a project to home it. */
function shouldEnsureSquireLead(
  state: SquireEnvironmentState | null,
  canEnsure: boolean,
  hasProject: boolean,
): boolean {
  return state !== null && state.lead === null && canEnsure && hasProject;
}

// ── Atoms ─────────────────────────────────────────────────────

const pairKey = (environmentId: EnvironmentId, id: string) => JSON.stringify([environmentId, id]);
const parsePairKey = (key: string) => JSON.parse(key) as [EnvironmentId, string];

function clientTimezone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.trim() !== "" ? zone : undefined;
  } catch {
    return undefined;
  }
}

export function createSquireEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    /** Whether the environment has a project to home the Lead in. */
    readonly hasProjectAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
  },
) {
  const snapshot = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "squire:snapshot",
    tag: WS_METHODS.squireSubscribe,
    transform: (stream) =>
      stream.pipe(
        Stream.mapEffect((event) => Effect.map(Clock.currentTimeMillis, (now) => ({ event, now }))),
        Stream.scan(
          (): SquireEnvironmentState | null => null,
          (state, { event, now }) => applySquireSubscribeEvent(state, event, now),
        ),
      ),
  });

  const state = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): SquireEnvironmentState | null =>
        Option.getOrNull(AsyncResult.value(get(snapshot({ environmentId, input: {} })))) ?? null,
    ).pipe(Atom.withLabel(`squire:state:${environmentId}`)),
  );

  const entry = Atom.family((key: string) => {
    const [environmentId, squireId] = parsePairKey(key);
    return Atom.make(
      (get) => get(state(environmentId))?.squires.find((e) => e.squire.id === squireId) ?? null,
    ).pipe(Atom.withLabel(`squire:entry:${key}`));
  });

  // Signals compare by value, so a snapshot that leaves this Squire's revision alone
  // refreshes nothing. The Lead's combined queue follows every Squire's revision.
  const revisionSignal = (field: "itemsRevision" | "decisionRevision") =>
    Atom.family((key: string) => {
      const [environmentId, squireId] = parsePairKey(key);
      return Atom.make((get): string => {
        const current = get(state(environmentId));
        if (current === null) return "";
        if (current.lead === squireId) {
          return current.squires.map((e) => `${e.squire.id}:${e[field]}`).join(",");
        }
        return String(get(entry(key))?.[field] ?? "");
      }).pipe(Atom.withLabel(`squire:${field}:${key}`));
    });
  const itemsSignal = revisionSignal("itemsRevision");
  const decisionSignal = revisionSignal("decisionRevision");

  const activitySignal = Atom.family((key: string) =>
    Atom.make((get) => {
      const current = get(entry(key));
      const latest = current?.recentActivity.reduce((max, a) => Math.max(max, a.sequence), -1);
      return `${get(itemsSignal(key))}|${latest ?? ""}`;
    }).pipe(Atom.withLabel(`squire:activity:${key}`)),
  );

  const leadItemsSignal = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const lead = get(state(environmentId))?.lead ?? null;
      return lead === null ? "" : get(itemsSignal(pairKey(environmentId, lead)));
    }).pipe(Atom.withLabel(`squire:lead-items:${environmentId}`)),
  );

  // Any edit bumps the record's revision, so the full record refetches only then.
  const detailSignal = Atom.family((key: string) =>
    Atom.make((get) => String(get(entry(key))?.squire.revision ?? "")).pipe(
      Atom.withLabel(`squire:detail-signal:${key}`),
    ),
  );

  const roomSignal = Atom.family((key: string) => {
    const [environmentId, roomId] = parsePairKey(key);
    return Atom.make((get) => {
      const row = get(state(environmentId))?.rooms.find((r) => r.id === roomId);
      return `${get(roomsRefresh(environmentId))}|${row?.lastPostAt ?? ""}|${row?.status ?? ""}|${row?.muted ?? ""}`;
    }).pipe(Atom.withLabel(`squire:room-signal:${key}`));
  });

  const counter = (label: string) =>
    Atom.family((environmentId: EnvironmentId) =>
      Atom.make(0).pipe(Atom.withLabel(`squire:${label}:${environmentId}`)),
    );
  const rulesRefresh = counter("rules-refresh");
  const triggersRefresh = counter("triggers-refresh");
  const roomsRefresh = counter("rooms-refresh");
  const bump =
    (family: (environmentId: EnvironmentId) => Atom.Writable<number>) =>
    ({ environmentId }: { environmentId: EnvironmentId }, registry: AtomRegistry.AtomRegistry) =>
      Effect.sync(() => registry.update(family(environmentId), (n) => n + 1));

  const scopedSignal = Atom.family((key: string) => {
    const [environmentId, squireId, kind] = JSON.parse(key) as [EnvironmentId, SquireId, string];
    const manual = kind === "rules" ? rulesRefresh : triggersRefresh;
    return Atom.make(
      (get) =>
        `${get(manual(environmentId))}|${get(itemsSignal(pairKey(environmentId, squireId)))}`,
    ).pipe(Atom.withLabel(`squire:${kind}-signal:${key}`));
  });

  const decisionQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "squire:decision-items",
    tag: WS_METHODS.squireItemsList,
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId, input }) =>
      decisionSignal(pairKey(environmentId, input.squireId)),
  });
  const DECISION_KINDS: ReadonlyArray<SquireCardKind> = [
    "steer",
    "question",
    "overlap",
    "proposal",
  ];

  const command = <T extends EnvironmentUnaryRpcTag>(
    label: string,
    tag: T,
    onSuccess?: (
      target: { environmentId: EnvironmentId },
      registry: AtomRegistry.AtomRegistry,
    ) => Effect.Effect<void>,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `squire:${label}`,
      tag,
      ...(onSuccess === undefined ? {} : { onSuccess }),
    });

  const commands = {
    create: command("create", WS_METHODS.squireCreate),
    update: command("update", WS_METHODS.squireUpdate),
    setStatus: command("set-status", WS_METHODS.squireSetStatus),
    delete: command("delete", WS_METHODS.squireDelete),
    track: command("track", WS_METHODS.squireTrack),
    untrack: command("untrack", WS_METHODS.squireUntrack),
    itemsAct: command("items-act", WS_METHODS.squireItemsAct),
    itemAsk: command("item-ask", WS_METHODS.squireItemAsk),
    voiceNote: command("voice-note", WS_METHODS.squireVoiceNote),
    leadEnsure: command("lead-ensure", WS_METHODS.squireLeadEnsure),
    // The Lead's digest and daily triggers run in the zone of the client that opened it.
    leadOpen: createEnvironmentRpcCommand(runtime, {
      label: "squire:lead-open",
      tag: WS_METHODS.squireLeadOpen,
      execute: (input) => {
        const timezone = input.timezone ?? clientTimezone();
        return requestGuarded(WS_METHODS.squireLeadOpen, {
          ...input,
          ...(timezone === undefined ? {} : { timezone }),
        });
      },
    }),
    controlRevert: command("control-revert", WS_METHODS.squireControlRevert),
    itemsMarkOpened: command("items-mark-opened", WS_METHODS.squireItemsMarkOpened),
    notificationAlerted: command("notification-alerted", WS_METHODS.squireNotificationAlerted),
    ruleCreate: command("rule-create", WS_METHODS.squireRuleCreate, bump(rulesRefresh)),
    ruleRemove: command("rule-remove", WS_METHODS.squireRuleRemove, bump(rulesRefresh)),
    triggerCreate: command("trigger-create", WS_METHODS.squireTriggerCreate, bump(triggersRefresh)),
    triggerUpdate: command("trigger-update", WS_METHODS.squireTriggerUpdate, bump(triggersRefresh)),
    triggerRotate: command("trigger-rotate", WS_METHODS.squireTriggerRotate, bump(triggersRefresh)),
    triggerRevoke: command("trigger-revoke", WS_METHODS.squireTriggerRevoke, bump(triggersRefresh)),
    triggerTest: command("trigger-test", WS_METHODS.squireTriggerTest, bump(triggersRefresh)),
    automationResume: command(
      "automation-resume",
      WS_METHODS.squireAutomationResume,
      bump(triggersRefresh),
    ),
    leadSweep: command("lead-sweep", WS_METHODS.squireLeadSweep),
    roomCreate: command("room-create", WS_METHODS.squireRoomCreate, bump(roomsRefresh)),
    roomUpdate: command("room-update", WS_METHODS.squireRoomUpdate, bump(roomsRefresh)),
    roomClose: command("room-close", WS_METHODS.squireRoomClose, bump(roomsRefresh)),
    roomReopen: command("room-reopen", WS_METHODS.squireRoomReopen, bump(roomsRefresh)),
    roomPost: command("room-post", WS_METHODS.squireRoomPost, bump(roomsRefresh)),
    roomReroute: command("room-reroute", WS_METHODS.squireRoomReroute, bump(roomsRefresh)),
    // The snapshot's room row carries `unread`, so no refresh is needed.
    roomMarkRead: command("room-mark-read", WS_METHODS.squireRoomMarkRead),
  };

  const ensuredLeads = new WeakMap<AtomRegistry.AtomRegistry, Set<EnvironmentId>>();
  /** Mount while the environment is shown; it calls `squire.lead.ensure` at most once per session. */
  const ensureLead = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const ready = shouldEnsureSquireLead(
        get(state(environmentId)),
        get(commands.leadEnsure.permissionAtom(environmentId)),
        get(options.hasProjectAtom(environmentId)),
      );
      if (!ready) return false;
      const registry = get.registry;
      const ensured = ensuredLeads.get(registry) ?? new Set<EnvironmentId>();
      ensuredLeads.set(registry, ensured);
      if (ensured.has(environmentId)) return true;
      ensured.add(environmentId);
      // @effect-diagnostics-next-line globalDate:off
      const requestId = `squire-lead-ensure:${environmentId}:${Date.now()}`;
      // Out of the read, so the command's own atom writes do not land mid-compute.
      void Promise.resolve().then(() =>
        commands.leadEnsure.run(registry, {
          environmentId,
          input: { requestId },
        }),
      );
      return true;
    }).pipe(Atom.withLabel(`squire:ensure-lead:${environmentId}`)),
  );

  return {
    snapshot,
    state,
    entry: (environmentId: EnvironmentId, squireId: SquireId) =>
      entry(pairKey(environmentId, squireId)),
    rooms: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => get(state(environmentId))?.rooms ?? []).pipe(
        Atom.withLabel(`squire:rooms:${environmentId}`),
      ),
    ),
    ensureLead,
    /** The full record, brief included, which the snapshot leaves out. */
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "squire:detail",
      tag: WS_METHODS.squireGet,
      staleTimeMs: 30_000,
      refreshTrigger: ({ environmentId, input }) =>
        detailSignal(pairKey(environmentId, input.squireId)),
    }),
    providerSupport: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "squire:provider-support",
      tag: WS_METHODS.squireProviderSupport,
      staleTimeMs: 30_000,
    }),
    items: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "squire:items",
      tag: WS_METHODS.squireItemsList,
      staleTimeMs: 30_000,
      refreshTrigger: ({ environmentId, input }) =>
        itemsSignal(pairKey(environmentId, input.squireId)),
    }),
    /** Open decision rows only, which FYI writes never refresh. */
    decisionItems: (target: { environmentId: EnvironmentId; squireId: SquireId }) =>
      decisionQuery({
        environmentId: target.environmentId,
        input: { squireId: target.squireId, scope: "open", kinds: DECISION_KINDS },
      }),
    // Keyed by the owning Squire as well, so only its revision refetches the card.
    item: createEnvironmentQueryAtomFamily(runtime, {
      label: "squire:item",
      staleTimeMs: 30_000,
      execute: (input: { readonly squireId: SquireId; readonly cardId: SquireCardRow["id"] }) =>
        request(WS_METHODS.squireItemGet, { cardId: input.cardId }),
      refreshTrigger: ({ environmentId, input }) =>
        itemsSignal(pairKey(environmentId, input.squireId)),
    }),
    actionLog: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "squire:action-log",
      tag: WS_METHODS.squireActionLogList,
      staleTimeMs: 30_000,
      refreshTrigger: ({ environmentId, input }) =>
        activitySignal(pairKey(environmentId, input.squireId)),
    }),
    summary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "squire:summary",
      tag: WS_METHODS.squireSummaryGet,
      staleTimeMs: 15_000,
    }),
    vocabulary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "squire:vocabulary",
      tag: WS_METHODS.squireVocabulary,
      staleTimeMs: 60_000,
    }),
    rules: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "squire:rules",
      tag: WS_METHODS.squireRuleList,
      staleTimeMs: 30_000,
      refreshTrigger: ({ environmentId, input }) =>
        scopedSignal(JSON.stringify([environmentId, input.squireId, "rules"])),
    }),
    triggers: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "squire:triggers",
      tag: WS_METHODS.squireTriggerList,
      staleTimeMs: 30_000,
      refreshTrigger: ({ environmentId, input }) =>
        scopedSignal(JSON.stringify([environmentId, input.squireId, "triggers"])),
    }),
    triggerRuns: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "squire:trigger-runs",
      tag: WS_METHODS.squireTriggerRuns,
      staleTimeMs: 15_000,
      refreshTrigger: ({ environmentId }) => triggersRefresh(environmentId),
    }),
    leadReceipts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "squire:lead-receipts",
      tag: WS_METHODS.squireLeadReceipts,
      staleTimeMs: 30_000,
      refreshTrigger: ({ environmentId }) => leadItemsSignal(environmentId),
    }),
    roomPosts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "squire:room-posts",
      tag: WS_METHODS.squireRoomPosts,
      staleTimeMs: 30_000,
      refreshTrigger: ({ environmentId, input }) =>
        roomSignal(pairKey(environmentId, input.roomId)),
    }),
    ...commands,
  };
}

export type SquireEnvironmentAtoms = ReturnType<typeof createSquireEnvironmentAtoms>;

// ── Indicator and gestures ────────────────────────────────────

type HomeThreadShell = Parameters<typeof squireIndicatorState>[0];

/** The read model already counts only what the Lead raised, so the Lead needs no special case. */
export function squireEntryIndicator(
  entry: Pick<SquireSnapshot, "squire" | "openDecisionCount" | "held">,
  homeShell: HomeThreadShell,
): SquireIndicatorState {
  const lifecycle = entry.squire.lifecycle;
  return squireIndicatorState(
    homeShell,
    entry.openDecisionCount,
    entry.held.length,
    lifecycle === "unknown" ? undefined : lifecycle,
  );
}

const TRIGGER_BY_GESTURE: Readonly<Record<string, SquireGestureTrigger>> = {
  greet: "squire_created",
  ponder: "batch_started",
  listen: "voice_note_received",
  nod: "item_accepted",
  flourish: "proposed_thread_created",
  glance: "hold_started",
};

// Only for servers that predate the entry's `gesture`; one log kind covers several gestures,
// so only the unambiguous one is guessed.
const TRIGGER_BY_LOG_KIND: Readonly<Record<string, SquireGestureTrigger>> = {
  "action.held": "hold_started",
};

/** Gestures for a mounted full figure from the snapshot's recent activity. */
export function squireSnapshotGestures(
  lastSeenSequence: number | null,
  recentActivity: SquireSnapshot["recentActivity"],
  sessionFirstOpen: boolean,
) {
  return squireGestureEvents(
    lastSeenSequence,
    recentActivity.map((activity) => ({
      sequence: activity.sequence,
      kind:
        (activity.gesture === undefined
          ? TRIGGER_BY_LOG_KIND[activity.kind]
          : TRIGGER_BY_GESTURE[activity.gesture]) ?? "none",
    })),
    sessionFirstOpen,
  );
}

// ── Header lines ──────────────────────────────────────────────

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function squireStateLine(input: {
  readonly squire: Pick<SquireSnapshot["squire"], "role" | "status" | "lifecycle">;
  readonly indicator: SquireIndicatorState;
  readonly openDecisionCount: number;
  readonly heldCount: number;
  /** False when no provider instance supports Squires at all. */
  readonly hasSupportedProvider?: boolean;
}): string {
  const { squire, indicator } = input;
  if (squire.lifecycle === "needs_provider") {
    if (input.hasSupportedProvider === false) return "No supported provider";
    return squire.role === "lead" ? "Choose a provider for the Lead" : "Choose a provider";
  }
  if (squire.lifecycle === "creating") return "Setting up";
  if (squire.lifecycle === "rehoming") return "Moving to a new home";
  if (squire.lifecycle === "deleting") return "Deleting";
  if (indicator.state === "working") return "Working";
  const waiting =
    input.openDecisionCount > 0
      ? `Waiting on you · ${input.openDecisionCount} ${input.openDecisionCount === 1 ? "needs" : "need"} a decision`
      : input.heldCount > 0
        ? `Waiting on you · ${plural(input.heldCount, "action", "actions")} held`
        : null;
  if (squire.status === "paused") return waiting === null ? "Paused" : `Paused · ${waiting}`;
  return waiting ?? "Idle";
}

export function squireWatchScopeLine(trackedCount: number): string {
  return trackedCount === 0
    ? "Watching no threads yet"
    : `Watching ${plural(trackedCount, "thread", "threads")}`;
}

/** The card caption, or "3 of 10 steers left today" for the budget the card spends. */
export function squireBudgetCaption(
  card: Pick<SquireCardRow, "kind" | "caption">,
  entry: Pick<SquireSnapshot, "budget"> & {
    readonly squire: { readonly budgets: { steersPerDay: number; threadsPerDay: number } };
  },
  formatTime: (iso: string) => string,
): string | null {
  if (card.caption !== null) return card.caption;
  const budget =
    card.kind === "steer"
      ? { left: entry.budget.steersLeft, total: entry.squire.budgets.steersPerDay, noun: "steers" }
      : card.kind === "proposal"
        ? {
            left: entry.budget.threadsLeft,
            total: entry.squire.budgets.threadsPerDay,
            noun: "threads",
          }
        : null;
  if (budget === null) return null;
  if (budget.left === 0 && entry.budget.recommendingUntil !== undefined) {
    return `budget reached, recommending only until ${formatTime(entry.budget.recommendingUntil)}`;
  }
  return `${budget.left} of ${budget.total} ${budget.noun} left today`;
}

/**
 * Remaining hold time in ms. The server sends what remains rather than a deadline because no
 * client corrects its clock skew, so this counts from when the snapshot arrived locally.
 */
export function holdRemaining(receivedAt: number, executesInMs: number, now: number): number {
  return Math.min(executesInMs, Math.max(0, receivedAt + executesInMs - now));
}

const HELD_WORDS: Partial<
  Record<SquireCardKind, readonly [noun: string, verb: string, progressive: string]>
> = {
  steer: ["steer", "send", "sending"],
  proposal: ["thread", "start", "creating"],
};
const heldWords = (kind: SquireCardKind) => HELD_WORDS[kind] ?? ["action", "run", "acting"];

/** The open card's mark while a newer action of its kind waits out its hold. */
export function squireSupersededNote(kind: SquireCardKind): string {
  const [noun, verb] = heldWords(kind);
  return `A newer ${noun} is about to ${verb}`;
}

/** The paired hold's name, "Newer steer held", ahead of its countdown. */
export function squireHeldLabel(kind: SquireCardKind): string {
  return `Newer ${heldWords(kind)[0]} held`;
}

/** The line under an open card for the newer hold beside it: "Newer steer held · sending in 52s". */
export function squirePairedHoldText(kind: SquireCardKind, seconds: number): string {
  const progressive = heldWords(kind)[2];
  return `${squireHeldLabel(kind)} · ${progressive} ${seconds > 0 ? `in ${seconds}s` : "now"}`;
}

/**
 * A question's suggested answer or next step, shown above its options. One that only
 * repeats the question or the title adds nothing.
 */
export function squireQuestionRecommendation(
  payload: Exclude<SquireCardPayload, UnknownUnionMember>,
  title: string,
): string | null {
  if (payload.type !== "question") return null;
  const text = payload.recommendation?.trim() ?? "";
  if (text === "" || text === payload.question?.trim() || text === title.trim()) return null;
  return text;
}

const MAX_VOCABULARY_HINTS = 100;

/** Transcription hints: "Squire" first, then the server's terms, each once. */
export function squireVocabularyHints(
  serverTerms: ReadonlyArray<string>,
  squireNames: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const hints: string[] = [];
  for (const raw of ["Squire", ...squireNames, ...serverTerms]) {
    const term = raw.trim();
    const key = term.toLowerCase();
    if (term === "" || seen.has(key)) continue;
    seen.add(key);
    hints.push(term);
    if (hints.length === MAX_VOCABULARY_HINTS) break;
  }
  return hints;
}

// ── Overlaps ──────────────────────────────────────────────────

type SquireOverlapPayload = Extract<SquireCardPayload, { readonly type: "overlap" }>;

/** Shared files an overlap card lists before folding the rest into "+N more". */
const SQUIRE_OVERLAP_PATHS_SHOWN = 5;

/** Overlap card: the shared files capped with "+N more", and the recommended order. */
export function squireOverlapView(
  payload: Pick<SquireOverlapPayload, "paths" | "recommendation">,
  options: { readonly showAllPaths?: boolean } = {},
) {
  const shownPaths =
    options.showAllPaths === true
      ? payload.paths
      : payload.paths.slice(0, SQUIRE_OVERLAP_PATHS_SHOWN);
  const moreCount = payload.paths.length - shownPaths.length;
  return {
    shownPaths,
    moreLabel: moreCount > 0 ? `+${moreCount} more` : null,
    recommendation: payload.recommendation.trim() === "" ? null : payload.recommendation.trim(),
  };
}

/**
 * One thread of an overlap, named as its row would name it: title, provider, branch. The
 * provider is the thread's live instance name when the client has it, else the driver's.
 */
export function squireOverlapThreadLine(
  thread: Pick<SquireOverlapPayload["threads"][number], "provider" | "branch" | "pullRequest">,
  names: {
    readonly title: string | null;
    readonly instanceName: string | null;
    readonly driverName: (driver: string) => string | undefined;
  },
) {
  const title = names.title?.trim() ?? "";
  const branch = thread.branch?.trim() ?? "";
  return {
    label: title === "" ? "Untitled thread" : title,
    provider: names.instanceName ?? names.driverName(thread.provider) ?? thread.provider,
    branch: branch === "" ? null : branch,
    pullRequest: thread.pullRequest === undefined ? null : `#${thread.pullRequest}`,
  };
}

// ── Queue ─────────────────────────────────────────────────────

export type SquireQueueChip = "all" | SquireCardKind;

export const SQUIRE_QUEUE_CHIPS: ReadonlyArray<{
  readonly chip: SquireQueueChip;
  readonly label: string;
}> = [
  { chip: "all", label: "All" },
  { chip: "steer", label: "Action" },
  { chip: "question", label: "Question" },
  { chip: "overlap", label: "Overlap" },
  { chip: "proposal", label: "Proposal" },
  { chip: "fyi", label: "FYI" },
];

/**
 * Chips count after the team-strip filter and before the chip filter, so every chip
 * shows what selecting it would list. Decision items come first, FYI apart.
 */
export function squireQueue<
  Row extends Pick<SquireCardRow, "kind" | "squireId" | "ownerSquireId"> &
    Partial<Pick<SquireCardRow, "relatedSquireIds">>,
>(
  items: ReadonlyArray<Row>,
  filter: { readonly chip?: SquireQueueChip; readonly squireId?: SquireId | null } = {},
) {
  const scoped =
    filter.squireId == null
      ? items
      : items.filter(
          (item) =>
            item.ownerSquireId === filter.squireId ||
            item.squireId === filter.squireId ||
            (item.relatedSquireIds?.includes(filter.squireId!) ?? false),
        );
  const chips = SQUIRE_QUEUE_CHIPS.map(({ chip, label }) => ({
    chip,
    label,
    count: chip === "all" ? scoped.length : scoped.filter((item) => item.kind === chip).length,
  }));
  const chip = filter.chip ?? "all";
  const shown = chip === "all" ? scoped : scoped.filter((item) => item.kind === chip);
  return {
    chips,
    groups: [
      { key: "decision", label: "Needs a decision", items: shown.filter((i) => i.kind !== "fyi") },
      { key: "fyi", label: "FYI", items: shown.filter((i) => i.kind === "fyi") },
    ].filter((group) => group.items.length > 0),
  };
}

// ── Rules and origin labels ───────────────────────────────────

/** Mirrors the server's rule text so a saved rule reads exactly as its offer did. */
export function squireRuleText(
  rule: Pick<SquireRule, "effect" | "steerKind" | "targetKind">,
  names: { readonly squireName: string; readonly targetName: string },
): string {
  const where = (prefix: string) =>
    rule.targetKind === "thread" ? `on "${names.targetName}"` : `${prefix} ${names.targetName}`;
  if (rule.steerKind === null) {
    return rule.effect === "allow"
      ? `${names.squireName} may auto-create threads ${where("in")}`
      : `${names.squireName} asks first before creating threads ${where("in")}`;
  }
  const steers = `${steerKindLabel(rule.steerKind)} steers ${where("on threads in")}`;
  return rule.effect === "allow"
    ? `${names.squireName} may auto-send ${steers}`
    : `${names.squireName} asks first before sending ${steers}`;
}

const steerKindLabel = (kind: SquireSteerKind) => kind.replaceAll("-", " ");

/** Origin labels, in the order the card shows them. */
/**
 * The voice note's speaker flag is client-asserted, so a card a voice turn raised
 * says so; "speaker not verified" only on an explicit `false`, since older rows omit the flag.
 */
type SquireOriginCard = Pick<SquireCardRow, "origin" | "routedTaskId" | "ruleId"> & {
  readonly speakerVerified?: boolean | null | undefined;
};

export function squireCardOriginLabels(
  card: SquireOriginCard,
  ruleFor: (ruleId: NonNullable<SquireCardRow["ruleId"]>) => {
    readonly effect: SquireRule["effect"];
    readonly text: string;
  } | null,
): ReadonlyArray<string> {
  const labels: string[] = [];
  if (card.origin === "voice") {
    labels.push(
      card.speakerVerified === false ? "Voice note · speaker not verified" : "Voice note",
    );
  }
  if (card.origin === "sweep") labels.push("Found by Lead");
  if (card.routedTaskId !== null) labels.push("Routed from Lead");
  if (card.origin === "test") labels.push("Test");
  const rule = card.ruleId === null ? null : ruleFor(card.ruleId);
  if (rule !== null) {
    labels.push(
      rule.effect === "allow" ? `Auto by rule: ${rule.text}` : `Asked first by rule: ${rule.text}`,
    );
  }
  return labels;
}

/** The rule offer after an accept or an Undo; at the cap it reads the limit and cannot be saved. */
export function squireRuleOfferPrompt(offer: SquireRuleOffer) {
  return {
    action: offer.effect === "allow" ? "Always allow this" : "Always ask first for this",
    text: offer.capReached ? SQUIRE_RULE_LIMIT_TEXT : offer.text,
    canSave: !offer.capReached,
    alternative: offer.capReached ? null : (offer.alternative ?? null),
  };
}

// ── Queue cards (shared by web and mobile) ────────────────────

/** A payload this build knows; the card shows only its row fields for a newer one. */
export type SquireKnownPayload = Exclude<SquireCardPayload, UnknownUnionMember>;

/** FYI pages after the first are requested only when the user asks for older items. */
export const SQUIRE_QUEUE_PAGE_SIZE = 50;

export const SQUIRE_KIND_LABEL: Readonly<Record<SquireCardKind, string>> = {
  steer: "Action",
  question: "Question",
  overlap: "Overlap",
  proposal: "Proposal",
  fyi: "FYI",
};

const RESOLUTION_LABEL: Readonly<Partial<Record<SquireCardResolution, string>>> = {
  accepted: "Accepted",
  answered: "Answered",
  declined: "Declined",
  cancelled: "Cancelled",
  dismissed: "Dismissed",
  undone: "Undone",
  executed: "Sent",
  outdated: "Outdated",
  expired: "Outdated",
  failed: "Failed",
};

/** How a card that left the queue ended, for the one-line confirmation where it was. */
export function squireSettledLabel(
  card: Pick<SquireCardRow, "status"> & { readonly resolution?: SquireCardResolution | null },
): string {
  const byResolution = card.resolution == null ? undefined : RESOLUTION_LABEL[card.resolution];
  if (byResolution !== undefined) return byResolution;
  if (card.status === "dismissed") return "Dismissed";
  if (card.status === "outdated") return "Outdated";
  return "Done";
}

/** What the user's own successful act did, shown until the refetched queue agrees. */
export function squireActedLabel(
  row: Pick<SquireCardRow, "kind" | "fyiSource">,
  action: "accept" | "dismiss",
): string {
  if (row.kind === "fyi" && row.fyiSource === "inactivity") {
    return action === "accept" ? "Kept running" : "Paused";
  }
  if (action === "dismiss") return "Dismissed";
  switch (row.kind) {
    case "question":
      return "Answered";
    case "steer":
      return "Sent";
    case "overlap":
      return "Reviewed";
    default:
      return "Accepted";
  }
}

/** Only an open card takes a decision; a held one belongs to the hold banner. */
export function squireCardActionable(row: Pick<SquireCardRow, "status">): boolean {
  return row.status === "open";
}

export type SquireRowAction =
  | { readonly type: "accept"; readonly label: string }
  | { readonly type: "expand"; readonly label: string }
  | { readonly type: "dismiss"; readonly label: string }
  | { readonly type: "inactivity" }
  | null;

/**
 * The inline primary on a compact row. A row has no payload, so anything whose answer needs
 * the card (a question's options, an overlap's order) expands instead of guessing.
 */
export function squireRowAction(
  row: Pick<SquireCardRow, "kind" | "status" | "fyiSource">,
): SquireRowAction {
  if (!squireCardActionable(row)) return null;
  switch (row.kind) {
    case "steer":
      return { type: "accept", label: "Send steer" };
    case "proposal":
      return { type: "accept", label: "Accept" };
    case "question":
      return { type: "expand", label: "Answer" };
    case "overlap":
      return { type: "expand", label: "Review" };
    case "fyi":
      // The inactivity check's accept is Keep and its dismiss pauses triggers, so it gets
      // both by name and never a plain Dismiss.
      return row.fyiSource === "inactivity"
        ? { type: "inactivity" }
        : { type: "dismiss", label: "Dismiss" };
  }
}

/** The card's primary for its payload; questions answer through the thread's options. */
export function squireCardPrimaryLabel(payload: SquireKnownPayload): string | null {
  switch (payload.type) {
    case "steer":
      return "Send steer";
    case "thread-proposal":
      return "Create thread";
    case "squire-proposal":
      return "Accept";
    case "room-proposal":
      return "Open room";
    case "control":
      return "Accept";
    case "overlap":
      return "Review";
    default:
      return null;
  }
}

/** The edited text the accept sends, or nothing when the user left the recommendation alone. */
export function squireEditedText(original: string, draft: string | null): string | undefined {
  if (draft === null) return undefined;
  const trimmed = draft.trim();
  return trimmed === "" || trimmed === original.trim() ? undefined : trimmed;
}

/** "Follow up in thread": a draft that quotes the question above what was already typed. */
export function squireFollowUpDraft(question: string, existing: string): string {
  const quoted = question
    .trim()
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  const rest = existing.trim();
  if (quoted === ">") return existing;
  if (rest.startsWith(quoted)) return existing;
  return rest === "" ? `${quoted}\n\n` : `${quoted}\n\n${rest}`;
}

/**
 * The ask's cost copy before sending. The client knows only whether the thread's provider forks
 * natively (`conversationFork`); whether it may probe at all is the server's `probeSupport`,
 * so a refusal comes back as the ask's error.
 */
export function squireAskCopy(
  provider: { readonly name: string; readonly conversationFork: string | undefined } | null,
): string {
  const base = "Asks a temporary read-only copy of the thread, then discards it. Uses tokens.";
  if (provider === null || provider.conversationFork === "native") return base;
  return `${base} ${provider.name} cannot fork natively, so Lecturn replays the thread's recent context first, which costs more.`;
}

export interface SquireRuleNames {
  readonly squireName: (squireId: SquireId) => string;
  readonly targetName: (rule: Pick<SquireRule, "targetKind" | "targetId">) => string;
}

/** Origin labels, with a rule's exact text read from the raiser's rules once they load. */
export function squireCardOrigins(
  card: SquireOriginCard,
  rules: ReadonlyArray<SquireRule>,
  names: SquireRuleNames,
): ReadonlyArray<string> {
  return squireCardOriginLabels(card, (ruleId) => {
    const rule = rules.find((candidate) => candidate.id === ruleId);
    if (rule === undefined) return null;
    return {
      effect: rule.effect,
      text: squireRuleText(rule, {
        squireName: names.squireName(rule.squireId),
        targetName: names.targetName(rule),
      }),
    };
  });
}

const OFFER_EXCLUDED_ORIGINS: ReadonlySet<string> = new Set([
  "voice",
  "webhook",
  "test",
  "sweep",
  "message",
]);

/**
 * "Always allow this" after accepting a steer or proposal, never for voice, webhook,
 * test, sweep, or message cards or an `other` steer. The server decides; this keeps a stray
 * offer off a card no rule could match.
 */
export function squireAcceptOffer(
  card: Pick<SquireCardRow, "kind" | "origin" | "steerKind">,
  offer: SquireRuleOffer | undefined,
) {
  if (offer === undefined || offer.effect !== "allow") return null;
  if (card.kind !== "steer" && card.kind !== "proposal") return null;
  if (OFFER_EXCLUDED_ORIGINS.has(card.origin)) return null;
  if (card.kind === "steer" && (card.steerKind === null || card.steerKind === "other")) {
    return null;
  }
  return squireRuleOfferPrompt(offer);
}

/**
 * "Always ask first for this" after an Undo. The hold carries no origin, so this trusts
 * the server, which attaches the offer only to a card a rule could match.
 */
export function squireUndoOffer(offer: SquireRuleOffer | undefined) {
  return offer === undefined || offer.effect !== "ask-first" ? null : squireRuleOfferPrompt(offer);
}

/** The fields `squire.rule.create` takes for the offer or its one alternative target. */
export function squireOfferRuleInput(
  offer: SquireRuleOffer,
  target: "offer" | "alternative",
  card: Pick<SquireCardRow, "id" | "squireId">,
) {
  const where =
    target === "alternative" && offer.alternative !== undefined ? offer.alternative : offer;
  return {
    squireId: card.squireId,
    effect: offer.effect,
    actionClass: offer.actionClass,
    targetKind: where.targetKind,
    targetId: where.targetId,
    ...(offer.steerKind === undefined ? {} : { steerKind: offer.steerKind }),
    fromCardId: card.id,
  };
}

export function squireApprovalAnswer(decision: ProviderApprovalDecision): {
  readonly decision: ProviderApprovalDecision;
} {
  return { decision };
}

/**
 * The question shows once: the card's header already reads the title, which the server takes
 * from the question's first line. A body line or a panel question that only repeats it is
 * dropped; a longer question keeps its full text.
 */
export function squireQuestionRepeatsTitle(question: string, title: string): boolean {
  return question.trim() === title.trim();
}

/**
 * The panel's questions with the one the header already shows left blank. Answers key by
 * question id, so blanking the text changes nothing sent.
 */
export function squireQuestionPanelQuestions<Question extends { readonly question: string }>(
  questions: ReadonlyArray<Question>,
  title: string,
): ReadonlyArray<Question> {
  if (questions.length !== 1) return questions;
  const [only] = questions;
  return only !== undefined && squireQuestionRepeatsTitle(only.question, title)
    ? [{ ...only, question: "" }]
    : questions;
}

// ── Rooms ─────────────────────────────────────────────────────

const formatConfidence = (confidence: number) => confidence.toFixed(2);

/** Why a rule woke the recipients, in words; the server's `match` is detail, not the label. */
function squireRuleReason(rule: string, match: string): string {
  switch (rule) {
    case "mention":
      // A reroute records its own reason in `match`; a typed mention records the `@names`.
      return match === "" || match.startsWith("@") ? "mentioned" : match;
    case "reply":
      return "reply";
    case "scope": {
      const covered = match.replace(/^named\s+/, "");
      return covered === "" ? "rules" : `covers ${covered}`;
    }
    case "recent":
      return "recent reply";
    default:
      return "rules";
  }
}

/** The chip under a delivered post, e.g. "Routed to Research · Jev 0.72 · shown to Lead". */
export function squireRoutingChip(
  routing: SquireRouting,
  nameOf: (squireId: SquireId) => string,
): string {
  const via = routing.via;
  if (via instanceof UnknownUnionMember) return "Routed";
  if (via.kind === "pending") return "Routing…";
  if (via.kind === "jev" && via.noReplyNeeded) {
    return `No reply needed · Jev ${formatConfidence(via.confidence)}`;
  }
  if (routing.recipients.length === 0) {
    return via.kind === "rule" && via.rule === "none" && via.match.trim() !== ""
      ? `Nobody woken · ${via.match}`
      : "Nobody woken";
  }
  const to = `Routed to ${routing.recipients.map(nameOf).join(", ")}`;
  switch (via.kind) {
    case "rule":
      return `${to} · ${squireRuleReason(via.rule, via.match.trim())}`;
    case "jev":
      return `${to} · Jev ${formatConfidence(via.confidence)}${via.shownToLead ? " · shown to Lead" : ""}`;
    case "fallback":
      return `${to} · rules`;
  }
}

/**
 * The unread dot. The server clears `unread` once the user's seen cursor moves; `seenLastPostAt`
 * is the room's `lastPostAt` when this client last showed the room, so the dot clears at once
 * and returns only for a newer post.
 */
export function squireRoomUnread(
  row: Pick<SquireRoomRow, "unread" | "muted" | "lastPostAt">,
  seenLastPostAt?: string | null,
): boolean {
  if (row.muted || !row.unread) return false;
  if (seenLastPostAt == null || row.lastPostAt === null) return true;
  return Date.parse(row.lastPostAt) > Date.parse(seenLastPostAt);
}

export interface SquireMentionCandidate {
  readonly squireId: SquireId;
  readonly name: string;
  readonly isLead: boolean;
}

/** The `@` token being typed at the cursor, if any. */
export function squireMentionQuery(
  text: string,
  cursor: number,
): { readonly start: number; readonly query: string } | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  return /\s/.test(query) ? null : { start: at, query };
}

/** Composer completion over the room's members and the Lead. */
export function squireMentionCompletions(
  query: string,
  members: ReadonlyArray<{ readonly squireId: SquireId; readonly name: string }>,
  lead: { readonly squireId: SquireId; readonly name: string } | null,
  limit = 8,
): ReadonlyArray<SquireMentionCandidate> {
  const needle = query.toLowerCase();
  const candidates: SquireMentionCandidate[] = members.map((member) => ({
    ...member,
    isLead: member.squireId === lead?.squireId,
  }));
  if (lead !== null && !candidates.some((c) => c.squireId === lead.squireId)) {
    candidates.push({ ...lead, isLead: true });
  }
  const rank = (name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith(needle)) return 0;
    return lower.split(/\s+/).some((word) => word.startsWith(needle)) ? 1 : -1;
  };
  return candidates
    .map((candidate) => ({ candidate, rank: rank(candidate.name) }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.candidate.name.localeCompare(b.candidate.name))
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

export function applySquireMention(
  text: string,
  mention: { readonly start: number; readonly query: string },
  name: string,
): { readonly text: string; readonly cursor: number } {
  const end = mention.start + 1 + mention.query.length;
  const rest = text.slice(end);
  // Reuse a space already after the token, so the caret lands past it without doubling it.
  const spaced = /^\s/.test(rest);
  const inserted = spaced ? `@${name}` : `@${name} `;
  return {
    text: `${text.slice(0, mention.start)}${inserted}${rest}`,
    cursor: mention.start + inserted.length + (spaced ? 1 : 0),
  };
}

export const SQUIRE_ROOM_PORTRAIT_CAP = 3;
/** One page of the log, small enough to render without virtualizing. */
const SQUIRE_ROOM_PAGE_SIZE = 50;

/** The `squire.room.posts` input for the newest page (`before` null) or the page before a post. */
export function squireRoomPostsInput(roomId: SquireRoomId, before: SquireRoomPostId | null) {
  return before === null
    ? { roomId, limit: SQUIRE_ROOM_PAGE_SIZE }
    : { roomId, before, limit: SQUIRE_ROOM_PAGE_SIZE };
}

/** Names for every Squire in the environment; a Squire deleted since it posted reads as removed. */
export function squireRoomNameOf(
  squires: ReadonlyArray<Pick<SquireSnapshotEntry, "squire">>,
): (squireId: SquireId) => string {
  const names = new Map(squires.map((entry) => [entry.squire.id, entry.squire.name]));
  return (squireId) => names.get(squireId) ?? "Removed Squire";
}

export function squireRoomAuthorLabel(
  author: SquireParticipant,
  nameOf: (squireId: SquireId) => string,
): string {
  switch (author.kind) {
    case "user":
      return "You";
    case "system":
      return "Lecturn";
    case "lead":
    case "squire":
      return nameOf(author.squireId);
  }
}

export type SquireRoomLogRow =
  | { readonly kind: "system"; readonly post: SquireRoomPost }
  /** A bot post that woke another bot, shown as "Release → Research: ...". */
  | {
      readonly kind: "handoff";
      readonly post: SquireRoomPost;
      readonly from: SquireId;
      readonly to: ReadonlyArray<SquireId>;
    }
  | { readonly kind: "post"; readonly post: SquireRoomPost };

/** Server pages are newest first; the log reads oldest to newest. */
export function squireRoomLogRows(
  newestFirst: ReadonlyArray<SquireRoomPost>,
): ReadonlyArray<SquireRoomLogRow> {
  // `toReversed` is missing on Hermes, and lint rejects the mutating `reverse`.
  return newestFirst.reduceRight<SquireRoomLogRow[]>((rows, post) => {
    rows.push(squireRoomLogRow(post));
    return rows;
  }, []);
}

function squireRoomLogRow(post: SquireRoomPost): SquireRoomLogRow {
  const author = post.author;
  if (author.kind === "system") return { kind: "system", post };
  if (author.kind === "user" || post.routing.recipients.length === 0) {
    return { kind: "post", post };
  }
  return { kind: "handoff", post, from: author.squireId, to: post.routing.recipients };
}

/**
 * Members plus the Lead, less the author and whoever the post already reached. A post still
 * being routed has no recipients to correct yet.
 */
export function squireRoomRerouteTargets(
  room: Pick<SquireRoom, "members">,
  leadId: SquireId | null,
  post: Pick<SquireRoomPost, "author" | "routing">,
): ReadonlyArray<SquireId> {
  const via = post.routing.via;
  if (!(via instanceof UnknownUnionMember) && via.kind === "pending") return [];
  const authorId =
    post.author.kind === "squire" || post.author.kind === "lead" ? post.author.squireId : null;
  const reached = new Set(post.routing.recipients);
  const candidates = leadId === null ? room.members : [...room.members, leadId];
  return [...new Set(candidates)].filter((id) => id !== authorId && !reached.has(id));
}

export function squireRoomTtlLabel(hours: number): string {
  if (hours % 24 === 0) return hours === 24 ? "1 day" : `${hours / 24} days`;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export const squireRoomTtlHours = (room: Pick<SquireRoom, "idleTtlSeconds">) =>
  Math.max(1, Math.round(room.idleTtlSeconds / 3600));

/** The open `@` completion at the cursor: the members and the Lead whose names match. */
export function squireRoomMentionState(
  text: string,
  cursor: number,
  members: ReadonlyArray<{ readonly squireId: SquireId; readonly name: string }>,
  lead: { readonly squireId: SquireId; readonly name: string } | null,
): {
  readonly mention: { readonly start: number; readonly query: string };
  readonly candidates: ReadonlyArray<SquireMentionCandidate>;
} | null {
  const mention = squireMentionQuery(text, cursor);
  if (mention === null) return null;
  const candidates = squireMentionCompletions(mention.query, members, lead);
  return candidates.length === 0 ? null : { mention, candidates };
}

/** Arrow keys wrap through the completion list. */
export function squireMentionStep(index: number, count: number, delta: 1 | -1): number {
  if (count === 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/**
 * The post to mark read now, or null: only while the newest post is on screen (the view is
 * focused and showing the end of the log), once per newest post.
 */
export function squireRoomMarkReadTarget(input: {
  readonly newestPostId: SquireRoomPostId | null;
  readonly lastMarkedPostId: SquireRoomPostId | null;
  readonly showingNewest: boolean;
  readonly canMarkRead: boolean;
}): SquireRoomPostId | null {
  const { newestPostId } = input;
  if (newestPostId === null || !input.showingNewest || !input.canMarkRead) return null;
  return newestPostId === input.lastMarkedPostId ? null : newestPostId;
}

// ── Routing receipts ──────────────────────────────────────────

const KIND_ARTICLE: Readonly<Record<SquireCardKind, string>> = {
  steer: "a steer",
  question: "a question",
  overlap: "an overlap",
  proposal: "a proposal",
  fyi: "an FYI",
};

/** Routing receipt row: "Sent to Release", then what its turn raised, then those items' states. */
export function squireReceiptState(
  receipt: SquireRoutingReceipt,
  nameOf: (squireId: SquireId) => string,
) {
  const name = nameOf(receipt.toSquireId);
  const text = (() => {
    switch (receipt.status) {
      case "acted":
        if (receipt.items.length === 0) return `Sent to ${name}: ${receipt.text}`;
        return receipt.items.length === 1
          ? `Sent to ${name} as ${KIND_ARTICLE[receipt.items[0]!.kind]}: ${receipt.text}`
          : `Sent to ${name} as ${receipt.items.length} items: ${receipt.text}`;
      case "quiet":
        return receipt.quietReason === null || receipt.quietReason.trim() === ""
          ? `${name}: no action`
          : `${name}: no action, ${receipt.quietReason}`;
      case "rejected":
        return `Not sent to ${name}`;
      default:
        return `Sent to ${name}`;
    }
  })();
  const live = new Set(["held", "open", "accepting", "executing"]);
  return {
    text,
    items: receipt.items,
    settled:
      receipt.status !== "sent" &&
      receipt.status !== "unknown" &&
      receipt.items.every((item) => !live.has(item.status)),
  };
}

// ── Card evidence, timelines, and Lead items (shared by web and mobile) ──

/** Text that reads the same to the user: spacing and case aside. */
export function squireSameText(a: string, b: string): boolean {
  const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
  return normalize(a) === normalize(b);
}

/** Who raised an item, as rows and timelines name it: the Lead's own items read "Lead". */
export function squireRaiserLabel(raiser: Pick<Squire, "name" | "role">): string {
  return raiser.role === "lead" ? "Lead" : raiser.name;
}

/**
 * What a row points at, by name: its thread; for a thread proposal the project it would start
 * in; for a Squire proposal the project it would watch first (only thread proposals carry a
 * provider, and room and control proposals no project); otherwise the row's project.
 */
export function squireRowTargetName(
  row: Pick<SquireCardRow, "kind" | "targetThreadId" | "proposalProvider">,
  names: {
    readonly threadTitle: string | null;
    readonly projectTitle: string | null;
    /** Overlap rows: how many threads it names, once its card loads. Its title names them. */
    readonly overlapThreads?: number | null;
  },
): string | null {
  if (row.targetThreadId !== null) return names.threadTitle;
  const project = names.projectTitle;
  if (row.kind === "overlap" && names.overlapThreads != null) {
    const threads = `${names.overlapThreads} threads`;
    return project === null ? threads : `${threads} · ${project}`;
  }
  if (project === null) return null;
  if (row.kind !== "proposal") return project;
  return row.proposalProvider === undefined ? `New Squire · ${project}` : `New thread · ${project}`;
}

/** The provider a thread proposal would run on, when the client has no instance to name it. */
export function squireProposalProviderName(
  proposal: SquireCardRow["proposalProvider"],
  instanceName: string | null,
  driverName: (driver: string) => string | undefined,
): string | null {
  if (proposal === undefined) return null;
  return instanceName ?? driverName(proposal.provider) ?? proposal.provider;
}

/**
 * Each overlapping thread's provider as its thread line on the card names it: the recorded
 * instance's name, else the driver's, else the raw driver. Null on a row that is no overlap.
 */
export function squireOverlapProviderNames(
  row: {
    readonly overlapProviders?: ReadonlyArray<string>;
    readonly overlapProviderInstanceIds?: ReadonlyArray<string | null>;
  },
  names: {
    readonly instanceName: (instanceId: string) => string | null;
    readonly driverName: (driver: string) => string | undefined;
  },
): ReadonlyArray<string> | null {
  if (row.overlapProviders === undefined) return null;
  return row.overlapProviders.map((provider, index) => {
    const instanceId = row.overlapProviderInstanceIds?.[index] ?? null;
    return (
      (instanceId === null ? null : names.instanceName(instanceId)) ??
      names.driverName(provider) ??
      provider
    );
  });
}

/**
 * The provider a row names, wherever one is known: its thread's, a thread proposal's, or each
 * overlapping thread's, once. Only the Lead view leaves it off, on every row.
 */
export function squireRowProviderName(input: {
  readonly threadProvider: string | null;
  readonly proposalProvider: string | null;
  readonly overlapProviders?: ReadonlyArray<string> | null;
}): string | null {
  if (input.threadProvider !== null) return input.threadProvider;
  if (input.proposalProvider !== null) return input.proposalProvider;
  const overlap = [...new Set(input.overlapProviders ?? [])];
  return overlap.length === 0 ? null : overlap.join(" + ");
}

/** The budget a card would spend; only an open card is still deciding. */
export function squireCardCaption(
  card: Pick<SquireCardRow, "kind" | "caption" | "status">,
  entry: Parameters<typeof squireBudgetCaption>[1] | null,
  formatTime: (iso: string) => string,
): string | null {
  if (card.status !== "open") return null;
  return entry === null ? card.caption : squireBudgetCaption(card, entry, formatTime);
}

export type SquireChipTone = "failing" | "passing" | "pending" | "neutral";

export interface SquireChip {
  readonly key: string;
  readonly label: string;
  readonly tone: SquireChipTone;
}

/** PR chips: "2/14 failing", "review approved", "mergeable". */
export function squirePullRequestChips(pr: SquirePullRequestSnapshot): ReadonlyArray<SquireChip> {
  const chips: SquireChip[] = [];
  const total = pr.checks.passed + pr.checks.failed;
  if (total > 0) {
    chips.push(
      pr.checks.failed > 0
        ? { key: "checks", label: `${pr.checks.failed}/${total} failing`, tone: "failing" }
        : { key: "checks", label: `${total}/${total} passing`, tone: "passing" },
    );
  }
  switch (pr.review) {
    case "approved":
      chips.push({ key: "review", label: "review approved", tone: "passing" });
      break;
    case "changes-requested":
      chips.push({ key: "review", label: "changes requested", tone: "failing" });
      break;
    case "review-required":
      chips.push({ key: "review", label: "review required", tone: "pending" });
      break;
    default:
      break;
  }
  if (pr.merged) chips.push({ key: "state", label: "merged", tone: "neutral" });
  else if (pr.closed) chips.push({ key: "state", label: "closed", tone: "neutral" });
  else if (pr.mergeable !== null) {
    chips.push({
      key: "mergeable",
      label: pr.mergeable === "mergeable" ? "mergeable" : pr.mergeable.replaceAll("-", " "),
      tone: pr.mergeable === "mergeable" ? "passing" : "failing",
    });
  }
  return chips;
}

export function squireDiffStatsLabel(stats: { readonly files: number }): string {
  return `${stats.files} ${stats.files === 1 ? "file" : "files"}`;
}

/**
 * "waiting <age>": a question waits from when its thread asked, which can be long before
 * the card was raised; every other item, and a question raised before the ask was recorded,
 * from the card itself.
 */
export function squireWaitingSince(row: Pick<SquireCardRow, "createdAt" | "requestedAt">): string {
  return row.requestedAt ?? row.createdAt;
}

/**
 * Why on a question card, when the Squire left no note and the trigger no quote:
 * how long the thread has been waiting, from the row's own age text.
 */
export function squireQuestionWhyFallback(threadTitle: string | null, ageText: string): string {
  const who =
    threadTitle === null || threadTitle.trim() === "" ? "This thread" : threadTitle.trim();
  if (ageText === "") return `${who} is waiting on you`;
  if (ageText === "now") return `${who} is waiting on you since just now`;
  return `${who} has been waiting on you for ${ageText}`;
}

/**
 * Why text, or "" when it only repeats the card's title or its thread's title: a Why that
 * names the thread says nothing, so the card falls back to how long it has waited.
 */
export function squireWhyText(
  why: string,
  titles: { readonly title: string; readonly threadTitle: string | null },
): string {
  const text = why.trim();
  if (text === "" || squireSameText(text, titles.title)) return "";
  return titles.threadTitle !== null && squireSameText(text, titles.threadTitle) ? "" : text;
}

/**
 * The inbox detail's timeline: the server's thread events when it has them. A card with no
 * target thread (an overlap, a proposal) or no recorded events gets what the card itself
 * knows: when it was raised, the PR change it carries, and its last replacement.
 */
export function squireCardTimeline(
  card: Pick<SquireCard, "timeline" | "createdAt" | "updatedAt" | "replacedCount" | "evidence">,
): ReadonlyArray<{ readonly at: string; readonly text: string }> {
  if (card.timeline.length > 0) return card.timeline;
  const entries: Array<{ at: string; text: string }> = [];
  const pr = card.evidence.pullRequest;
  if (pr !== undefined) {
    entries.push({
      at: card.createdAt,
      text: `PR #${pr.number} ${pr.transition.replaceAll(":", " ").replaceAll("-", " ")}`,
    });
  }
  entries.push({ at: card.createdAt, text: "raised" });
  if (card.replacedCount > 0 && card.updatedAt !== card.createdAt) {
    entries.push({ at: card.updatedAt, text: "updated" });
  }
  return entries;
}

/** The card's own entries, which the server writes without a subject. */
const TIMELINE_SUBJECT: ReadonlyMap<string, (raiser: string) => string> = new Map([
  ["raised", (raiser: string) => `${raiser} raised this`],
  ["opened", () => "You opened this"],
]);

/**
 * The inbox timeline as one "time · event" row per entry, oldest first as the server sends.
 * `raiser` names who raised the card, as `squireRaiserLabel` does.
 */
export function squireTimelineRows(
  timeline: ReadonlyArray<{ readonly at: string; readonly text: string }>,
  formatTime: (iso: string) => string,
  raiser: string,
): ReadonlyArray<{ readonly key: string; readonly time: string; readonly text: string }> {
  return timeline.flatMap((entry, index) => {
    const trimmed = entry.text.trim();
    const text = TIMELINE_SUBJECT.get(trimmed.toLowerCase())?.(raiser) ?? trimmed;
    // Two entries may share a time and text, so the index keeps keys apart.
    return text === "" ? [] : [{ key: `${index}:${entry.at}`, time: formatTime(entry.at), text }];
  });
}

type SquireControlPayload = Extract<SquireKnownPayload, { readonly type: "control" }>;

/** A control proposal as one readable line: "Pause Research: <reason>". */
export function squireControlText(
  payload: Pick<SquireControlPayload, "action" | "squireId" | "cardIds" | "toSquireId">,
  nameOf: (squireId: SquireId) => string,
  reason: string,
): string {
  const who = payload.squireId === null ? "a Squire" : nameOf(payload.squireId);
  const items = payload.cardIds?.length ?? 0;
  const itemsText = `${items} ${items === 1 ? "item" : "items"}`;
  let text: string;
  switch (payload.action) {
    case "pause":
      text = `Pause ${who}`;
      break;
    case "resume":
      text = `Resume ${who}`;
      break;
    case "rescope":
      text = `Change ${who}'s scope`;
      break;
    case "forward":
      text = `Forward ${items === 0 ? "an item" : itemsText} to ${
        payload.toSquireId === undefined ? "another Squire" : nameOf(payload.toSquireId)
      }`;
      break;
    case "merge":
      text = `Merge ${items === 0 ? "duplicate items" : `${itemsText} into one`}`;
      break;
  }
  const why = reason.trim();
  return why === "" ? text : `${text}: ${why}`;
}

type SquireProposalCardPayload = Extract<SquireKnownPayload, { readonly type: "squire-proposal" }>;

/** Scope as names: whole projects, Stave spaces and sagas, threads; exclusions counted. */
export function squireProposalScopeLabels(
  grants: ReadonlyArray<SquireGrantInput>,
  names: {
    readonly project: (projectId: string) => string | null;
    readonly thread: (threadId: string) => string | null;
  },
): ReadonlyArray<string> {
  const labels: string[] = [];
  let excluded = 0;
  for (const grant of grants) {
    switch (grant.kind) {
      case "project":
        labels.push(names.project(grant.targetId) ?? "A project");
        break;
      case "staveSpace":
        labels.push(`Space ${grant.targetId}`);
        break;
      case "staveSaga":
        labels.push(`Saga ${grant.targetId}`);
        break;
      case "thread":
        labels.push(names.thread(grant.targetId) ?? "A thread");
        break;
      case "exclusion":
        excluded++;
        break;
    }
  }
  if (excluded > 0) labels.push(`${excluded} ${excluded === 1 ? "thread" : "threads"} excluded`);
  return labels;
}

/**
 * What a proposal card reads: the name and scope in full, each on its own line, and
 * the permissions apart from them, so a long scope never squeezes the name.
 */
export function squireProposalCardText(
  proposal: Pick<SquireProposalCardPayload, "name" | "brief" | "grants" | "permissions">,
  names: Parameters<typeof squireProposalScopeLabels>[1],
) {
  const scope = squireProposalScopeLabels(proposal.grants, names);
  const brief = proposal.brief.trim();
  return {
    name: proposal.name.trim(),
    scope: scope.length === 0 ? "No scope yet" : scope.join(" · "),
    permissions: squireProposalPermissionsLabel(proposal.permissions),
    brief: brief === "" ? null : brief,
  };
}

const PALETTE_LABEL: Readonly<Record<SquireProposalCardPayload["companion"]["palette"], string>> = {
  brass: "Brass",
  moonstone: "Moonstone",
  sage: "Sage",
  rose: "Rose",
  gold: "Gold",
};

/**
 * The palette's name beside its swatch on a proposal card: the still bust's cloth tint is
 * subtle at card size and its halo stays warm on every palette, so the name tells proposals
 * apart.
 */
export function squireProposalPaletteLabel(
  palette: SquireProposalCardPayload["companion"]["palette"],
): string {
  return PALETTE_LABEL[palette];
}

const LEVEL_LABEL = { off: "Off", recommend: "Recommend", auto: "Auto" } as const;

/** "Recommend only" for a Lead-proposed Squire's default; otherwise each class that differs from it. */
export function squireProposalPermissionsLabel(permissions: SquirePermissions): string {
  const parts: string[] = [];
  if (permissions.steer !== "recommend") parts.push(`Steer ${LEVEL_LABEL[permissions.steer]}`);
  if (permissions.createThread !== "recommend") {
    parts.push(`Create thread ${LEVEL_LABEL[permissions.createThread]}`);
  }
  const notify = permissions.notify === "on" ? null : "Notify off";
  if (parts.length === 0) return notify === null ? "Recommend only" : `Recommend only · ${notify}`;
  return [...parts, ...(notify === null ? [] : [notify])].join(" · ");
}
