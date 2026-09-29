import type { MemoryDenNode, ScopedThreadRef } from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BrainIcon, MapIcon, SearchIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { useThreadShell } from "../../state/entities";
import {
  memoryDemoEnvironment,
  useMemoryDemoAvailable,
  useMemoryDen,
} from "../../state/memoryDemo";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { nextSimulatedMemoryWrite } from "./simulatedWrites";

export interface MemoryPanelProps {
  readonly threadRef: ScopedThreadRef;
}

// A newly arrived row fades and rises once via @starting-style; nothing loops.
const ENTER_CLASS =
  "motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-out motion-safe:starting:translate-y-1 motion-safe:starting:opacity-0";

const newestFirst = (a: MemoryDenNode, b: MemoryDenNode) => b.createdAt.localeCompare(a.createdAt);

/** Right-panel surface: the thread's project den plus recent recall. */
export function MemoryPanel({ threadRef }: MemoryPanelProps) {
  const navigate = useNavigate();
  const { environmentId } = threadRef;
  const projectId = useThreadShell(threadRef)?.projectId ?? null;
  const available = useMemoryDemoAvailable(environmentId);
  const den = useMemoryDen(available ? environmentId : null, projectId);
  const write = useAtomCommand(memoryDemoEnvironment.write);
  const removeDenNode = useAtomCommand(memoryDemoEnvironment.removeDenNode);
  const [simulating, setSimulating] = useState(false);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  // Ids present when the den first loaded; anything not in it arrived live.
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
  if (baseline === null && den.data) setBaseline(new Set(den.data.nodes.map((node) => node.id)));

  const nodes = useMemo(() => [...(den.data?.nodes ?? [])].sort(newestFirst), [den.data]);
  const recentQueries = den.data?.recentQueries ?? [];

  if (!available || projectId === null) {
    return (
      <div className="p-5 text-sm text-muted-foreground">
        {available
          ? "Memory needs a thread that belongs to a project."
          : "Memory is not enabled on this environment."}
      </div>
    );
  }

  const openMemory = (gate: boolean) =>
    void navigate({
      to: "/memory",
      search: { environmentId, projectId, ...(gate ? { gate: "1" as const } : {}) },
    });
  const simulate = async () => {
    setSimulating(true);
    await write({ environmentId, input: nextSimulatedMemoryWrite(projectId) });
    setSimulating(false);
  };
  const remove = async (nodeId: string) => {
    setRemoving((current) => new Set(current).add(nodeId));
    await removeDenNode({ environmentId, input: { projectId, nodeId } });
    setRemoving((current) => {
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Memory">
      <div className="flex flex-col gap-3 border-b border-border/50 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <BrainIcon className="size-4 text-primary" />
          <span className="truncate">{den.data?.name ?? "Den"}</span>
          <span className="ml-auto text-xs font-normal text-muted-foreground">Den</span>
        </div>
        <div>
          <div className="text-4xl font-semibold leading-none tabular-nums" aria-live="polite">
            {den.data ? den.data.nodes.length : "–"}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">nodes waiting for review</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="xs" variant="glass" onClick={() => openMemory(false)}>
            <MapIcon />
            Open in Memory
          </Button>
          <Button size="xs" onClick={() => openMemory(true)}>
            Close and contribute
          </Button>
          <Button size="xs" variant="ghost" disabled={simulating} onClick={() => void simulate()}>
            <SparklesIcon />
            {simulating ? "Writing…" : "Simulate agent write"}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {den.error ? (
          <div role="alert" className="lecturn-panel-tile mb-3 p-3 text-sm">
            {den.error}
            <Button size="xs" variant="ghost" onClick={den.refresh}>
              Try again
            </Button>
          </div>
        ) : null}
        <h3 className="px-2 pb-2 pt-1 text-xs font-medium text-muted-foreground">Recent writes</h3>
        {den.isPending && !den.data ? (
          <p role="status" className="px-2 pb-4 text-sm text-muted-foreground">
            Loading den…
          </p>
        ) : nodes.length === 0 ? (
          <p className="px-2 pb-4 text-sm text-muted-foreground">
            Nothing recorded yet. Agents add facts with memory_write.
          </p>
        ) : (
          <div className="mb-4 flex flex-col gap-2" role="list" aria-label="Recent writes">
            {nodes.map((node) => (
              <article
                key={node.id}
                role="listitem"
                className={`lecturn-panel-tile group p-3 ${baseline !== null && !baseline.has(node.id) ? ENTER_CLASS : ""}`}
              >
                <div className="flex items-start gap-2">
                  <p className="line-clamp-3 min-w-0 flex-1 text-sm leading-relaxed">
                    {node.summary}
                  </p>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Remove ${node.id}`}
                          disabled={removing.has(node.id)}
                          onClick={() => void remove(node.id)}
                        />
                      }
                    >
                      <Trash2Icon />
                    </TooltipTrigger>
                    <TooltipPopup>Remove from den</TooltipPopup>
                  </Tooltip>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{node.type}</span>
                  <Badge size="sm" variant={node.origin === "agent" ? "info" : "secondary"}>
                    {node.origin}
                  </Badge>
                  <Badge
                    size="sm"
                    variant={node.judgments.method === "recorded-jev" ? "success" : "outline"}
                  >
                    {node.judgments.method === "recorded-jev" ? "recorded Jev" : "heuristic"}
                  </Badge>
                  <span className="ml-auto">{formatRelativeTimeLabel(node.createdAt)}</span>
                </div>
              </article>
            ))}
          </div>
        )}
        <h3 className="px-2 pb-2 pt-1 text-xs font-medium text-muted-foreground">Recall hits</h3>
        {recentQueries.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">
            No recall yet. Agents search with memory_query.
          </p>
        ) : (
          <div className="flex flex-col gap-2" role="list" aria-label="Recall hits">
            {recentQueries.map((query) => (
              <div
                key={`${query.at}:${query.text}`}
                role="listitem"
                className="lecturn-panel-tile flex items-center gap-2 px-3 py-2 text-sm"
              >
                <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{query.text}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {query.hitCount} {query.hitCount === 1 ? "hit" : "hits"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
