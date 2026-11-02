import type { SquireEnvironmentState } from "@lecturn/client-runtime/state/squire";
import type { SquireGrantInput, SquireId } from "@lecturn/contracts";

/**
 * `unknown` is a thread a Stave space or saga grant may cover: the client does not know which
 * space or saga a thread belongs to, so it cannot tell. The server decides (`SquireScope.ts`).
 */
export type SquireThreadTracking = "tracked" | "untracked" | "unknown";

/** P2.1, as the server reads it: an exclusion on the thread beats every container grant. */
export function squireThreadTracking(
  grants: ReadonlyArray<SquireGrantInput>,
  target: { readonly threadId: string; readonly projectId: string },
): SquireThreadTracking {
  if (grants.some((grant) => grant.kind === "exclusion" && grant.targetId === target.threadId)) {
    return "untracked";
  }
  if (
    grants.some(
      (grant) =>
        (grant.kind === "thread" && grant.targetId === target.threadId) ||
        (grant.kind === "project" && grant.targetId === target.projectId),
    )
  ) {
    return "tracked";
  }
  return grants.some((grant) => grant.kind === "staveSpace" || grant.kind === "staveSaga")
    ? "unknown"
    : "untracked";
}

export interface SquireTrackingAction {
  readonly kind: "track" | "untrack";
  readonly squireId: SquireId;
  readonly label: string;
}

interface TrackableThread {
  readonly id: string;
  readonly projectId: string;
  readonly squire?: unknown;
}

/** Squires that could track a thread: the Lead has no scope, and a deleting Squire is going. */
function trackingCandidates(state: SquireEnvironmentState | null, thread: TrackableThread) {
  // No Squire-on-Squire: home and probe threads are never tracked.
  if (state === null || thread.squire !== undefined) return [];
  return state.squires.filter(
    (entry) =>
      entry.squire.role !== "lead" &&
      entry.squire.id !== state.lead &&
      entry.squire.lifecycle !== "deleting",
  );
}

/**
 * "Track with" or "Stop tracking with" per Squire, by name. An `unknown` thread offers Track:
 * a direct thread grant is harmless if a Stave grant already covers it, and it makes the
 * thread's tracking known, so Stop tracking shows next. Untracking a thread a project covers
 * makes the server add an exclusion.
 */
export function squireTrackingActions(
  state: SquireEnvironmentState | null,
  thread: TrackableThread,
): ReadonlyArray<SquireTrackingAction> {
  return [...trackingCandidates(state, thread)]
    .sort((a, b) => a.squire.name.localeCompare(b.squire.name, undefined, { sensitivity: "base" }))
    .map((entry) => {
      const tracked =
        squireThreadTracking(entry.squire.grants, {
          threadId: thread.id,
          projectId: thread.projectId,
        }) === "tracked";
      return {
        kind: tracked ? ("untrack" as const) : ("track" as const),
        squireId: entry.squire.id,
        label: tracked
          ? `Stop tracking with ${entry.squire.name}`
          : `Track with ${entry.squire.name}`,
      };
    });
}

/**
 * Squires whose open decisions may target this thread, so the banner queries only those. A
 * Stave-covered (`unknown`) thread is kept: the rows' `targetThreadId` decides.
 */
export function squiresWithThreadDecisions(
  state: SquireEnvironmentState | null,
  thread: TrackableThread,
): ReadonlyArray<{ readonly squireId: SquireId; readonly name: string }> {
  return trackingCandidates(state, thread)
    .filter(
      (entry) =>
        entry.openDecisionCount > 0 &&
        squireThreadTracking(entry.squire.grants, {
          threadId: thread.id,
          projectId: thread.projectId,
        }) !== "untracked",
    )
    .map((entry) => ({ squireId: entry.squire.id, name: entry.squire.name }));
}

export function squireTrackGrant(threadId: string): SquireGrantInput {
  return { kind: "thread", targetId: threadId };
}
