import type { EnvironmentId, SquireId, SquireThreadMarker } from "@lecturn/contracts";

/**
 * A marked home thread opens as its Squire view, so "Sent by another agent" links and old
 * thread links land there. Probes and ordinary threads stay on the thread route.
 */
export function squireViewForThread(
  environmentId: EnvironmentId,
  shell: { readonly squire?: SquireThreadMarker | undefined } | null,
): { readonly environmentId: EnvironmentId; readonly squireId: SquireId } | null {
  if (shell?.squire?.role !== "home") return null;
  return { environmentId, squireId: shell.squire.squireId };
}
