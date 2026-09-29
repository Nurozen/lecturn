import type { EnvironmentId, MemoryGraph, MemoryReceiptId } from "@lecturn/contracts";

export interface MemoryMapProps {
  readonly environmentId: EnvironmentId;
  readonly graph: MemoryGraph;
  /** Receipt whose landed nodes get the static ring; from the `lit` search param. */
  readonly litReceiptId: MemoryReceiptId | null;
  readonly onSelectNode: (nodeId: string) => void;
}

/** Canvas map of the warren. Placeholder until package C lands. */
export function MemoryMap({ graph }: MemoryMapProps) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      MemoryMap: {graph.territories.length} territories, {graph.nodes.length} nodes
    </div>
  );
}
