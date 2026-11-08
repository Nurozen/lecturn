import { scopedThreadKey, scopeThreadRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/models";
import {
  isListedSettledThread,
  settledShelfFrontier,
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

/**
 * Settled rows an account segment or nested project lists: each row against its own
 * environment's frontier only, so a busier environment never hides a quieter one's loaded rows.
 * A merged list over several environments can show a quiet environment's older row before the
 * busier one's next page loads; the order fills in as pages arrive.
 */
export function listSettledByOwnEnvironment<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly source: Parameters<typeof isListedSettledThread>[0];
  },
>(threads: ReadonlyArray<T>, environments: ShelfEnvironments): T[] {
  const frontiers = new Map<EnvironmentId, ReturnType<typeof settledShelfFrontier>>();
  return threads.filter((thread) => {
    let frontier = frontiers.get(thread.environmentId);
    if (frontier === undefined) {
      const environment = environments.get(thread.environmentId);
      frontier = environment === undefined ? null : settledShelfFrontier([environment]);
      frontiers.set(thread.environmentId, frontier);
    }
    return isListedSettledThread(thread.source, frontier);
  });
}

/** An account segment's or nested project's Settled shelf, over its own environments. */
export interface SettledShelfPart {
  readonly expanded: boolean;
  readonly listed: number;
  readonly limit: number;
  /** Per environment of the part: its older settled threads that the client does not hold. */
  readonly unloaded: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly count: number;
  }>;
}

/**
 * The pages to read for segment or nested project shelves: an open shelf that lists fewer rows
 * than it shows reads one more page of each of its environments that still has older threads
 * unread for it. Other environments read nothing for it; an environment reads one page at a time
 * and stops at its end or a failed read.
 */
export function wantedPartSettledPages(input: {
  readonly requested: ReadonlyMap<EnvironmentId, number>;
  readonly environments: ShelfEnvironments;
  readonly parts: ReadonlyArray<SettledShelfPart>;
}): ReadonlyMap<EnvironmentId, number> {
  let next: Map<EnvironmentId, number> | null = null;
  for (const part of input.parts) {
    if (!part.expanded || part.listed >= part.limit) continue;
    for (const { environmentId, count } of part.unloaded) {
      const environment = input.environments.get(environmentId);
      if (
        count <= 0 ||
        environment?.older == null ||
        environment.pages.status !== "ready" ||
        environment.pages.frontier === null
      ) {
        continue;
      }
      const pages = (input.requested.get(environmentId) ?? 0) + 1;
      if (pages <= ((next ?? input.requested).get(environmentId) ?? 0)) continue;
      next ??= new Map(input.requested);
      next.set(environmentId, pages);
    }
  }
  return next ?? input.requested;
}
