import { scopedThreadKey, scopeThreadRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/models";

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
