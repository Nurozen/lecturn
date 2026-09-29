import type { EnvironmentId, MemoryReceipt, ProjectId } from "@lecturn/contracts";

export interface ContributionGateProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Called with the receipt after a land, or null when dismissed without landing. */
  readonly onClose: (receipt: MemoryReceipt | null) => void;
}

/** Review dialog that plans, judges and lands a project's den. Placeholder until package D lands. */
export function ContributionGate({ projectId, onClose }: ContributionGateProps) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/80">
      <div className="rounded-lg border border-border bg-popover p-6 text-sm">
        <p>ContributionGate: {projectId}</p>
        <button type="button" className="mt-3 text-muted-foreground" onClick={() => onClose(null)}>
          Close
        </button>
      </div>
    </div>
  );
}
