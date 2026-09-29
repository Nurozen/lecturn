import { EnvironmentId, ProjectId, type MemoryReceipt } from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { isElectron } from "../../env";
import {
  useFirstMemoryDemoEnvironmentId,
  useMemoryDemoAvailable,
  useMemoryGraph,
} from "../../state/memoryDemo";
import { AccountSurface } from "../AccountSurface";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ContributionGate } from "./ContributionGate";
import { MemoryMap } from "./MemoryMap";
import { NodeSheet } from "./NodeSheet";

/** `/memory` search params. `gate=1` opens the Contribution Gate for `projectId`;
    `lit` is the receipt id whose landed nodes the map highlights. */
export interface MemorySearch {
  readonly environmentId?: string;
  readonly projectId?: string;
  readonly gate?: "1";
  readonly lit?: string;
}

/** The Memory page: warren map, node sheet, and the Gate slot. Picks the first
    environment with the memory demo when `environmentId` is absent. */
export function MemoryPage({ search }: { search: MemorySearch }) {
  const navigate = useNavigate();
  const fallbackEnvironmentId = useFirstMemoryDemoEnvironmentId();
  const environmentId = search.environmentId
    ? EnvironmentId.make(search.environmentId)
    : fallbackEnvironmentId;
  const available = useMemoryDemoAvailable(environmentId);
  const graph = useMemoryGraph(available ? environmentId : null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const projectId = search.projectId ? ProjectId.make(search.projectId) : null;

  const closeGate = (receipt: MemoryReceipt | null) =>
    void navigate({
      to: "/memory",
      search: {
        ...(search.environmentId ? { environmentId: search.environmentId } : {}),
        ...(search.projectId ? { projectId: search.projectId } : {}),
        ...(receipt ? { lit: receipt.id } : search.lit ? { lit: search.lit } : {}),
      },
      replace: true,
    });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <AccountSurface className="lecturn-page-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="text-sm font-medium">Memory</span>
        </WorkspacePageHeader>
        <div className="relative flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1">
            {environmentId === null || !available ? (
              <p className="p-6 text-sm text-muted-foreground">
                Memory is not enabled on any connected environment.
              </p>
            ) : graph.data ? (
              <MemoryMap
                environmentId={environmentId}
                graph={graph.data}
                litReceiptId={search.lit ?? null}
                onSelectNode={setSelectedNodeId}
              />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">{graph.error ?? "Loading map"}</p>
            )}
          </div>
          {available && environmentId !== null && selectedNodeId !== null ? (
            <NodeSheet
              environmentId={environmentId}
              nodeId={selectedNodeId}
              onClose={() => setSelectedNodeId(null)}
            />
          ) : null}
          {available && environmentId !== null && projectId !== null && search.gate === "1" ? (
            <ContributionGate
              environmentId={environmentId}
              projectId={projectId}
              onClose={closeGate}
            />
          ) : null}
        </div>
      </AccountSurface>
    </SidebarInset>
  );
}
