import type { EnvironmentId } from "@lecturn/contracts";

export interface NodeSheetProps {
  readonly environmentId: EnvironmentId;
  readonly nodeId: string;
  readonly onClose: () => void;
}

/** Side sheet with one node's detail (memory.node). Placeholder until package C lands. */
export function NodeSheet({ nodeId, onClose }: NodeSheetProps) {
  return (
    <aside className="w-80 shrink-0 border-l border-border p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">NodeSheet: {nodeId}</span>
        <button type="button" className="text-muted-foreground" onClick={onClose}>
          Close
        </button>
      </div>
    </aside>
  );
}
