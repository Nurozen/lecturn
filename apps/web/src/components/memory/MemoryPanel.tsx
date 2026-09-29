import type { ScopedThreadRef } from "@lecturn/contracts";

export interface MemoryPanelProps {
  readonly threadRef: ScopedThreadRef;
}

/** Right-panel surface: the thread's project den plus recent recall. Placeholder until package B lands. */
export function MemoryPanel({ threadRef }: MemoryPanelProps) {
  return <div className="p-4 text-sm text-muted-foreground">MemoryPanel: {threadRef.threadId}</div>;
}
