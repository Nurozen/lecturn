import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/models";
import {
  isListedSettledThread,
  settledShelfFrontier,
  unloadedOlderSettledCount,
  wantedOlderSettledPages,
  type OlderSettledScope,
} from "@lecturn/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { olderSettledThreads, threadFamilies } from "./threads";

const NO_PAGES: ReadonlyMap<EnvironmentId, number> = new Map();

/**
 * The Settled shelf for one scope when shells leave older settled threads out: which rows it may
 * list, how many threads it holds in all, and the pages read below each environment's cut, whose
 * rows merge into the thread list. `useOlderSettledShelfGrowth` reads the next pages.
 */
export function useOlderSettledShelf(input: {
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  /** A collapsed shelf mounts no pages, so a reconnect reads none; expanding restores them. */
  readonly expanded: boolean;
  /** Rows the shelf shows; pages are read until it lists that many. */
  readonly visibleCount: number;
  /** Segment or nested project shelves page instead, so read pages stay mounted. */
  readonly partShelves?: boolean;
}) {
  const scopeKey = JSON.stringify(input.scopes);
  const [requested, setRequested] = useState({ scopeKey, pages: NO_PAGES });
  const keepPages = input.expanded || input.partShelves === true;
  const pages = requested.scopeKey === scopeKey && keepPages ? requested.pages : NO_PAGES;
  const shelfScopes = input.scopes.map((scope) => ({
    scope,
    pages: pages.get(scope.environmentId) ?? 0,
  }));
  const shelfKey = JSON.stringify(shelfScopes);
  const shelf = useAtomValue(olderSettledThreads.shelfAtom(shelfScopes));
  useEffect(() => {
    const releases = (JSON.parse(shelfKey) as typeof shelfScopes).flatMap(({ scope, pages }) =>
      pages === 0
        ? []
        : [
            threadFamilies.mountRows(
              appAtomRegistry,
              scope.environmentId,
              olderSettledThreads.rowsKey(scope, pages),
              olderSettledThreads.pageRowsAtom(scope, pages),
            ),
          ],
    );
    return () => {
      for (const release of releases) release();
    };
  }, [shelfKey]);

  const olderOf = (environmentId: EnvironmentId) => shelf.get(environmentId)?.older ?? null;
  const pagesOf = (environmentId: EnvironmentId) => shelf.get(environmentId)?.pages;
  const frontier = settledShelfFrontier([...shelf.values()]);
  const loaded = shelfScopes.filter(({ pages }) => pages > 0);
  return {
    environments: shelf,
    visibleCount: input.expanded ? input.visibleCount : 0,
    pages,
    grow: (next: ReadonlyMap<EnvironmentId, number>) => setRequested({ scopeKey, pages: next }),
    isListed: (thread: EnvironmentThreadShell) => isListedSettledThread(thread.source, frontier),
    /** Older settled threads in scope that are not local; add it to the local Settled rows. */
    unloadedCount: (threads: ReadonlyArray<EnvironmentThreadShell>) =>
      unloadedOlderSettledCount({ olderSettled: olderOf, scopes: input.scopes, threads }),
    /** The same count for part of the scope: an account segment or a nested project's shelf. */
    unloadedCountIn: (
      scopes: ReadonlyArray<OlderSettledScope>,
      threads: ReadonlyArray<EnvironmentThreadShell>,
    ) => unloadedOlderSettledCount({ olderSettled: olderOf, scopes, threads }),
    /** Whether a page read can still add rows to these scopes. */
    canLoadIn: (scopes: ReadonlyArray<OlderSettledScope>) =>
      scopes.some(({ environmentId }) => {
        const environment = shelf.get(environmentId);
        return (
          environment?.older != null &&
          environment.pages.frontier !== null &&
          environment.pages.status !== "failed"
        );
      }),
    loading: loaded.some(({ scope }) => pagesOf(scope.environmentId)?.status === "pending"),
    failed: loaded.some(({ scope }) => pagesOf(scope.environmentId)?.status === "failed"),
    retry: () => {
      for (const { scope, pages } of loaded) {
        olderSettledThreads.retryPages(appAtomRegistry, scope, pages);
      }
    },
  };
}

/**
 * Reads the next pages while the shelf lists fewer rows than it shows, or while a segment or
 * nested project shelf (`partShelfShort`) lists fewer than it shows and its scope can load more.
 */
export function useOlderSettledShelfGrowth(
  shelf: ReturnType<typeof useOlderSettledShelf>,
  listedSettledThreads: ReadonlyArray<EnvironmentThreadShell>,
  partShelfShort = false,
) {
  const wanted = wantedOlderSettledPages({
    requested: shelf.pages,
    environments: shelf.environments,
    listedCount: listedSettledThreads.length,
    visibleCount: partShelfShort ? Number.POSITIVE_INFINITY : shelf.visibleCount,
  });
  const { grow, pages } = shelf;
  useEffect(() => {
    if (wanted !== pages) grow(wanted);
  }, [wanted, pages, grow]);
}

/**
 * Threads of these projects that this client does not hold (older settled threads), for counts
 * shown outside the shelf, such as a removal confirm.
 */
export function readUnloadedThreadCount(
  members: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): number {
  return unloadedOlderSettledCount({
    olderSettled: (environmentId) =>
      appAtomRegistry.get(olderSettledThreads.olderSettledAtom(environmentId)),
    scopes: [...new Set(members.map((member) => member.environmentId))].map((environmentId) => ({
      environmentId,
      projectIds: members.flatMap((member) =>
        member.environmentId === environmentId ? [member.id] : [],
      ),
    })),
    threads: threads.filter((thread) =>
      members.some(
        (member) => member.environmentId === thread.environmentId && member.id === thread.projectId,
      ),
    ),
  });
}
