import type { PullRequestWatch, PullRequestWatchMergeMode } from "@lecturn/contracts";

/** A native confirmation sheet must not authorize a target changed behind it. */
export function mergeConfirmationTarget(watch: PullRequestWatch, mode: PullRequestWatchMergeMode) {
  const observation = watch.observation;
  if (!observation || observation.state !== "open") return null;
  if (!observation.headRevision || !observation.supportsRevisionMerge) return null;
  return {
    watchId: watch.id,
    binding: watch.binding,
    revision: watch.revision,
    baseBranch: observation.baseBranch,
    headRevision: observation.headRevision,
    mode,
  };
}

export function matchesMergeConfirmation(
  target: NonNullable<ReturnType<typeof mergeConfirmationTarget>>,
  watch: PullRequestWatch | undefined,
) {
  if (!watch) return false;
  const current = mergeConfirmationTarget(watch, target.mode);
  return (
    current !== null &&
    current.watchId === target.watchId &&
    current.binding === target.binding &&
    current.revision === target.revision &&
    current.baseBranch === target.baseBranch &&
    current.headRevision === target.headRevision
  );
}
