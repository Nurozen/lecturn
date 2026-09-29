import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MemoryGraph,
  MemoryNodeType,
  MemoryReceiptId,
} from "@lecturn/contracts";
import { ChevronRightIcon, EyeIcon, ListIcon, NetworkIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "~/lib/utils";
import { memoryDemoEnvironment } from "../../state/memoryDemo";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/spinner";
import {
  MAX_EDGES,
  MAX_MARKS,
  TERRITORIES_VIEW,
  buildScene,
  formatCount,
  formatTokens,
  lensViewFor,
  parentView,
  revealFlags,
  revealFromResult,
  viewDepth,
  viewKey,
  type MapMark,
  type MapReveal,
  type MapView,
} from "./memoryMapMarks";
import { HOLLOW_TYPES, MEMORY_TYPE_COLORS, MemoryMapRenderer } from "./memoryMapRenderer";

export interface MemoryMapProps {
  readonly environmentId: EnvironmentId;
  readonly graph: MemoryGraph;
  /** Receipt whose landed nodes get the static ring; from the `lit` search param. */
  readonly litReceiptId: MemoryReceiptId | null;
  readonly onSelectNode: (nodeId: string) => void;
  /** Node shown in the node sheet. The map follows it into the lens and keeps
      its overlays clear of the sheet. */
  readonly focusNodeId?: string | null;
}

type RevealStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "none"; readonly query: string }
  | { readonly kind: "error"; readonly message: string };

const TYPE_ORDER: ReadonlyArray<MemoryNodeType> = [
  "function",
  "module",
  "class",
  "interface",
  "concept",
  "decision",
  "reference",
  "composite",
];

const GLASS = "surface-glass rounded-lg border border-border/80 shadow-sm";
/** Right edge the node sheet covers (inset sheet, max-w-sm plus padding). */
const SHEET_OFFSET_PX = 400;

/**
 * Canvas map of the warren: territories, one territory, or a node lens.
 * Draws on demand only; the readout proves it by counting frames.
 */
export function MemoryMap({
  environmentId,
  graph,
  litReceiptId,
  onSelectNode,
  focusNodeId = null,
}: MemoryMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const marksRef = useRef<HTMLElement>(null);
  const edgesRef = useRef<HTMLElement>(null);
  const framesRef = useRef<HTMLElement>(null);
  const stateRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MemoryMapRenderer | null>(null);
  const lastViewKeyRef = useRef<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const queryTokenRef = useRef(0);

  const [nav, setNav] = useState<{ view: MapView; direction: -1 | 1 }>({
    view: TERRITORIES_VIEW,
    direction: 1,
  });
  const [reveal, setReveal] = useState<MapReveal | null>(null);
  const [revealStatus, setRevealStatus] = useState<RevealStatus>({ kind: "idle" });
  const [query, setQuery] = useState("");
  const [outlineOpen, setOutlineOpen] = useState(false);
  const runQuery = useAtomCommand(memoryDemoEnvironment.query, { reportFailure: false });

  const navigate = useCallback((next: MapView) => {
    setNav((previous) => ({
      view: next,
      direction: viewDepth(next) < viewDepth(previous.view) ? -1 : 1,
    }));
  }, []);

  // The node sheet can move focus (neighbor links); follow it into the lens.
  const [followed, setFollowed] = useState(focusNodeId);
  if (focusNodeId !== followed) {
    setFollowed(focusNodeId);
    const next = focusNodeId === null ? null : lensViewFor(graph, focusNodeId);
    if (next && viewKey(next) !== viewKey(nav.view)) setNav({ view: next, direction: 1 });
  }

  const scene = useMemo(
    () => buildScene(graph, nav.view, { litReceiptId, pinned: reveal?.lit }),
    [graph, nav.view, litReceiptId, reveal],
  );
  const flags = useMemo(() => revealFlags(scene, reveal), [scene, reveal]);
  const sceneRef = useRef(scene);
  useLayoutEffect(() => {
    sceneRef.current = scene;
  }, [scene]);

  // Renderer lifetime follows the canvas, which stays mounted.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const renderer = new MemoryMapRenderer(canvas, {
      marks: marksRef.current,
      edges: edgesRef.current,
      frames: framesRef.current,
      state: stateRef.current,
    });
    rendererRef.current = renderer;
    const rect = wrap.getBoundingClientRect();
    renderer.resize(rect.width, rect.height);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) renderer.resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(wrap);
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const r = canvas.getBoundingClientRect();
      renderer.zoomAt(event.clientX - r.left, event.clientY - r.top, event.deltaY);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      observer.disconnect();
      renderer.destroy();
      rendererRef.current = null;
      lastViewKeyRef.current = null;
    };
  }, []);

  const sheetOpen = focusNodeId !== null;
  useLayoutEffect(() => {
    rendererRef.current?.setInsets({
      top: 120,
      right: sheetOpen ? SHEET_OFFSET_PX + 24 : 24,
      bottom: 88,
      left: 24,
    });
  }, [sheetOpen]);

  const direction = nav.direction;
  useLayoutEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const key = viewKey(scene.view);
    const viewChanged = key !== lastViewKeyRef.current;
    lastViewKeyRef.current = key;
    renderer.setScene(scene, { viewChanged, direction });
  }, [scene, direction]);

  useLayoutEffect(() => {
    rendererRef.current?.setRevealFlags(flags);
  }, [flags]);

  const activate = useCallback(
    (mark: MapMark) => {
      if (mark.kind === "territory" || mark.kind === "stub")
        navigate({ kind: "territory", territoryId: mark.id });
      else if (mark.kind === "node") {
        navigate({ kind: "lens", territoryId: mark.territoryId, nodeId: mark.id });
        onSelectNode(mark.id);
      }
    },
    [navigate, onSelectNode],
  );

  const clearReveal = useCallback(() => {
    queryTokenRef.current++;
    setReveal(null);
    setRevealStatus({ kind: "idle" });
    setQuery("");
  }, []);

  const runReveal = async () => {
    const text = query.trim();
    if (!text) return;
    const token = ++queryTokenRef.current;
    setRevealStatus({ kind: "busy" });
    const result = await runQuery({ environmentId, input: { text, limit: 12 } });
    if (token !== queryTokenRef.current) return;
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setRevealStatus({
        kind: "error",
        message: cause instanceof Error ? cause.message : "The query could not run.",
      });
      return;
    }
    const next = revealFromResult(graph, text, result.value);
    if (next.lit.size === 0) {
      setReveal(null);
      setRevealStatus({ kind: "none", query: text });
      return;
    }
    setReveal(next);
    setRevealStatus({ kind: "idle" });
    if (next.bestTerritoryId) navigate({ kind: "territory", territoryId: next.bestTerritoryId });
  };

  const walkUp = (): boolean => {
    if (reveal || revealStatus.kind === "none" || revealStatus.kind === "error") {
      clearReveal();
      return true;
    }
    const up = parentView(scene.view);
    if (!up) return false;
    navigate(up);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const typing = event.target instanceof HTMLInputElement;
    if (event.key === "Escape" && !typing) {
      if (walkUp()) event.preventDefault();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    const renderer = rendererRef.current;
    const wrap = wrapRef.current;
    if (event.key === "/") {
      event.preventDefault();
      inputRef.current?.focus();
    } else if (event.key === "f" || event.key === "F") {
      event.preventDefault();
      renderer?.fit();
    } else if ((event.key === "+" || event.key === "=" || event.key === "-") && renderer && wrap) {
      event.preventDefault();
      renderer.zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, event.key === "-" ? 180 : -180);
    }
  };

  const local = (event: PointerEvent<HTMLCanvasElement>) => {
    const r = event.currentTarget.getBoundingClientRect();
    return [event.clientX - r.left, event.clientY - r.top] as const;
  };
  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const drag = dragRef.current;
    const canvas = event.currentTarget;
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) <= 4) return;
      drag.moved = true;
      drag.x = event.clientX;
      drag.y = event.clientY;
      canvas.style.cursor = "grabbing";
      renderer.panBy(dx, dy);
      return;
    }
    const [x, y] = local(event);
    const hit = renderer.hitTest(x, y);
    if (renderer.setHover(hit)) {
      const kind = hit >= 0 ? sceneRef.current.marks[hit]?.kind : undefined;
      canvas.style.cursor = kind && kind !== "more" ? "pointer" : "grab";
    }
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    event.currentTarget.style.cursor = "grab";
    if (!drag || drag.moved) return;
    const [x, y] = local(event);
    const hit = rendererRef.current?.hitTest(x, y) ?? -1;
    const mark = hit >= 0 ? sceneRef.current.marks[hit] : undefined;
    if (mark) activate(mark);
  };

  const shownView = scene.view;
  const territoryLabel =
    shownView.kind === "territories"
      ? null
      : (graph.territories.find((t) => t.id === shownView.territoryId)?.label ??
        shownView.territoryId);
  const focusLabel =
    scene.view.kind === "lens" ? (scene.marks.find((m) => m.hop === 0)?.label ?? null) : null;
  const rightOffset = sheetOpen ? { right: SHEET_OFFSET_PX + 12 } : undefined;

  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden"
      onKeyDown={onKeyDown}
      style={{
        backgroundImage:
          "linear-gradient(color-mix(in srgb, var(--border) 34%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--border) 34%, transparent) 1px, transparent 1px)",
        backgroundSize: "64px 64px",
      }}
    >
      <div ref={wrapRef} className="absolute inset-0">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label="Memory map. Use Outline for a keyboard list of the same marks."
          className="absolute inset-0 block size-full cursor-grab touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (dragRef.current = null)}
          onPointerLeave={() => {
            if (!dragRef.current) rendererRef.current?.setHover(-1);
          }}
        />
      </div>
      {graph.territories.length === 0 ? (
        <div className="absolute inset-0 z-10 bg-background">
          <EmptyWarren />
        </div>
      ) : null}

      {/* Top left: breadcrumb, reveal input, reveal bar. */}
      <div className="pointer-events-none absolute top-3 left-3 flex max-w-[min(34rem,calc(100%-14rem))] flex-col items-start gap-2 sm:top-4 sm:left-4">
        <nav aria-label="Map level" className={cn(GLASS, "pointer-events-auto max-w-full")}>
          <ol className="m-0 flex min-w-0 list-none items-center gap-0.5 p-1 text-sm">
            <Crumb
              current={scene.view.kind === "territories"}
              onClick={() => navigate(TERRITORIES_VIEW)}
            >
              Whole warren
            </Crumb>
            {scene.view.kind !== "territories" ? (
              <>
                <CrumbSeparator />
                <Crumb
                  current={scene.view.kind === "territory"}
                  onClick={() =>
                    scene.view.kind === "lens" &&
                    navigate({ kind: "territory", territoryId: scene.view.territoryId })
                  }
                >
                  {territoryLabel}
                </Crumb>
              </>
            ) : null}
            {focusLabel ? (
              <>
                <CrumbSeparator />
                <Crumb current>{focusLabel}</Crumb>
              </>
            ) : null}
            {scene.view.kind !== "territories" ? (
              <li className="ml-1 hidden pr-1 sm:flex">
                <Kbd>Esc</Kbd>
              </li>
            ) : null}
          </ol>
        </nav>

        <label
          className={cn(
            GLASS,
            "pointer-events-auto flex h-9 w-[22rem] max-w-full items-center gap-2 pr-1.5 pl-3 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
          )}
        >
          <EyeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void runReveal();
              } else if (event.key === "Escape") {
                event.stopPropagation();
                if (query || reveal || revealStatus.kind !== "idle") clearReveal();
                else event.currentTarget.blur();
              }
            }}
            maxLength={500}
            placeholder="Reveal what a query retrieves, e.g. webhook retry"
            aria-label="Reveal query"
            className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-placeholder"
          />
          {revealStatus.kind === "busy" ? (
            <Spinner className="size-3.5 text-muted-foreground" />
          ) : (
            <Kbd>/</Kbd>
          )}
        </label>

        {reveal ? (
          <RevealBar onClear={clearReveal}>
            <span className="min-w-0">
              <b className="font-semibold text-foreground">"{reveal.query}"</b>{" "}
              <span className="tabular-nums">
                {formatCount(reveal.lit.size)} {reveal.lit.size === 1 ? "node" : "nodes"}, about{" "}
                {formatTokens(reveal.approxTokens)} tokens
              </span>
              <span className="text-muted-foreground">
                {" "}
                · enters at {reveal.entry.size}, walks {reveal.lit.size - reveal.entry.size} more
              </span>
            </span>
          </RevealBar>
        ) : revealStatus.kind === "none" ? (
          <RevealBar onClear={clearReveal}>
            <span>No node in the warren matches "{revealStatus.query}".</span>
          </RevealBar>
        ) : revealStatus.kind === "error" ? (
          <RevealBar onClear={clearReveal} tone="error">
            <span>{revealStatus.message}</span>
          </RevealBar>
        ) : null}
      </div>

      {/* Top right: fit and outline. */}
      <div className="absolute top-3 right-3 flex gap-1.5 sm:top-4 sm:right-4" style={rightOffset}>
        <Button variant="glass" size="sm" onClick={() => rendererRef.current?.fit()}>
          Fit <Kbd className="h-4.5 min-w-4.5 bg-transparent">F</Kbd>
        </Button>
        <Button
          variant="glass"
          size="sm"
          aria-expanded={outlineOpen}
          aria-controls="memory-map-outline"
          onClick={() => setOutlineOpen((open) => !open)}
        >
          <ListIcon />
          Outline
        </Button>
      </div>
      {outlineOpen ? (
        <MapOutline
          marks={scene.marks}
          style={rightOffset}
          onActivate={activate}
          onClose={() => setOutlineOpen(false)}
        />
      ) : null}

      {/* Bottom left: legend. */}
      <div
        aria-label="Node types"
        className={cn(
          GLASS,
          "pointer-events-none absolute bottom-3 left-3 hidden grid-cols-4 gap-x-3.5 gap-y-1 px-3 py-2 text-[11px] text-muted-foreground sm:bottom-4 sm:left-4 md:grid",
        )}
      >
        {TYPE_ORDER.map((type) => (
          <span key={type} className="flex items-center gap-1.5">
            <MemoryTypeGlyph type={type} />
            {type}
          </span>
        ))}
      </div>

      {/* Bottom right: readout, written by the renderer, not React. */}
      <div
        aria-hidden
        className={cn(
          GLASS,
          "pointer-events-none absolute right-3 bottom-3 min-w-52 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground sm:right-4 sm:bottom-4",
        )}
        style={rightOffset}
      >
        <div>
          marks on screen{" "}
          <b ref={marksRef} className="font-semibold text-foreground tabular-nums">
            0 / {MAX_MARKS}
          </b>
        </div>
        <div>
          edges{" "}
          <b ref={edgesRef} className="font-semibold text-foreground tabular-nums">
            0 / {MAX_EDGES}
          </b>
        </div>
        <div>
          frames drawn{" "}
          <b ref={framesRef} className="font-semibold text-foreground tabular-nums">
            0
          </b>
        </div>
        <div
          ref={stateRef}
          data-state="idle"
          className="flex items-center gap-1.5 before:size-1.5 before:rounded-full before:bg-muted-foreground before:content-[''] data-[state=drawing]:before:bg-primary"
        >
          idle, no frames until input
        </div>
      </div>
    </div>
  );
}

function Crumb({
  current,
  onClick,
  children,
}: {
  readonly current: boolean;
  readonly onClick?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <li className="flex min-w-0 items-center" aria-current={current ? "page" : undefined}>
      {current ? (
        <span className="truncate px-2 py-0.5 font-display text-[15px] text-foreground">
          {children}
        </span>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="truncate rounded-md px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {children}
        </button>
      )}
    </li>
  );
}

function CrumbSeparator() {
  return (
    <li aria-hidden className="flex shrink-0 items-center text-icon-muted">
      <ChevronRightIcon className="size-3.5" />
    </li>
  );
}

function RevealBar({
  onClear,
  tone = "default",
  children,
}: {
  readonly onClear: () => void;
  readonly tone?: "default" | "error";
  readonly children: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        GLASS,
        "pointer-events-auto flex max-w-full items-center gap-2.5 py-1.5 pr-1.5 pl-3 text-xs",
        tone === "error"
          ? "border-destructive/40 text-destructive-foreground"
          : "border-primary/40 text-foreground",
      )}
    >
      <EyeIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
      {children}
      <Button variant="ghost" size="xs" onClick={onClear} className="shrink-0">
        Clear <Kbd className="h-4.5 bg-transparent">Esc</Kbd>
      </Button>
    </div>
  );
}

/** Keyboard list of the current marks; complete without the canvas. */
function MapOutline({
  marks,
  style,
  onActivate,
  onClose,
}: {
  readonly marks: ReadonlyArray<MapMark>;
  readonly style: CSSProperties | undefined;
  readonly onActivate: (mark: MapMark) => void;
  readonly onClose: () => void;
}) {
  return (
    <div
      id="memory-map-outline"
      className={cn(
        GLASS,
        "absolute top-14 right-3 z-10 flex max-h-[60%] w-72 flex-col overflow-hidden sm:right-4",
      )}
      style={style}
    >
      <div className="flex items-center justify-between border-b border-border/70 py-1.5 pr-1 pl-3">
        <span className="text-xs font-medium text-muted-foreground">
          {marks.length} marks in this view
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="Close outline" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <ul className="m-0 min-h-0 list-none overflow-y-auto p-1">
        {marks.map((mark) => (
          <li key={`${mark.kind}:${mark.id}`}>
            <button
              type="button"
              disabled={mark.kind === "more"}
              onClick={() => onActivate(mark)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
            >
              {mark.type ? (
                <MemoryTypeGlyph type={mark.type} />
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              <span className={cn("min-w-0 flex-1 truncate", mark.hop === 2 && "opacity-70")}>
                {mark.label}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {mark.kind === "territory"
                  ? formatCount(mark.count)
                  : mark.kind === "node"
                    ? mark.hop === null
                      ? ""
                      : mark.hop === 0
                        ? "focus"
                        : `${mark.hop}-hop`
                    : mark.kind}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const GLYPH_PATHS: Record<MemoryNodeType, (color: string) => ReactNode> = {
  function: (c) => <circle cx="8" cy="8" r="5.5" fill={c} />,
  module: (c) => <rect x="2.8" y="2.8" width="10.4" height="10.4" rx="2" fill={c} />,
  class: (c) => <path d="M8 1.8 13.4 4.9v6.2L8 14.2 2.6 11.1V4.9Z" fill={c} />,
  interface: (c) => (
    <path d="M8 1.8 14.2 8 8 14.2 1.8 8Z" fill="none" stroke={c} strokeWidth="2.2" />
  ),
  concept: (c) => <path d="M8 2.2 14.3 13.4H1.7Z" fill={c} />,
  decision: (c) => <path d="m8 1 1.9 5.1L15 8l-5.1 1.9L8 15l-1.9-5.1L1 8l5.1-1.9Z" fill={c} />,
  reference: (c) => <circle cx="8" cy="8" r="4.6" fill="none" stroke={c} strokeWidth="2.4" />,
  composite: (c) => <path d="M5.6 1.8h4.8v3.8h3.8v4.8h-3.8v3.8H5.6v-3.8H1.8V5.6h3.8Z" fill={c} />,
};

/** The map's type glyph (shape plus palette color) for legends and lists. */
export function MemoryTypeGlyph({
  type,
  className,
}: {
  readonly type: MemoryNodeType;
  readonly className?: string;
}) {
  const color = MEMORY_TYPE_COLORS[type];
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={cn("size-3.5 shrink-0", className)}
      stroke={HOLLOW_TYPES.has(type) ? undefined : "rgb(0 0 0 / 0.3)"}
      strokeWidth={HOLLOW_TYPES.has(type) ? undefined : 0.8}
    >
      {GLYPH_PATHS[type](color)}
    </svg>
  );
}

function EmptyWarren() {
  return (
    <MemoryMapStatus
      title="The warren is empty"
      description="Nodes land here when a space closes and its den passes the Contribution Gate."
    />
  );
}

/** Centered placeholder for the map area: loading, disabled, empty, or error. */
export function MemoryMapStatus({
  title,
  description,
  loading = false,
}: {
  readonly title: string;
  readonly description?: string | null;
  readonly loading?: boolean;
}) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {loading ? <Spinner className="size-4.5" /> : <NetworkIcon />}
        </EmptyMedia>
        <EmptyTitle className="font-display font-normal">{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}
