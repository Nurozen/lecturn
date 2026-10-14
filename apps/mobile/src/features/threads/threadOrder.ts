import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import { planPinnedMove } from "@lecturn/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@lecturn/contracts";

type OrderRow = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "pinOrderKey"
  | "activeOrderKey"
  | "createdAt"
  | "unsettledAt"
  | "pinnedAt"
>;

export interface PendingThreadOrder {
  readonly section: "pinned" | "active";
  readonly scopeProjectKeys?: readonly string[];
  readonly orderedIds: readonly string[];
  readonly before: ReadonlyMap<string, { readonly key: string | null; readonly anchor: string }>;
  readonly assignments: ReadonlyMap<string, string>;
  readonly confirmed: ReadonlySet<string>;
  readonly commandsComplete: boolean;
}

function rowId(row: OrderRow): string {
  return `${row.environmentId}:${row.id}`;
}

function rowOrder(row: OrderRow, section: PendingThreadOrder["section"]) {
  return {
    key: (section === "pinned" ? row.pinOrderKey : row.activeOrderKey) ?? null,
    anchor: section === "pinned" ? (row.pinnedAt ?? "") : (row.unsettledAt ?? row.createdAt),
  };
}

/** Keep every visible row as an anchor, but only offer plans whose key writes
 * are supported. Menu availability and execution use this same planner. */
export function createThreadMovePlanner(input: {
  readonly ordered: readonly OrderRow[];
  readonly allThreads?: readonly OrderRow[];
  readonly section: PendingThreadOrder["section"];
  readonly reorderableEnvironmentIds: ReadonlySet<EnvironmentId>;
}) {
  const orderedIds = input.ordered.map(rowId);
  const keysById = new Map(
    (input.allThreads ?? input.ordered).map((row) => [
      rowId(row),
      rowOrder(row, input.section).key,
    ]),
  );
  const writableIds = new Set(
    input.ordered
      .filter((row) => input.reorderableEnvironmentIds.has(row.environmentId))
      .map(rowId),
  );
  return (movedId: string, direction: "up" | "down") => {
    if (!writableIds.has(movedId)) return null;
    const assignments = planPinnedMove({ orderedIds, keysById, movedId, direction });
    return assignments === null ||
      assignments.length === 0 ||
      assignments.some((assignment) => !writableIds.has(assignment.id))
      ? null
      : assignments;
  };
}

export function createPendingThreadOrder(input: {
  readonly section: PendingThreadOrder["section"];
  readonly ordered: readonly OrderRow[];
  readonly movedId: string;
  readonly direction: "up" | "down";
  readonly assignments: readonly { readonly id: string; readonly orderKey: string }[];
  readonly scopeProjectKeys?: readonly string[];
}): PendingThreadOrder {
  const orderedIds = input.ordered.map(rowId);
  const from = orderedIds.indexOf(input.movedId);
  orderedIds.splice(from, 1);
  orderedIds.splice(from + (input.direction === "up" ? -1 : 1), 0, input.movedId);
  return {
    section: input.section,
    scopeProjectKeys: input.scopeProjectKeys,
    orderedIds,
    before: new Map(input.ordered.map((row) => [rowId(row), rowOrder(row, input.section)])),
    assignments: new Map(input.assignments.map(({ id, orderKey }) => [id, orderKey])),
    confirmed: new Set(),
    commandsComplete: false,
  };
}

/** Receipts and shell updates arrive independently. Only our own key writes
 * may pass through the hold; membership and other arrangement changes win. */
export function reconcilePendingThreadOrder(
  pending: PendingThreadOrder,
  ordered: readonly OrderRow[],
): PendingThreadOrder | null {
  const scope = pending.scopeProjectKeys ? new Set(pending.scopeProjectKeys) : null;
  const owning =
    scope === null
      ? ordered
      : ordered.filter((row) => scope.has(`${row.environmentId}:${row.projectId}`));
  if (owning.length !== pending.before.size) return null;
  const confirmed = new Set(pending.confirmed);
  for (const row of owning) {
    const id = rowId(row);
    const before = pending.before.get(id);
    const current = rowOrder(row, pending.section);
    if (before === undefined || current.anchor !== before.anchor) return null;
    const assigned = pending.assignments.get(id);
    if (assigned !== undefined && current.key === assigned) confirmed.add(id);
    else if (current.key !== before.key || confirmed.has(id)) return null;
  }
  if (pending.commandsComplete && confirmed.size === pending.assignments.size) return null;
  return confirmed.size === pending.confirmed.size ? pending : { ...pending, confirmed };
}

/** Apply the full section's pending order after search/environment filtering. */
export function applyPendingThreadOrder<T extends OrderRow>(
  rows: readonly T[],
  section: PendingThreadOrder["section"],
  pending: PendingThreadOrder | null | undefined,
): T[] {
  if (pending == null || pending.section !== section) return [...rows];
  const rank = new Map(pending.orderedIds.map((id, index) => [id, index]));
  const scope = pending.scopeProjectKeys ? new Set(pending.scopeProjectKeys) : null;
  const belongs = (row: T) => scope === null || scope.has(`${row.environmentId}:${row.projectId}`);
  const owning = rows
    .filter(belongs)
    .sort(
      (left, right) => (rank.get(rowId(left)) ?? Infinity) - (rank.get(rowId(right)) ?? Infinity),
    );
  let index = 0;
  return rows.map((row) => (belongs(row) ? owning[index++]! : row));
}

/** Menu planning and command execution share the full owning project group,
 * before search, pagination, collapse or environment filtering. */
export function createScopedThreadMovePlanner(input: {
  readonly ordered: readonly EnvironmentThreadShell[];
  readonly allThreads: readonly EnvironmentThreadShell[];
  readonly section: PendingThreadOrder["section"];
  readonly reorderableEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly scopes: ReadonlyMap<string, readonly string[]>;
}) {
  const byId = new Map(input.ordered.map((row) => [rowId(row), row]));
  return (movedId: string, direction: "up" | "down") => {
    const row = byId.get(movedId);
    if (!row) return null;
    const scope = input.scopes.get(`${row.environmentId}:${row.projectId}`);
    if (!scope) return null;
    const keys = new Set(scope);
    return createThreadMovePlanner({
      ...input,
      ordered: input.ordered.filter((candidate) =>
        keys.has(`${candidate.environmentId}:${candidate.projectId}`),
      ),
    })(movedId, direction);
  };
}
