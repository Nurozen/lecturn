import type { PullRequestWatch, ThreadLinkedPullRequest } from "@lecturn/contracts";
import { isRepositoryWatchManagerEligible } from "./repositoryScope.ts";

type Scope = Parameters<typeof isRepositoryWatchManagerEligible>[0];

/** A thread can participate in or explicitly manage several PRs across its checkouts. */
export function selectThreadPullRequestWatches(
  input: Omit<Scope, "watch"> & {
    readonly thread: Scope["thread"] & {
      readonly id: PullRequestWatch["threadIds"][number];
      readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
    };
    readonly watches: readonly PullRequestWatch[];
  },
): readonly PullRequestWatch[] {
  return input.watches.filter((watch) => {
    const linked = input.thread.linkedPullRequest;
    const related =
      watch.managerThreadId === input.thread.id ||
      watch.threadIds.includes(input.thread.id) ||
      (linked != null &&
        watch.reference.projectId === linked.projectId &&
        watch.reference.repository.toLowerCase() === linked.repository.toLowerCase() &&
        (watch.reference.host ?? "github.com").toLowerCase() ===
          (linked.host ?? "github.com").toLowerCase() &&
        watch.reference.number === linked.number);
    return related && isRepositoryWatchManagerEligible({ ...input, watch });
  });
}

export interface ThreadPullRequestLink {
  readonly key: string;
  readonly url: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed" | "merged" | "unknown";
  readonly isDraft: boolean;
  readonly watch?: PullRequestWatch;
}

/** Keep the durable watch observation authoritative and deduplicate transient Git badges. */
export function threadPullRequestLinks(
  watches: readonly PullRequestWatch[],
  fallback?: {
    readonly url: string;
    readonly number: number;
    readonly title?: string;
    readonly repository?: string | undefined;
    readonly state: "open" | "closed" | "merged";
    readonly isDraft?: boolean | undefined;
  } | null,
): readonly ThreadPullRequestLink[] {
  const links = new Map<string, ThreadPullRequestLink>();
  const urlKey = (url: string) => url.replace(/\/$/, "").toLowerCase();
  for (const watch of watches) {
    const url = watch.observation?.url;
    // Do not invent provider URLs before the first verified observation.
    if (!url) continue;
    links.set(urlKey(url), {
      key: urlKey(url),
      url,
      repository: watch.reference.repository,
      number: watch.reference.number,
      title: watch.observation?.title ?? `Pull request #${watch.reference.number}`,
      state: watch.observation?.state ?? "unknown",
      isDraft: false,
      watch,
    });
  }
  if (fallback && !links.has(urlKey(fallback.url))) {
    links.set(urlKey(fallback.url), {
      ...fallback,
      key: urlKey(fallback.url),
      repository: fallback.repository ?? "",
      title: fallback.title ?? `Pull request #${fallback.number}`,
      isDraft: fallback.isDraft ?? false,
    });
  }
  return [...links.values()];
}
