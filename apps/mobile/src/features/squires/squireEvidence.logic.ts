import {
  squireOverlapProviderNames,
  squireProposalCardText,
  squireProposalPaletteLabel,
  squireProposalProviderName,
  squireProposalScopeLabels as squireScopeLabels,
  squireRowProviderName as squireProviderLabel,
  squireRowTargetName as squireTargetName,
  squireSameText,
  squireWaitingSince,
  type SquireKnownPayload,
} from "@lecturn/client-runtime/state/squire";
import type { SquireCard, SquireCardRow, SquireGrantInput } from "@lecturn/contracts";

// Helpers web and mobile read alike live in client-runtime; this file keeps mobile's own
// shapes: ages from a ticking clock, a one-string row line, and names resolved from the row.
export {
  squireCardCaption,
  squireCardTimeline,
  squireControlText,
  squireDiffStatsLabel,
  squirePullRequestChips,
  squireQuestionWhyFallback,
  squireRaiserLabel,
  squireTimelineRows,
  squireWaitingSince,
  squireWhyText,
  type SquireChip,
  type SquireChipTone,
} from "@lecturn/client-runtime/state/squire";

// ── Ages ──────────────────────────────────────────────────────

/** A row's compact age: "now", "5m", "3h", "2d"; "" for an unreadable time. */
export function squireAgeText(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * A row's age. FYIs count from when they were raised; decisions from when they began waiting,
 * read as "waiting <age>" on a question, whose wait is the point, and on an open card.
 */
export function squireRowAgeText(
  row: Pick<SquireCardRow, "kind" | "createdAt" | "requestedAt">,
  expanded: boolean,
  nowMs: number,
): string {
  if (row.kind === "fyi") return squireAgeText(row.createdAt, nowMs);
  const age = squireAgeText(squireWaitingSince(row), nowMs);
  if (age === "") return "";
  return row.kind === "question" || expanded ? `waiting ${age}` : age;
}

// ── Rows ──────────────────────────────────────────────────────

/**
 * What a row points at: its thread; for an overlap, how many threads collide; for a proposal,
 * what it would create and where.
 */
export function squireRowTargetName(
  row: Pick<SquireCardRow, "kind" | "targetThreadId" | "proposalProvider" | "overlapProviders">,
  names: { readonly threadTitle: string | null; readonly projectTitle: string | null },
): string | null {
  return squireTargetName(row, {
    threadTitle: names.threadTitle ?? "Thread",
    projectTitle: names.projectTitle,
    overlapThreads: row.overlapProviders?.length ?? null,
  });
}

export interface SquireProviderNames {
  readonly instanceName: (instanceId: string) => string | null;
  readonly driverName: (driver: string) => string | undefined;
}

/**
 * The provider a row names: its thread's, a thread proposal's (instance, else driver), or each
 * overlapping thread's, once.
 */
export function squireRowProviderName(
  row: Pick<SquireCardRow, "proposalProvider" | "overlapProviders" | "overlapProviderInstanceIds">,
  threadProvider: string | null,
  names: SquireProviderNames,
): string | null {
  const instanceId = row.proposalProvider?.providerInstanceId;
  return squireProviderLabel({
    threadProvider,
    proposalProvider: squireProposalProviderName(
      row.proposalProvider,
      instanceId == null ? null : names.instanceName(instanceId),
      names.driverName,
    ),
    overlapProviders: squireOverlapProviderNames(row, names),
  });
}

/**
 * A row's secondary line: kind, raiser (Lead view), target, provider. The Lead view leaves the
 * provider off so every row there reads alike, and a target that repeats the title is dropped.
 */
export function squireRowMetaText(input: {
  readonly kind: string;
  readonly title: string;
  readonly raiser: string | null;
  readonly name: string | null;
  readonly provider: string | null;
}): string {
  const target = input.name === null || squireSameText(input.name, input.title) ? null : input.name;
  const provider = input.raiser === null ? input.provider : null;
  return [input.kind, input.raiser, target, provider].filter((part) => part !== null).join(" · ");
}

// ── Evidence ──────────────────────────────────────────────────

/** D21: the checks to look at when the failing job's log could not be read. */
export function squireCiUnavailableText(
  ciLog: NonNullable<SquireCard["evidence"]["ciLog"]>,
): string | null {
  if (ciLog.status !== "unavailable") return null;
  const jobs = ciLog.jobs.map((job) => job.name).filter((name) => name.trim() !== "");
  return jobs.length === 0
    ? "The failing job's log could not be read."
    : `The failing job's log could not be read; see ${jobs.join(", ")}.`;
}

// ── Lead items (P17.2) ────────────────────────────────────────

type ProposalPayload = Extract<SquireKnownPayload, { readonly type: "squire-proposal" }>;

/** Each granted target by name, exclusions as one count; mobile names no thread grant. */
export function squireProposalScopeLabels(
  grants: ReadonlyArray<SquireGrantInput>,
  projectName: (projectId: string) => string | null,
): ReadonlyArray<string> {
  return squireScopeLabels(grants, { project: projectName, thread: () => null });
}

/** What a Squire proposal card reads (P17.2): name, scope, palette, permissions, and brief. */
export function squireProposalText(
  proposal: Pick<ProposalPayload, "name" | "brief" | "grants" | "permissions" | "companion">,
  projectName: (projectId: string) => string | null,
) {
  return {
    ...squireProposalCardText(proposal, { project: projectName, thread: () => null }),
    palette: squireProposalPaletteLabel(proposal.companion.palette),
  };
}
