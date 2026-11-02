import { SQUIRE_QUEUE_CHIPS, type SquireQueueChip } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireCardId, SquireId, SquireThreadMarker } from "@lecturn/contracts";

export interface SquireViewSearch {
  /** The expanded or selected item. */
  readonly item?: SquireCardId;
  /** The queue's type filter chip; absent is "all". */
  readonly filter?: Exclude<SquireQueueChip, "all">;
  /** The Lead view's team-strip filter. */
  readonly squire?: SquireId;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

export function parseSquireViewSearch(search: Record<string, unknown>): SquireViewSearch {
  const filter = SQUIRE_QUEUE_CHIPS.find(
    ({ chip }) => chip !== "all" && chip === search.filter,
  )?.chip;
  return {
    ...(nonEmpty(search.item) ? { item: search.item as SquireCardId } : {}),
    ...(filter === undefined || filter === "all" ? {} : { filter }),
    ...(nonEmpty(search.squire) ? { squire: search.squire as SquireId } : {}),
  };
}

/**
 * D63: a marked home thread opens as its Squire view, so "Sent by another agent" links and old
 * thread links land there. Probes and ordinary threads stay on the thread route.
 */
export function squireViewForThread(
  environmentId: EnvironmentId,
  shell: { readonly squire?: SquireThreadMarker | undefined } | null,
): { readonly environmentId: EnvironmentId; readonly squireId: SquireId } | null {
  if (shell?.squire?.role !== "home") return null;
  return { environmentId, squireId: shell.squire.squireId };
}
