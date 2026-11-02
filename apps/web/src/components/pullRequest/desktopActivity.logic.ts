import { activityProjectIcon } from "./activityProjectIcon";
import { selectMergeHandoffThread } from "@lecturn/client-runtime/state/pullRequestHandoff";
import { isRepositoryWatchManagerEligible } from "@lecturn/client-runtime/state/repositoryScope";
import { scopedThreadKey } from "@lecturn/client-runtime/environment";
import {
  activityVisualState,
  describeThreadActivity,
  threadActivityExcerpt,
} from "@lecturn/client-runtime/state/activityContext";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/models";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
  type SagaProjectIndexEntry,
} from "@lecturn/client-runtime/state/project-grouping";
import {
  resolveRepositoryScope,
  type RepositoryScopeProject,
} from "@lecturn/client-runtime/state/repositoryScope";
import type { OrchestrationProjectShell, ScopedProjectRef } from "@lecturn/contracts";
import type {
  DesktopActivityAction,
  DesktopActivityRow,
  DesktopActivitySnapshot,
  DesktopActivitySquireResult,
  EnvironmentId,
  PullRequestWatchSnapshot,
  SquireCardId,
  SquireCardRow,
  SquireId,
  SquireItemAction,
  SquireItemsActResult,
  SquirePalette,
  SquireRule,
  SquireRuleOffer,
  ThreadId,
} from "@lecturn/contracts";
import {
  holdRemaining,
  type SquireEnvironmentState,
  squireHeldLabel,
  squireRuleOfferPrompt,
  squireSupersededNote,
} from "@lecturn/client-runtime/state/squire";
import {
  SQUIRE_KIND_LABEL,
  squireCardCaption,
  squireCardOrigins,
  squireOfferRuleInput,
  squireAcceptOffer,
  squireRowAction,
  squireRowTargetName,
  squireSteerKindLabel,
  squireUndoOffer,
} from "../squire/queue/squireQueue.logic";

/** Messages of a subscribed V2 detail for one thread, if any. */
export function threadDetailMessages(
  details: readonly (EnvironmentThread | null)[],
  environmentId: EnvironmentId,
  threadId: EnvironmentThreadShell["id"],
) {
  return details.find(
    (item) => item?.environmentId === environmentId && item.projection.thread.id === threadId,
  )?.projection.messages;
}

function threadRuntimeStatus(thread: Pick<EnvironmentThreadShell, "runtime">) {
  return thread.runtime?.status ?? null;
}

function hasBackgroundTasks(
  thread: Partial<Pick<EnvironmentThreadShell, "pendingBackgroundTasks">>,
): boolean {
  return (thread.pendingBackgroundTasks?.length ?? 0) > 0;
}

export function watchActivityRows(
  values: readonly (readonly [EnvironmentId, PullRequestWatchSnapshot])[],
  threads: readonly EnvironmentThreadShell[] = [],
  details: readonly (EnvironmentThread | null)[] = [],
  projects: readonly RepositoryScopeProject[] = [],
  sagaIndex?: readonly SagaProjectIndexEntry[],
): DesktopActivityRow[] {
  return values.flatMap(([environmentId, snapshot]) =>
    snapshot.watches
      .filter((watch) => watch.watching)
      .toSorted(
        (a, b) =>
          Number(Boolean(b.error)) - Number(Boolean(a.error)) ||
          b.updatedAt.localeCompare(a.updatedAt),
      )
      .map((watch): DesktopActivityRow => {
        const eligible = threads.filter(
          (thread) =>
            !thread.archivedAt &&
            isRepositoryWatchManagerEligible({
              projects,
              ...(sagaIndex ? { sagaIndex } : {}),
              environmentId,
              thread,
              watch,
            }),
        );
        const recipient = selectMergeHandoffThread(watch, eligible);
        const legacyAuthorization =
          watch.authorization !== null &&
          ["waiting", "armed", "blocked"].includes(watch.authorization.status);
        return {
          id: JSON.stringify([environmentId, watch.id]),
          environmentId,
          projectId: watch.reference.projectId,
          watchId: watch.id,
          watchRevision: watch.revision,
          defaultMergeMode: watch.authorization?.mode ?? snapshot.defaultMergeMode,
          ...(recipient
            ? { threadId: recipient.id, mergeRecipient: recipient.title.slice(0, 300) }
            : {}),
          title: `${watch.reference.repository} #${watch.reference.number}`,
          subtitle: watch.observation?.title ?? "Awaiting observation",
          status: `${watch.error ? "Error · " : ""}${watch.observation?.state === "merged" ? "Merged · " : ""}${watch.managerStatus} · checks ${watch.observation?.checksState ?? "unknown"}`,
          checkTotal: watch.observation?.checks.length ?? 0,
          checks: (watch.observation?.checks ?? []).slice(0, 50).map((check) => ({
            name: check.name.slice(0, 300),
            status: check.status,
            ...(check.description ? { description: check.description.slice(0, 500) } : {}),
          })),
          mergeStatus: legacyAuthorization
            ? `Existing server merge authorization: ${watch.authorization!.status}. Revoke it before handing control to an agent.`
            : recipient
              ? `Send a merge-when-ready instruction to ${recipient.title}.`.slice(0, 1000)
              : "Choose an associated thread to handle this PR.",
          detail: [
            watch.error,
            watch.observation
              ? `Required checks: ${watch.observation.requiredChecks} · Observed ${new Date(watch.observation.observedAt).toLocaleString()}`
              : "Not yet observed",
            ...eligible
              .filter(
                (thread) =>
                  watch.threadIds.includes(thread.id) || thread.id === watch.managerThreadId,
              )
              .slice(0, 3)
              .map((thread) =>
                thread.id === recipient?.id
                  ? `Agent thread: ${thread.title}\n${describeThreadActivity(thread, threadDetailMessages(details, environmentId, thread.id))}`
                  : `Associated thread: ${thread.title}`,
              ),
          ]
            .filter(Boolean)
            .join("\n"),
          actions: [
            { id: "open", label: "Open PR" },
            { id: "stop-watch", label: "Stop watching" },
            {
              id: "merge",
              label: recipient ? "Merge when ready" : "Choose agent",
              disabled: legacyAuthorization || watch.observation?.state !== "open",
            },
            ...(watch.authorization
              ? [{ id: "revoke-merge" as const, label: "Revoke merge" }]
              : []),
            ...(recipient ? [{ id: "steer" as const, label: "Steer thread" }] : []),
          ],
        };
      }),
  );
}

/** Match the whole published identity before routing a native request to an environment. */
export function resolveActivityAction(
  action: DesktopActivityAction,
  rows: readonly DesktopActivityRow[],
) {
  return (
    rows.find(
      (row) =>
        row.id === action.rowId &&
        row.environmentId === action.environmentId &&
        row.projectId === action.projectId &&
        row.threadId === action.threadId &&
        row.watchId === action.watchId &&
        row.watchRevision === action.watchRevision &&
        row.actions.some((candidate) => candidate.id === action.kind && !candidate.disabled),
    ) ?? null
  );
}

/** Project folders union their children; saga roots additionally expand their spaces. */
export function scopedPullRequestProjectIds(
  projects: readonly RepositoryScopeProject[],
  root: ScopedProjectRef,
  settings: ProjectGroupingSettings,
  sagaIndex?: readonly SagaProjectIndexEntry[],
) {
  const project = projects.find(
    (item) => item.environmentId === root.environmentId && item.id === root.projectId,
  );
  if (!project) return [root.projectId];
  const key = deriveLogicalProjectKeyFromSettings(project, settings);
  const roots = projects
    .filter(
      (item) =>
        item.environmentId === root.environmentId &&
        deriveLogicalProjectKeyFromSettings(item, settings) === key,
    )
    .map((item) => ({ environmentId: item.environmentId, projectId: item.id }));
  const targets = resolveRepositoryScope({ projects, roots, ...(sagaIndex ? { sagaIndex } : {}) });
  return [
    ...new Set([
      ...roots.map((item) => item.projectId),
      ...targets.flatMap((item) => item.projectIds),
    ]),
  ];
}

export function threadActivityRows(
  threads: readonly (Pick<
    EnvironmentThreadShell,
    | "id"
    | "environmentId"
    | "projectId"
    | "title"
    | "modelSelection"
    | "runtime"
    | "archivedAt"
    | "settledOverride"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
  > &
    Partial<Pick<EnvironmentThreadShell, "pendingBackgroundTasks" | "latestUserMessageAt">>)[],
  connected: ReadonlySet<EnvironmentId>,
  interactions: Readonly<Record<string, string>> = {},
): DesktopActivityRow[] {
  const keyOf = (thread: { environmentId: EnvironmentId; id: EnvironmentThreadShell["id"] }) =>
    scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
  const interactedAt = (thread: (typeof threads)[number]) =>
    [interactions[keyOf(thread)], thread.latestUserMessageAt]
      .filter((at): at is string => typeof at === "string")
      .sort()
      .at(-1) ?? "";
  // Settled conversations remain in the live shell stream. Exclude them before
  // choosing recent slots, even if stale runtime metadata still reports activity.
  const eligible = threads.filter(
    (thread) => !thread.archivedAt && thread.settledOverride !== "settled",
  );
  const recent = new Set(
    eligible
      .filter((thread) => interactedAt(thread))
      .toSorted(
        (a, b) =>
          interactedAt(b).localeCompare(interactedAt(a)) || keyOf(a).localeCompare(keyOf(b)),
      )
      .slice(0, 3)
      .map(keyOf),
  );
  return eligible
    .filter(
      (thread) =>
        recent.has(keyOf(thread)) ||
        (connected.has(thread.environmentId) &&
          (isWorkingRuntime(threadRuntimeStatus(thread)) ||
            threadRuntimeStatus(thread) === "failed" ||
            hasBackgroundTasks(thread) ||
            thread.hasPendingApprovals ||
            thread.hasPendingUserInput)),
    )
    .toSorted(
      (a, b) =>
        Number(recent.has(keyOf(b))) - Number(recent.has(keyOf(a))) ||
        interactedAt(b).localeCompare(interactedAt(a)),
    )
    .map((thread) => ({
      id: JSON.stringify([thread.environmentId, "thread", thread.id]),
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      threadId: thread.id,
      recent: recent.has(keyOf(thread)),
      title: thread.title,
      subtitle: thread.modelSelection.model,
      detail: describeThreadActivity(thread),
      status: thread.hasPendingApprovals
        ? "Needs approval"
        : thread.hasPendingUserInput
          ? "Needs input"
          : threadRuntimeStatus(thread) === "failed"
            ? "Agent error"
            : isWorkingRuntime(threadRuntimeStatus(thread))
              ? "Working"
              : hasBackgroundTasks(thread)
                ? "Working · background tasks"
                : isStoppedRuntime(threadRuntimeStatus(thread))
                  ? "Stopped"
                  : "Idle",
      actions: [
        { id: "open", label: "Open thread" },
        { id: "steer", label: "Steer thread" },
      ],
    }));
}

function isWorkingRuntime(status: ReturnType<typeof threadRuntimeStatus>): boolean {
  return (
    status === "preparing" || status === "starting" || status === "running" || status === "waiting"
  );
}

function isStoppedRuntime(status: ReturnType<typeof threadRuntimeStatus>): boolean {
  return status === "interrupted" || status === "cancelled";
}

/** Keep IPC publication within the shell's bounds as watch history grows. */
export function boundedActivitySnapshot(
  rows: readonly DesktopActivityRow[],
): DesktopActivitySnapshot {
  const visible = rows.slice(0, 200).map((row) => ({
    ...row,
    title: row.title.slice(0, 300),
    subtitle: row.subtitle.slice(0, 300),
    ...(row.detail ? { detail: row.detail.slice(0, 3000) } : {}),
  }));
  while (visible.length > 0 && JSON.stringify(visible).length > 900_000) visible.pop();
  return {
    summary:
      visible.length < rows.length
        ? `${rows.length} activity items · showing ${visible.length}`
        : `${rows.length} activity ${rows.length === 1 ? "item" : "items"}`,
    rows: visible,
  };
}

/** A stopped manager does not mean the PR monitor is disconnected. */
export function activityRowVisualState(
  row: DesktopActivityRow,
  thread?: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "runtime" | "settledOverride"
  >,
) {
  const disconnected = /^(offline|monitor unavailable) · last observed$/i.test(row.status);
  const status = disconnected
    ? "offline"
    : row.watchId
      ? [
          row.status.replace(/\boffline\b/gi, "idle"),
          thread?.hasPendingApprovals
            ? "approval"
            : thread?.hasPendingUserInput
              ? "needs input"
              : "",
          thread?.runtime?.status === "failed" ? "error" : "",
        ].join(" · ")
      : row.status;
  return activityVisualState({
    status,
    checks: row.checks,
    settled: !row.watchId && thread?.settledOverride === "settled",
  });
}

/** Enrich only matching environment identities; compact copy contains agent text, never tool payloads. */
export function contextualActivityRows(
  rows: readonly DesktopActivityRow[],
  threads: readonly EnvironmentThreadShell[],
  projects: readonly (RepositoryScopeProject &
    Partial<Pick<OrchestrationProjectShell, "title" | "projectIcon">>)[],
  details: readonly (EnvironmentThread | null)[],
): DesktopActivityRow[] {
  return rows.map((row) => {
    const project = projects.find(
      (item) => item.environmentId === row.environmentId && item.id === row.projectId,
    );
    const thread = threads.find(
      (item) => item.environmentId === row.environmentId && item.id === row.threadId,
    );
    const messages = row.threadId
      ? threadDetailMessages(
          details,
          row.environmentId as EnvironmentId,
          row.threadId as EnvironmentThreadShell["id"],
        )
      : undefined;
    const label =
      project?.title ??
      project?.stave?.spaceId ??
      project?.workspaceRoot.split(/[\\/]/).findLast((segment) => segment !== "");
    return {
      ...row,
      visualState: activityRowVisualState(row, thread),
      ...(thread?.latestUserMessageAt ? { userPromptAt: thread.latestUserMessageAt } : {}),
      userSettled: thread?.settledOverride === "settled",
      userStopped:
        thread?.latestRun?.status === "interrupted" ||
        isStoppedRuntime(thread ? threadRuntimeStatus(thread) : null),
      ...(label ? { projectLabel: label.slice(0, 300) } : {}),
      ...(project && label ? { projectIcon: activityProjectIcon(label, project.projectIcon) } : {}),
      projectKind: project?.stave ? (project.stave.isSaga ? "saga" : "space") : "project",
      excerpt: (row.status === "Action failed"
        ? (row.mergeStatus ?? "Action failed")
        : thread
          ? threadActivityExcerpt(thread, messages)
          : row.subtitle
      ).slice(0, 180),
    };
  });
}

/** Cosmetic ownership comes from the authenticated catalog, never activity text. */
export function withActivityAccountMarks(
  rows: readonly DesktopActivityRow[],
  marks: ReadonlyMap<
    string,
    { readonly accountId: string; readonly label: string; readonly color: string }
  >,
): DesktopActivityRow[] {
  return rows.map(({ accountId: _id, accountLabel: _label, accountColor: _color, ...row }) => {
    const mark = marks.get(row.environmentId);
    return mark
      ? {
          ...row,
          accountId: mark.accountId,
          accountLabel: mark.label.slice(0, 80),
          accountColor: mark.color,
        }
      : row;
  });
}

// ── Squire rows (10c) ─────────────────────────────────────────

/** One environment's Squires as the notch reads them. */
export interface SquireActivitySource {
  readonly environmentId: EnvironmentId;
  readonly state: SquireEnvironmentState;
  /** The Lead's combined open decision queue (`decisionItems`), held cards included. */
  readonly items: ReadonlyArray<SquireCardRow>;
  /** Rules by raiser, for "Auto by rule" labels; missing while loading. */
  readonly rules: ReadonlyMap<SquireId, ReadonlyArray<SquireRule>>;
  readonly threadTitle: (threadId: ThreadId) => string | null;
  /** A project's name, for rows that name a project rather than a thread (overlaps). */
  readonly projectTitle?: (projectId: string) => string | null;
  readonly targetName: (rule: Pick<SquireRule, "targetKind" | "targetId">) => string;
}

type SquireHeldEntry = SquireEnvironmentState["squires"][number];

/** A held card with its hold, from whichever Squire's snapshot carries it. */
function squireHoldOf(
  state: SquireEnvironmentState,
  cardId: SquireCardId,
): { readonly entry: SquireHeldEntry; readonly hold: SquireHeldEntry["held"][number] } | null {
  for (const entry of state.squires) {
    const hold = entry.held.find((candidate) => candidate.cardId === cardId);
    if (hold !== undefined) return { entry, hold };
  }
  return null;
}

/**
 * P7.6: a hold is not an item, so it sits beside the open card of the same raiser, thread, and
 * kind. The notch shows the two as one card, the open card with the hold's countdown and Undo,
 * keyed by that open card. One hold per card; any other keeps its own row.
 */
export function squireActivityHoldPairs(
  source: Pick<SquireActivitySource, "state" | "items">,
): ReadonlyMap<SquireCardId, SquireCardRow> {
  const open = new Set(
    source.items
      .filter((card) => card.kind !== "fyi" && card.status === "open")
      .map((card) => card.id),
  );
  const pairs = new Map<SquireCardId, SquireCardRow>();
  for (const card of source.items) {
    if (card.status !== "held") continue;
    const over = squireHoldOf(source.state, card.id)?.hold.heldOverCardId;
    if (over !== undefined && open.has(over) && !pairs.has(over)) pairs.set(over, card);
  }
  return pairs;
}

/** P8.1 "Always ask first for this", offered in the notch after an Undo there. */
export interface SquireActivityOffer {
  readonly environmentId: EnvironmentId;
  readonly card: Pick<SquireCardRow, "id" | "squireId" | "ownerSquireId" | "kind">;
  readonly squireName: string;
  readonly palette: SquirePalette;
  readonly offer: SquireRuleOffer;
  /** The undone card's project, so the offer sits under the same project as its card did. */
  readonly projectId?: string;
}

export function squireActivityRowId(environmentId: EnvironmentId, cardId: SquireCardId): string {
  return JSON.stringify([environmentId, "squire", cardId]);
}

export function squireOfferRowId(environmentId: EnvironmentId, cardId: SquireCardId): string {
  return JSON.stringify([environmentId, "squire-offer", cardId]);
}

const formatCaptionTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The notch's "SQUIRE" rows: open decision cards, held actions with their hold, then offers. */
export function squireActivityRows(
  sources: ReadonlyArray<SquireActivitySource>,
  offers: ReadonlyArray<SquireActivityOffer>,
  now: number,
): DesktopActivityRow[] {
  const cards = sources.flatMap((source) => {
    const names = {
      squireName: (squireId: SquireId) =>
        source.state.squires.find((entry) => entry.squire.id === squireId)?.squire.name ?? "Squire",
      targetName: source.targetName,
    };
    const pairs = squireActivityHoldPairs(source);
    const paired = new Set([...pairs.values()].map((card) => card.id));
    return source.items.flatMap((card): DesktopActivityRow[] => {
      if (card.kind === "fyi" || (card.status !== "open" && card.status !== "held")) return [];
      if (paired.has(card.id)) return [];
      const raiser = source.state.squires.find((entry) => entry.squire.id === card.squireId);
      if (raiser === undefined) return [];
      const newer = pairs.get(card.id);
      const held = squireHoldOf(source.state, newer?.id ?? card.id);
      // A held card without its hold has already run or been undone; the snapshot is newer.
      if (card.status === "held" && held === null) return [];
      // An overlap names no one thread, so it reads as the web row does: "2 threads · <project>".
      const excerpt =
        card.targetThreadId !== null
          ? source.threadTitle(card.targetThreadId)
          : card.kind === "overlap"
            ? squireRowTargetName(card, {
                threadTitle: null,
                projectTitle:
                  card.projectId === null ? null : (source.projectTitle?.(card.projectId) ?? null),
                // One provider per named thread; `relatedSquireIds` counts Squires, not threads.
                overlapThreads: card.overlapProviders?.length ?? null,
              })
            : null;
      const origins = squireCardOrigins(card, source.rules.get(card.squireId) ?? [], names);
      const caption =
        newer === undefined
          ? squireCardCaption(card, raiser, formatCaptionTime)
          : squireSupersededNote(card.kind);
      const primary = squireRowAction(card);
      const steer = squireSteerKindLabel(card.steerKind);
      // The paired hold's Undo: the notch shows it on the `heldOver` line, and resolving it acts
      // on the held card.
      const heldUndo = newer === undefined ? [] : [{ id: "squire-undo" as const, label: "Undo" }];
      const heldRule =
        newer === undefined || newer.ruleId === null
          ? undefined
          : squireCardOrigins(newer, source.rules.get(newer.squireId) ?? [], names)[0];
      return [
        {
          id: squireActivityRowId(source.environmentId, card.id),
          environmentId: source.environmentId,
          projectId: card.projectId ?? raiser.squire.homeProjectId,
          ...(card.targetThreadId === null ? {} : { threadId: card.targetThreadId }),
          title: card.title,
          subtitle: raiser.squire.name,
          ...(excerpt === null ? {} : { excerpt: excerpt.slice(0, 180) }),
          ...(origins.length === 0 ? {} : { detail: origins.join("\n") }),
          squire: {
            squireId: card.ownerSquireId,
            cardId: card.id,
            cardKind: card.kind,
            palette: raiser.squire.companion.palette,
            ...(held === null || newer !== undefined
              ? {}
              : {
                  holdRemainingMs: holdRemaining(
                    held.entry.receivedAt,
                    held.hold.executesInMs,
                    now,
                  ),
                }),
            ...(caption === null ? {} : { caption: caption.slice(0, 300) }),
            ...(newer === undefined || held === null
              ? {}
              : {
                  heldOver: {
                    heldCardId: newer.id,
                    label: squireHeldLabel(newer.kind),
                    remainingMs: holdRemaining(held.entry.receivedAt, held.hold.executesInMs, now),
                    ...(heldRule === undefined ? {} : { ruleLabel: heldRule.slice(0, 300) }),
                  },
                }),
          },
          status:
            card.status === "held"
              ? "Held"
              : `${SQUIRE_KIND_LABEL[card.kind]}${steer === null ? "" : ` · ${steer}`}`,
          actions:
            card.status === "held"
              ? [
                  { id: "squire-undo", label: "Undo" },
                  { id: "squire-open", label: "Open" },
                ]
              : // Every card reads primary, Dismiss, Open to its Squire's view (P7.7). The notch
                // cannot answer a question or show overlap evidence, so Answer and Review open
                // the card there too; Open thread appears only for a single target thread.
                primary?.type === "expand"
                ? [
                    { id: "squire-open", label: primary.label },
                    { id: "squire-dismiss", label: "Dismiss" },
                    { id: "squire-open", label: "Open" },
                    ...(card.targetThreadId === null
                      ? []
                      : [{ id: "open" as const, label: "Open thread" }]),
                    ...heldUndo,
                  ]
                : [
                    ...(primary?.type === "accept"
                      ? [{ id: "squire-accept" as const, label: primary.label }]
                      : []),
                    { id: "squire-dismiss", label: "Dismiss" },
                    { id: "squire-open", label: "Open" },
                    ...heldUndo,
                  ],
        },
      ];
    });
  });
  const offerRows = offers.map((offer): DesktopActivityRow => {
    const prompt = squireRuleOfferPrompt(offer.offer);
    const raiser = sources
      .find((source) => source.environmentId === offer.environmentId)
      ?.state.squires.find((entry) => entry.squire.id === offer.card.squireId);
    return {
      id: squireOfferRowId(offer.environmentId, offer.card.id),
      environmentId: offer.environmentId,
      projectId: offer.projectId ?? raiser?.squire.homeProjectId ?? "",
      title: prompt.action,
      subtitle: offer.squireName,
      status: "Rule offer",
      squire: {
        squireId: offer.card.ownerSquireId,
        cardId: offer.card.id,
        cardKind: offer.card.kind,
        palette: offer.palette,
        caption: prompt.text.slice(0, 300),
      },
      actions: prompt.canSave
        ? [
            { id: "squire-accept", label: "Save rule" },
            { id: "squire-dismiss", label: "Not now" },
          ]
        : [{ id: "squire-dismiss", label: "OK" }],
    };
  });
  return [...cards, ...offerRows];
}

/**
 * A press in flight disables the row. A refusal is not overlaid: the notch shows the server's
 * words on the card from the press's result, until the user dismisses them.
 */
export function squireActivityOverlay(
  rows: ReadonlyArray<DesktopActivityRow>,
  pending: ReadonlySet<string>,
): DesktopActivityRow[] {
  return rows.map((row) =>
    pending.has(row.id)
      ? {
          ...row,
          status: "Updating…",
          actions: row.actions.map((action) => ({ ...action, disabled: true })),
        }
      : row,
  );
}

export type SquireActivityAction = Extract<DesktopActivityAction, { readonly requestId: string }>;

export type SquireActivityTarget =
  | {
      readonly type: "card";
      readonly row: DesktopActivityRow;
      readonly environmentId: EnvironmentId;
      /** The owner, whose view opens the card. */
      readonly squireId: SquireId;
      readonly cardId: SquireCardId;
      /** What an Undo's ask-first offer needs; its rule belongs to the raiser. */
      readonly card: SquireActivityOffer["card"];
      /** The queue's card, which decides whether an accept may offer "Always allow this". */
      readonly item: Pick<SquireCardRow, "kind" | "origin" | "steerKind"> | null;
      readonly squireName: string;
      readonly palette: SquirePalette;
    }
  | {
      readonly type: "offer";
      readonly row: DesktopActivityRow;
      readonly offer: SquireActivityOffer;
    };

/**
 * Matches the whole published identity, as `resolveActivityAction` does, then the card or offer.
 * `sources` names a Lead-raised card's raiser, which the row does not carry.
 */
export function resolveSquireActivityAction(
  action: SquireActivityAction,
  rows: ReadonlyArray<DesktopActivityRow>,
  offers: ReadonlyArray<SquireActivityOffer>,
  sources: ReadonlyArray<
    Pick<SquireActivitySource, "environmentId" | "items"> &
      Partial<Pick<SquireActivitySource, "state">>
  > = [],
): SquireActivityTarget | null {
  const row = resolveActivityAction(
    action,
    rows.filter((candidate) => candidate.squire !== undefined),
  );
  if (row?.squire === undefined) return null;
  const environmentId = row.environmentId as EnvironmentId;
  const { cardId } = row.squire;
  if (row.id === squireOfferRowId(environmentId, cardId)) {
    const offer = offers.find(
      (candidate) => candidate.environmentId === environmentId && candidate.card.id === cardId,
    );
    return offer === undefined ? null : { type: "offer", row, offer };
  }
  if (row.id !== squireActivityRowId(environmentId, cardId)) return null;
  const source = sources.find((candidate) => candidate.environmentId === environmentId);
  const open = source?.items.find((candidate) => candidate.id === cardId) ?? null;
  // An open card's Undo is the paired hold's (P7.6): it acts on the held card beside it.
  const newer =
    action.kind === "squire-undo" && open?.status === "open" && source?.state !== undefined
      ? (squireActivityHoldPairs({ state: source.state, items: source.items }).get(cardId) ?? null)
      : null;
  if (action.kind === "squire-undo" && open?.status === "open" && newer === null) return null;
  const item = newer ?? open;
  const raiser = item?.squireId ?? row.squire.squireId;
  return {
    type: "card",
    row,
    environmentId,
    squireId: item?.ownerSquireId ?? row.squire.squireId,
    cardId: item?.id ?? cardId,
    card: {
      id: item?.id ?? cardId,
      squireId: raiser,
      ownerSquireId: item?.ownerSquireId ?? row.squire.squireId,
      kind: item?.kind ?? row.squire.cardKind,
    },
    item,
    squireName: row.subtitle,
    palette: row.squire.palette,
  };
}

export type SquireActivityCallResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

export interface SquireActivityDeps {
  readonly act: (
    environmentId: EnvironmentId,
    input: { readonly cardIds: ReadonlyArray<SquireCardId>; readonly action: SquireItemAction },
  ) => Promise<SquireActivityCallResult<typeof SquireItemsActResult.Type>>;
  readonly createRule: (
    environmentId: EnvironmentId,
    input: ReturnType<typeof squireOfferRuleInput>,
  ) => Promise<SquireActivityCallResult<unknown>>;
  readonly open: (
    environmentId: EnvironmentId,
    squireId: SquireId,
    cardId: SquireCardId,
  ) => Promise<void>;
}

/** Not a failure: the card already settled, went out of date, or is gone (P7.7). */
const SQUIRE_SETTLED_STATUSES = new Set([
  "resolved",
  "executed",
  "executing",
  "dismissed",
  "outdated",
]);

/**
 * A per-card answer as the notch shows it. Outdated, gone, and already settled are info; a refusal
 * with a reason is an error. The contract has no kind, so info travels as `ok` with a message.
 */
export function squireActivityItemResult(
  requestId: string,
  item: Pick<(typeof SquireItemsActResult.Type)["results"][number], "status" | "error"> | undefined,
): DesktopActivitySquireResult {
  if (item?.error == null) return { requestId, ok: true };
  const { error, status } = item;
  const message = error.message.slice(0, 1000);
  const info =
    error.code === "outdated" ||
    error.code === "not_found" ||
    (error.code === "invalid_request" && SQUIRE_SETTLED_STATUSES.has(status));
  return info ? { requestId, ok: true, error: message } : { requestId, ok: false, error: message };
}

/** The bridge's own answers: info when the item is gone or already updating. */
export function squireActivityInfo(
  requestId: string,
  message: string,
): DesktopActivitySquireResult {
  return { requestId, ok: true, error: message };
}

export interface SquireActivityOutcome {
  /** What the notch shows for this press (D40): the server's own outcome. */
  readonly result: DesktopActivitySquireResult;
  /** An Undo's ask-first offer, or an accept's "Always allow this". */
  readonly offer: SquireActivityOffer | null;
  /** The offer row this press settled, saved or dismissed. */
  readonly settledOffer: SquireCardId | null;
}

const ITEM_ACTION = {
  "squire-accept": "accept",
  "squire-dismiss": "dismiss",
  "squire-undo": "undo",
} as const satisfies Partial<Record<SquireActivityAction["kind"], SquireItemAction>>;

export async function runSquireActivityAction(
  action: SquireActivityAction,
  target: SquireActivityTarget,
  deps: SquireActivityDeps,
): Promise<SquireActivityOutcome> {
  const { requestId } = action;
  const failed = (error: string): SquireActivityOutcome => ({
    result: { requestId, ok: false, error: error.slice(0, 1000) },
    offer: null,
    settledOffer: null,
  });
  const done = (
    rest: Omit<SquireActivityOutcome, "result"> = { offer: null, settledOffer: null },
  ) => ({
    result: { requestId, ok: true },
    ...rest,
  });
  try {
    if (target.type === "offer") {
      const { offer } = target;
      if (action.kind === "squire-accept") {
        const created = await deps.createRule(
          offer.environmentId,
          squireOfferRuleInput(offer.offer, "offer", offer.card),
        );
        if (!created.ok) return failed(created.error);
      }
      return done({ offer: null, settledOffer: offer.card.id });
    }
    if (action.kind === "squire-open") {
      await deps.open(target.environmentId, target.squireId, target.cardId);
      return done();
    }
    const acted = await deps.act(target.environmentId, {
      cardIds: [target.cardId],
      action: ITEM_ACTION[action.kind],
    });
    if (!acted.ok) return failed(acted.error);
    const own = acted.value.results.find((result) => result.cardId === target.cardId);
    const result = squireActivityItemResult(requestId, own);
    if (result.error !== undefined) return { result, offer: null, settledOffer: null };
    const ruleOffer = own?.ruleOffer;
    const offers =
      action.kind === "squire-undo"
        ? squireUndoOffer(ruleOffer) !== null
        : action.kind === "squire-accept" &&
          target.item !== null &&
          squireAcceptOffer(target.item, ruleOffer) !== null;
    return done({
      offer:
        offers && ruleOffer !== undefined
          ? {
              environmentId: target.environmentId,
              card: target.card,
              squireName: target.squireName,
              palette: target.palette,
              offer: ruleOffer,
              projectId: target.row.projectId,
            }
          : null,
      settledOffer: null,
    });
  } catch (cause) {
    return failed(
      cause instanceof Error ? cause.message : "The environment could not complete the action.",
    );
  }
}

/**
 * Coalesces snapshot publications to one per window, so streamed assistant text cannot flood
 * IPC, without starving updates during a long response.
 */
export class CoalescedActivityPublication<S> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latest: S | null = null;

  constructor(private readonly delayMs = 300) {}

  offer(snapshot: S, publish: (snapshot: S) => void): void {
    this.latest = snapshot;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const latest = this.latest;
      this.latest = null;
      if (latest !== null) publish(latest);
    }, this.delayMs);
  }

  /** Forgets the cleared timer too, or every later offer would wait on one that never fires. */
  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.latest = null;
  }
}
