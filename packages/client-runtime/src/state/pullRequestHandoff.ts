import type { PullRequestWatch, ThreadId } from "@lecturn/contracts";

/** A missing explicit manager must be replaced deliberately, never silently rerouted. */
export function selectMergeHandoffThread<T extends { readonly id: ThreadId }>(
  watch: Pick<PullRequestWatch, "managerThreadId" | "threadIds">,
  eligibleThreads: readonly T[],
): T | null {
  if (watch.managerThreadId)
    return eligibleThreads.find((thread) => thread.id === watch.managerThreadId) ?? null;
  const associated = eligibleThreads.filter((thread) => watch.threadIds.includes(thread.id));
  return associated.length === 1 ? associated[0]! : null;
}

/** Stable across CI/head refreshes so an ambiguous delivery can reuse its durable receipt. */
export function mergeHandoffMessage(
  watch: Pick<PullRequestWatch, "reference" | "observation">,
): string {
  const { reference } = watch;
  const repository = reference.repository.slice(0, 500);
  const url = (
    watch.observation?.url ??
    `https://${reference.host ?? "github.com"}/${reference.repository}/pull/${reference.number}`
  ).slice(0, 2000);
  return [
    `Please manage ${repository} #${reference.number} and merge it when ready.`,
    `Pull request: ${url}`,
    "Watch its CI and reviews. Wait for required checks and repository merge rules to pass on the latest revision; do not bypass protections.",
    "Investigate failures and make appropriate fixes. Report blockers or decisions that need my input. When ready, merge using the repository's appropriate merge method and confirm the result here.",
  ].join("\n");
}
