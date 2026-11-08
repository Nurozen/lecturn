import { scopedThreadKey, scopeThreadRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/models";
import {
  isListedSettledThread,
  settledShelfFrontier,
  wantedOlderSettledPages,
  type OlderSettledScope,
  type OlderSettledShelfEnvironment,
} from "@lecturn/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@lecturn/contracts";

/** A route opens its settled shelf by default; an explicit collapse still wins. */
export function projectSettledPage<T extends Pick<EnvironmentThreadShell, "id" | "environmentId">>(
  rows: readonly T[],
  preference: { expanded: boolean; limit: number } | undefined,
  routeThreadKey: string | null,
  initialLimit: number,
) {
  const routeRow = rows.find(
    (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
  );
  const expanded = preference?.expanded ?? routeRow !== undefined;
  const limit = preference?.limit ?? initialLimit;
  const visible = expanded ? rows.slice(0, limit) : [];
  // Keep a deep-linked conversation visible without rendering the whole history.
  if (expanded && routeRow && !visible.includes(routeRow)) visible.push(routeRow);
  return { expanded, limit, total: rows.length, visible, hidden: rows.length - visible.length };
}

/** Adds older settled threads the shell left out to a shelf page's counts; "Show more" reads them. */
export function withUnloadedSettled<Page extends { total: number; hidden: number }>(
  page: Page,
  unloaded: number,
): Page {
  return unloaded === 0
    ? page
    : { ...page, total: page.total + unloaded, hidden: page.hidden + unloaded };
}

/** A nested project's members as older-settled scopes, one per environment. */
export function projectOlderSettledScopes(
  refs: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly projectId: ProjectId }>,
): ReadonlyArray<OlderSettledScope> {
  return [...new Set(refs.map((ref) => ref.environmentId))].map((environmentId) => ({
    environmentId,
    projectIds: refs.flatMap((ref) => (ref.environmentId === environmentId ? [ref.projectId] : [])),
  }));
}

type ShelfEnvironments = ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment>;

const environmentsIn = (environments: ShelfEnvironments, environmentIds: Iterable<EnvironmentId>) =>
  new Map(
    [...new Set(environmentIds)].flatMap((environmentId) => {
      const environment = environments.get(environmentId);
      return environment === undefined ? [] : [[environmentId, environment] as const];
    }),
  );

/**
 * Settled rows an account segment or nested project lists: each row against the frontier of its
 * own part's environments only, so a busier environment elsewhere never hides a quieter one's rows.
 */
export function listSettledInParts<
  T extends { readonly source: Parameters<typeof isListedSettledThread>[0] },
>(
  threads: ReadonlyArray<T>,
  environments: ShelfEnvironments,
  partEnvironmentsOf: (thread: T) => ReadonlyArray<EnvironmentId>,
): T[] {
  const listedIn = new Map<string, (thread: T) => boolean>();
  return threads.filter((thread) => {
    const environmentIds = partEnvironmentsOf(thread);
    const key = [...environmentIds].sort().join("\0");
    let listed = listedIn.get(key);
    if (listed === undefined) {
      const frontier = settledShelfFrontier([
        ...environmentsIn(environments, environmentIds).values(),
      ]);
      listed = (row) => isListedSettledThread(row.source, frontier);
      listedIn.set(key, listed);
    }
    return listed(thread);
  });
}

/** An account segment's or nested project's Settled shelf, over its own environments. */
export interface SettledShelfPart {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly expanded: boolean;
  readonly listed: number;
  readonly limit: number;
  /** Older settled threads in the part that the client does not hold. */
  readonly unloaded: number;
}

/**
 * The pages to read for segment or nested project shelves: an open shelf that lists fewer rows
 * than it shows, while its part has older threads unread, reads one more page of each of its own
 * environments at its own frontier. Other environments read nothing for it, and an environment
 * stops at its end.
 */
export function wantedPartSettledPages(input: {
  readonly requested: ReadonlyMap<EnvironmentId, number>;
  readonly environments: ShelfEnvironments;
  readonly parts: ReadonlyArray<SettledShelfPart>;
}): ReadonlyMap<EnvironmentId, number> {
  let next: Map<EnvironmentId, number> | null = null;
  for (const part of input.parts) {
    if (!part.expanded || part.listed >= part.limit || part.unloaded <= 0) continue;
    const wanted = wantedOlderSettledPages({
      requested: input.requested,
      environments: environmentsIn(input.environments, part.environmentIds),
      listedCount: part.listed,
      visibleCount: part.limit,
    });
    for (const [environmentId, pages] of wanted) {
      if (pages <= ((next ?? input.requested).get(environmentId) ?? 0)) continue;
      next ??= new Map(input.requested);
      next.set(environmentId, pages);
    }
  }
  return next ?? input.requested;
}
