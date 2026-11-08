import {
  squireProposalCardText,
  squireProposalPaletteLabel,
  squireProposalScopeLabels as squireScopeLabels,
  squireRowTargetName as squireTargetName,
  squireSameText,
  type SquireKnownPayload,
} from "@lecturn/client-runtime/state/squire";
import type { SquireCard, SquireCardRow, SquireGrantInput } from "@lecturn/contracts";

// Helpers web and mobile read alike live in client-runtime; this file keeps mobile's own
// shapes: a one-string row line, and names resolved from the row.
export {
  squireControlText,
  squireDiffStatsLabel,
  squirePullRequestChips,
  squireWhyText,
  type SquireChip,
  type SquireChipTone,
} from "@lecturn/client-runtime/state/squire";

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

/** The checks to look at when the failing job's log could not be read. */
export function squireCiUnavailableText(
  ciLog: NonNullable<SquireCard["evidence"]["ciLog"]>,
): string | null {
  if (ciLog.status !== "unavailable") return null;
  const jobs = ciLog.jobs.map((job) => job.name).filter((name) => name.trim() !== "");
  return jobs.length === 0
    ? "The failing job's log could not be read."
    : `The failing job's log could not be read; see ${jobs.join(", ")}.`;
}

// ── Lead items ────────────────────────────────────────────────

type ProposalPayload = Extract<SquireKnownPayload, { readonly type: "squire-proposal" }>;

/** Each granted target by name, exclusions as one count; mobile names no thread grant. */
export function squireProposalScopeLabels(
  grants: ReadonlyArray<SquireGrantInput>,
  projectName: (projectId: string) => string | null,
): ReadonlyArray<string> {
  return squireScopeLabels(grants, { project: projectName, thread: () => null });
}

/** What a Squire proposal card reads: name, scope, palette, permissions, and brief. */
export function squireProposalText(
  proposal: Pick<ProposalPayload, "name" | "brief" | "grants" | "permissions" | "companion">,
  projectName: (projectId: string) => string | null,
) {
  return {
    ...squireProposalCardText(proposal, { project: projectName, thread: () => null }),
    palette: squireProposalPaletteLabel(proposal.companion.palette),
  };
}
