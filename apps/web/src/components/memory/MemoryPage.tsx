import { EnvironmentId, ProjectId, type MemoryReceipt } from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Undo2Icon } from "lucide-react";
import { useState } from "react";
import { isElectron } from "../../env";
import {
  memoryDemoEnvironment,
  useFirstMemoryDemoEnvironmentId,
  useMemoryDemoAvailable,
  useMemoryGraph,
  useMemoryStatus,
} from "../../state/memoryDemo";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { AccountSurface } from "../AccountSurface";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ContributionGate } from "./ContributionGate";
import { MemoryMap, MemoryMapStatus } from "./MemoryMap";
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
  const litReceiptId = search.lit && /^[0-9a-f]{7}$/.test(search.lit) ? search.lit : null;
  const warrenNodes = graph.data?.territories.reduce((sum, t) => sum + t.nodeCount, 0) ?? null;
  // The lit landing stays reversible after the Gate closes; the Gate is not the only way out.
  const status = useMemoryStatus(available ? environmentId : null);
  const lastReceipt = status.data?.lastReceipt ?? null;
  const litReceipt =
    lastReceipt && lastReceipt.id === litReceiptId && !lastReceipt.reverted ? lastReceipt : null;
  const revertCommand = useAtomCommand(memoryDemoEnvironment.revert);
  const [reverting, setReverting] = useState(false);
  const revertLit = async () => {
    if (litReceipt === null || environmentId === null || reverting) return;
    setReverting(true);
    const result = await revertCommand({ environmentId, input: { receiptId: litReceipt.id } });
    setReverting(false);
    if (result._tag === "Success") closeGate(null, { dropLit: true });
  };

  // Closing the Gate returns to a clear map so the lit landing is not under a stale sheet.
  function closeGate(receipt: MemoryReceipt | null, options?: { dropLit: boolean }) {
    setSelectedNodeId(null);
    const lit = receipt?.reverted === false ? receipt.id : options?.dropLit ? null : search.lit;
    void navigate({
      to: "/memory",
      search: {
        ...(search.environmentId ? { environmentId: search.environmentId } : {}),
        ...(search.projectId ? { projectId: search.projectId } : {}),
        ...(lit ? { lit } : {}),
      },
      replace: true,
    });
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <AccountSurface className="lecturn-page-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="Memory breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Memory</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          {graph.data && warrenNodes !== null ? (
            <span className="hidden truncate text-xs text-muted-foreground tabular-nums sm:inline">
              Warren · {warrenNodes.toLocaleString("en-US")} nodes in{" "}
              {graph.data.territories.length} territories · read-only here
            </span>
          ) : null}
          {litReceipt ? (
            <Button
              variant="outline"
              size="compact"
              disabled={reverting}
              onClick={() => void revertLit()}
            >
              <Undo2Icon aria-hidden />
              Revert <span className="font-mono">{litReceipt.id}</span>
            </Button>
          ) : null}
        </WorkspacePageHeader>
        <div className="relative flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1">
            {environmentId === null || !available ? (
              <MemoryMapStatus
                title="Memory is off"
                description="No connected environment runs with Memory enabled. Start the server with LECTURN_MEMORY_DEMO=1 to turn it on."
              />
            ) : graph.data ? (
              <MemoryMap
                environmentId={environmentId}
                graph={graph.data}
                litReceiptId={litReceiptId}
                onSelectNode={setSelectedNodeId}
                focusNodeId={selectedNodeId}
              />
            ) : graph.error ? (
              <MemoryMapStatus title="The map could not load" description={graph.error} />
            ) : (
              <MemoryMapStatus title="Loading the warren" loading />
            )}
          </div>
          {available && environmentId !== null && selectedNodeId !== null ? (
            <NodeSheet
              environmentId={environmentId}
              nodeId={selectedNodeId}
              onClose={() => setSelectedNodeId(null)}
              onSelectNode={setSelectedNodeId}
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
