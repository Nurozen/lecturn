import { scopedThreadKey, scopeThreadRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/models";
import type { OlderSettledScope } from "@lecturn/client-runtime/state/threads";
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

/**
 * Whether an account segment or nested project shelf shows more rows than it lists while older
 * threads in its scope can still be read, so the sidebar reads the next older pages.
 */
export function partSettledShelfShort(
  shelves: ReadonlyArray<{
    readonly expanded: boolean;
    readonly listed: number;
    readonly limit: number;
    readonly unloaded: number;
    readonly canLoad: boolean;
  }>,
): boolean {
  return shelves.some(
    (shelf) => shelf.expanded && shelf.listed < shelf.limit && shelf.unloaded > 0 && shelf.canLoad,
  );
}
