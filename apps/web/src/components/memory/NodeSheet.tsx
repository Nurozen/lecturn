import type {
  EnvironmentId,
  MemoryDuplicateJudgment,
  MemoryJudgments,
  MemoryNodeDetail,
  MemoryStandardJudgment,
  MemoryStandardVerdict,
} from "@lecturn/contracts";
import { FileCodeIcon, LockIcon, SproutIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { useMemoryNode } from "../../state/memoryDemo";
import { Badge } from "../ui/badge";
import { Sheet, SheetDescription, SheetPanel, SheetPopup, SheetTitle } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import { MemoryTypeGlyph } from "./MemoryMap";

export interface NodeSheetProps {
  readonly environmentId: EnvironmentId;
  readonly nodeId: string;
  readonly onClose: () => void;
  /** Opens a neighbor in the sheet (and the map lens). */
  readonly onSelectNode?: (nodeId: string) => void;
}

/** Side sheet with one node's detail (memory.node). Non-modal so the map
    stays interactive; Esc inside the sheet closes it. */
export function NodeSheet({ environmentId, nodeId, onClose, onSelectNode }: NodeSheetProps) {
  const node = useMemoryNode(environmentId, nodeId);
  const detail = node.data?.id === nodeId ? node.data : null;
  return (
    <Sheet
      open
      modal={false}
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetPopup
        side="right"
        variant="inset"
        initialFocus={false}
        finalFocus={false}
        backdropClassName="hidden"
        viewportClassName="pointer-events-none"
        className="pointer-events-auto max-w-sm"
        aria-label="Node detail"
      >
        {detail ? (
          <NodeDetail detail={detail} onSelectNode={onSelectNode} />
        ) : node.error ? (
          <div className="flex flex-col gap-2 p-6 pr-12">
            <SheetTitle className="font-display text-lg font-normal">
              Node could not load
            </SheetTitle>
            <SheetDescription>{node.error}</SheetDescription>
          </div>
        ) : (
          <NodeSkeleton nodeId={nodeId} />
        )}
      </SheetPopup>
    </Sheet>
  );
}

function NodeDetail({
  detail,
  onSelectNode,
}: {
  readonly detail: MemoryNodeDetail;
  readonly onSelectNode: ((nodeId: string) => void) | undefined;
}) {
  const warren = detail.scope === "warren";
  return (
    <SheetPanel className="p-0!" scrollFade>
      <Section className="pt-5 pr-12">
        <div className="flex min-w-0 items-center gap-2 text-[11px]">
          <MemoryTypeGlyph type={detail.type} className="size-3" />
          <span className="font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            {detail.type}
          </span>
          <span className="truncate font-mono text-muted-foreground">
            {detail.scope} / {detail.territoryId}
          </span>
        </div>
        <SheetTitle className="mt-2 font-display text-xl leading-tight font-normal tracking-tight break-words">
          {detail.id}
        </SheetTitle>
        <SheetDescription className="mt-2 text-[13px] leading-relaxed text-foreground">
          {detail.summary}
        </SheetDescription>
        {warren ? (
          <Note icon={<LockIcon />}>
            <b className="font-semibold text-foreground">Read-only here.</b> This node lives in the
            warren. It changes only through a contribution when a space closes.
          </Note>
        ) : (
          <Note icon={<SproutIcon />} tone="primary">
            <b className="font-semibold text-foreground">In a den.</b> Agents can still edit it. It
            reaches the warren through the Contribution Gate.
          </Note>
        )}
        {detail.landedReceiptId ? (
          <div className="mt-3">
            <Badge variant="outline" className="font-mono">
              landed {detail.landedReceiptId}
            </Badge>
          </div>
        ) : null}
      </Section>

      {detail.context ? (
        <Section title="Context">
          <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background/60 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
            {detail.context}
          </pre>
        </Section>
      ) : null}

      <Section title="Tags">
        <div className="flex flex-wrap gap-1.5">
          <Chip>{detail.type}</Chip>
          <Chip>{detail.scope}</Chip>
          {detail.tags.map((tag) => (
            <Chip key={tag}>{tag}</Chip>
          ))}
        </div>
      </Section>

      {detail.sourcePath ? (
        <Section title="Source">
          <div className="flex items-start gap-2 font-mono text-[11.5px] break-all text-foreground">
            <FileCodeIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            {detail.sourcePath}
          </div>
        </Section>
      ) : null}

      {detail.judgments ? <Judgments judgments={detail.judgments} /> : null}

      <Section title={`Neighbors, ${detail.neighbors.length}`} last>
        {detail.neighbors.length === 0 ? (
          <p className="text-xs text-muted-foreground">No edges yet.</p>
        ) : (
          <ul className="-mx-2 m-0 list-none p-0">
            {detail.neighbors.map((neighbor) => (
              <li key={neighbor.id}>
                <button
                  type="button"
                  disabled={!onSelectNode}
                  onClick={() => onSelectNode?.(neighbor.id)}
                  className="flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:hover:bg-transparent"
                >
                  <span className="truncate font-mono text-xs text-foreground">{neighbor.id}</span>
                  <span className="truncate text-xs text-muted-foreground">{neighbor.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </SheetPanel>
  );
}

const VERDICT_CLASS: Record<MemoryStandardVerdict | "none", string> = {
  pass: "border-success/30 bg-success/8 text-success-foreground dark:bg-success/16",
  uncertain: "border-warning/30 bg-warning/8 text-warning-foreground dark:bg-warning/16",
  fail: "border-destructive/30 bg-destructive/8 text-destructive-foreground dark:bg-destructive/16",
  none: "border-border bg-secondary text-foreground",
};

function Judgments({ judgments }: { readonly judgments: MemoryJudgments }) {
  const caption =
    judgments.method === "recorded-jev"
      ? `recorded Jev judgments, ${judgments.model ?? "jev"}, synthetic spike data`
      : "heuristic";
  return (
    <Section title="Judgments">
      <p className="-mt-1 mb-2.5 text-[11px] text-muted-foreground">{caption}</p>
      {judgments.standards.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {judgments.standards.map((standard) => (
            <li
              key={standard.id}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2 py-1 text-xs",
                VERDICT_CLASS["verdict" in standard ? standard.verdict : "none"],
              )}
            >
              <span className="shrink-0 font-mono text-[10.5px] opacity-80">{standard.id}</span>
              <span className="min-w-0 flex-1 leading-snug">{standard.title}</span>
              <span className="shrink-0 font-mono tabular-nums">{judgmentValue(standard)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {judgments.duplicate ? <DuplicateBar duplicate={judgments.duplicate} /> : null}
    </Section>
  );
}

function judgmentValue(standard: MemoryStandardJudgment): string {
  switch (standard.kind) {
    case "noul":
      return `${standard.p.toFixed(2)} · ${standard.verdict}`;
    case "score":
      return `${standard.score.toFixed(1)} · ${standard.verdict}`;
    case "choice":
      return `${standard.choice} ${Math.round(standard.confidence * 100)}%`;
  }
}

const DUPLICATE_SEGMENTS = [
  ["different", "bg-muted-foreground/35"],
  ["related", "bg-warning/70"],
  ["same", "bg-destructive/70"],
] as const;

/** Three-segment bar of the duplicate probabilities against the closest node. */
function DuplicateBar({ duplicate }: { readonly duplicate: MemoryDuplicateJudgment }) {
  const total =
    duplicate.probabilities.different +
      duplicate.probabilities.related +
      duplicate.probabilities.same || 1;
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          Duplicate of <span className="font-mono text-foreground">{duplicate.targetId}</span>
        </span>
        <span className="shrink-0 font-medium">{duplicate.level}</span>
      </div>
      <div
        className="flex h-2 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`different ${pct(duplicate.probabilities.different)}, related ${pct(duplicate.probabilities.related)}, same ${pct(duplicate.probabilities.same)}`}
      >
        {DUPLICATE_SEGMENTS.map(([key, color]) => (
          <span
            key={key}
            className={color}
            style={{ width: `${(duplicate.probabilities[key] / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[10.5px] text-muted-foreground tabular-nums">
        {DUPLICATE_SEGMENTS.map(([key]) => (
          <span
            key={key}
            className={cn(duplicate.level === key && "font-semibold text-foreground")}
          >
            {key} {duplicate.probabilities[key].toFixed(2)}
          </span>
        ))}
      </div>
    </div>
  );
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

function Section({
  title,
  last = false,
  className,
  children,
}: {
  readonly title?: string;
  readonly last?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={cn("px-5 py-4", !last && "border-b border-border/70", className)}>
      {title ? (
        <h3 className="mb-2 text-[10.5px] font-semibold tracking-[0.09em] text-muted-foreground uppercase">
          {title}
        </h3>
      ) : null}
      {children}
    </section>
  );
}

function Note({
  icon,
  tone = "muted",
  children,
}: {
  readonly icon: ReactNode;
  readonly tone?: "muted" | "primary";
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mt-3 flex gap-2.5 rounded-md border px-3 py-2 text-xs leading-relaxed text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0",
        tone === "primary" ? "border-primary/30 bg-primary/6" : "border-border bg-muted/60",
      )}
    >
      {icon}
      <div>{children}</div>
    </div>
  );
}

function Chip({ children }: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex h-5.5 items-center rounded-full border border-border bg-secondary px-2 text-[11.5px] text-foreground">
      {children}
    </span>
  );
}

function NodeSkeleton({ nodeId }: { readonly nodeId: string }) {
  return (
    <div className="flex flex-col gap-3 p-5 pr-12" aria-busy>
      <SheetTitle className="truncate font-display text-xl font-normal">{nodeId}</SheetTitle>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="mt-3 h-20 w-full" />
    </div>
  );
}
