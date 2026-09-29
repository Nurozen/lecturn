import type {
  MemoryGraph,
  MemoryNodeType,
  MemoryQueryResult,
  MemoryTerritory,
  MemoryTerritoryEdge,
} from "@lecturn/contracts";

/* Pure scene building for the Memory map. The renderer draws whatever these
   functions return; nothing here touches the DOM. */

/** Hard caps per view (spec 8.4: `ui.maxMarks`, edges 3x). */
export const MAX_MARKS = 150;
export const MAX_EDGES = MAX_MARKS * 3;
const LENS_HOP1 = 14;
const LENS_HOP2 = 24;
const MAX_STUBS = 8;
const STUB_EDGES = 4;
const NODE_SPACING = 64;

export type MapView =
  | { readonly kind: "territories" }
  | { readonly kind: "territory"; readonly territoryId: string }
  | { readonly kind: "lens"; readonly territoryId: string; readonly nodeId: string };

export const TERRITORIES_VIEW: MapView = { kind: "territories" };

export type MapMarkKind = "territory" | "node" | "stub" | "more";

/** One drawable mark in world units. `id` is a territory id for territory and
    stub marks, a node id for node marks, and `more:<territoryId>` for "+N". */
export interface MapMark {
  readonly kind: MapMarkKind;
  readonly id: string;
  readonly territoryId: string;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly type: MemoryNodeType | null;
  readonly label: string;
  readonly score: number;
  /** Base opacity before reveal and hover; 2-hop lens nodes are faded. */
  readonly alpha: number;
  /** Lens distance from the focused node, null outside the lens. */
  readonly hop: 0 | 1 | 2 | null;
  /** Territory node count, or how many nodes a "+N" mark stands for. */
  readonly count: number;
  /** Territory never recalled: drawn in the muted static style. */
  readonly muted: boolean;
  /** Node landed by the lit receipt; for territories, how many such nodes. */
  readonly landed: number;
  readonly stale: boolean;
}

export interface MapEdge {
  readonly a: number;
  readonly b: number;
  readonly weight: number;
  readonly faint: boolean;
  /** Territory bridge across projects, drawn as an arc. */
  readonly arc: boolean;
}

export interface MapScene {
  /** The view actually built; falls back up the hierarchy when ids are gone. */
  readonly view: MapView;
  readonly marks: ReadonlyArray<MapMark>;
  readonly edges: ReadonlyArray<MapEdge>;
  /** Mark index to neighboring mark indexes, from `edges`. */
  readonly adjacency: ReadonlyArray<ReadonlyArray<number>>;
}

export interface SceneOptions {
  /** Receipt whose landed nodes get the static ring. */
  readonly litReceiptId?: string | null | undefined;
  /** Node ids that win budget slots first, e.g. reveal hits. */
  readonly pinned?: ReadonlySet<string> | undefined;
}

interface GraphIndex {
  readonly nodeIndex: ReadonlyMap<string, number>;
  readonly neighbors: ReadonlyArray<ReadonlyArray<number>>;
  /** Node indexes per territory, highest score first. */
  readonly byTerritory: ReadonlyMap<string, ReadonlyArray<number>>;
  readonly territories: ReadonlyMap<string, MemoryTerritory>;
}

const indexCache = new WeakMap<MemoryGraph, GraphIndex>();

function indexGraph(graph: MemoryGraph): GraphIndex {
  const cached = indexCache.get(graph);
  if (cached) return cached;
  const nodeIndex = new Map<string, number>();
  const neighbors: number[][] = graph.nodes.map(() => []);
  const byTerritory = new Map<string, number[]>();
  graph.nodes.forEach((node, i) => {
    nodeIndex.set(node.id, i);
    const list = byTerritory.get(node.territoryId);
    if (list) list.push(i);
    else byTerritory.set(node.territoryId, [i]);
  });
  for (const [a, b] of graph.edges) {
    if (a === b || a >= graph.nodes.length || b >= graph.nodes.length) continue;
    if (neighbors[a]!.includes(b)) continue;
    neighbors[a]!.push(b);
    neighbors[b]!.push(a);
  }
  const byScore = (a: number, b: number) => graph.nodes[b]!.score - graph.nodes[a]!.score;
  for (const list of byTerritory.values()) list.sort(byScore);
  for (const list of neighbors) list.sort(byScore);
  const index: GraphIndex = {
    nodeIndex,
    neighbors,
    byTerritory,
    territories: new Map(graph.territories.map((t) => [t.id, t])),
  };
  indexCache.set(graph, index);
  return index;
}

/** Territory edges as shipped, or aggregated from cross-territory node edges
    when the payload has none. Weight is the number of linking node edges. */
export function territoryEdgesOf(graph: MemoryGraph): ReadonlyArray<MemoryTerritoryEdge> {
  if (graph.territoryEdges.length > 0) return graph.territoryEdges;
  const weights = new Map<string, number>();
  for (const [a, b] of graph.edges) {
    const ta = graph.nodes[a]?.territoryId;
    const tb = graph.nodes[b]?.territoryId;
    if (ta === undefined || tb === undefined || ta === tb) continue;
    const key = ta < tb ? `${ta}\u0000${tb}` : `${tb}\u0000${ta}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  return [...weights].map(([key, weight]) => {
    const [a, b] = key.split("\u0000") as [string, string];
    return { a, b, weight };
  });
}

/** Resolves a view against the graph, walking up when its ids are gone. */
export function resolveView(graph: MemoryGraph, view: MapView): MapView {
  if (view.kind === "territories") return view;
  const index = indexGraph(graph);
  if (!index.territories.has(view.territoryId)) return TERRITORIES_VIEW;
  if (view.kind === "lens" && !index.nodeIndex.has(view.nodeId))
    return { kind: "territory", territoryId: view.territoryId };
  return view;
}

/** Lens view for a node, or null when the node is not in the graph payload. */
export function lensViewFor(graph: MemoryGraph, nodeId: string): MapView | null {
  const i = indexGraph(graph).nodeIndex.get(nodeId);
  if (i === undefined) return null;
  return { kind: "lens", territoryId: graph.nodes[i]!.territoryId, nodeId };
}

/** One level up: lens to territory, territory to the whole warren. */
export function parentView(view: MapView): MapView | null {
  if (view.kind === "lens") return { kind: "territory", territoryId: view.territoryId };
  if (view.kind === "territory") return TERRITORIES_VIEW;
  return null;
}

export function viewKey(view: MapView): string {
  return view.kind === "territories"
    ? "territories"
    : view.kind === "territory"
      ? `territory:${view.territoryId}`
      : `lens:${view.nodeId}`;
}

export function viewDepth(view: MapView): number {
  return view.kind === "territories" ? 0 : view.kind === "territory" ? 1 : 2;
}

/** Builds the marks and edges for a view, within the mark and edge budget. */
export function buildScene(
  graph: MemoryGraph,
  requested: MapView,
  options: SceneOptions = {},
): MapScene {
  const view = resolveView(graph, requested);
  const built =
    view.kind === "territories"
      ? territoriesScene(graph, options)
      : view.kind === "territory"
        ? territoryScene(graph, view.territoryId, options)
        : lensScene(graph, view.nodeId, options);
  const marks = built.marks.slice(0, MAX_MARKS);
  const edges = built.edges
    .filter((e) => e.a < marks.length && e.b < marks.length)
    .slice(0, MAX_EDGES);
  const adjacency: number[][] = marks.map(() => []);
  for (const e of edges) {
    adjacency[e.a]!.push(e.b);
    adjacency[e.b]!.push(e.a);
  }
  return { view, marks, edges, adjacency };
}

interface Built {
  marks: MapMark[];
  edges: MapEdge[];
}

const isLanded = (landedReceiptId: string | null, options: SceneOptions) =>
  options.litReceiptId != null && landedReceiptId === options.litReceiptId;

function territoryRadius(nodeCount: number): number {
  return 24 + Math.sqrt(nodeCount) * 4.3;
}

function territoriesScene(graph: MemoryGraph, options: SceneOptions): Built {
  const landed = new Map<string, number>();
  for (const node of graph.nodes)
    if (isLanded(node.landedReceiptId, options))
      landed.set(node.territoryId, (landed.get(node.territoryId) ?? 0) + 1);
  const territories = [...graph.territories]
    .sort((a, b) => b.nodeCount - a.nodeCount)
    .slice(0, MAX_MARKS);
  const radii = territories.map((t) => territoryRadius(t.nodeCount));
  const scale = spacingScale(
    territories.map((t) => [t.x, t.y] as const),
    (i, j) => radii[i]! + radii[j]! + 8,
  );
  const cx = mean(territories.map((t) => t.x));
  const cy = mean(territories.map((t) => t.y));
  const at = new Map<string, number>();
  const marks = territories.map((t, i): MapMark => {
    at.set(t.id, i);
    return {
      kind: "territory",
      id: t.id,
      territoryId: t.id,
      x: (t.x - cx) * scale,
      y: (t.y - cy) * scale,
      r: radii[i]!,
      type: t.dominantType,
      label: t.label,
      score: t.nodeCount,
      alpha: 1,
      hop: null,
      count: t.nodeCount,
      muted: !t.recalled,
      landed: landed.get(t.id) ?? 0,
      stale: false,
    };
  });
  const project = new Map(territories.map((t) => [t.id, t.project]));
  const edges = [...territoryEdgesOf(graph)]
    .filter((e) => at.has(e.a) && at.has(e.b) && e.a !== e.b)
    .sort((p, q) => q.weight - p.weight)
    .slice(0, MAX_EDGES)
    .map((e): MapEdge => ({
      a: at.get(e.a)!,
      b: at.get(e.b)!,
      weight: e.weight,
      faint: false,
      arc: project.get(e.a) !== project.get(e.b),
    }));
  return { marks, edges };
}

function territoryScene(graph: MemoryGraph, territoryId: string, options: SceneOptions): Built {
  const index = indexGraph(graph);
  const territory = index.territories.get(territoryId)!;
  const candidates = index.byTerritory.get(territoryId) ?? [];

  // Neighbor territories reached by cross edges, strongest first.
  const reach = new Map<string, number[]>();
  for (const i of candidates)
    for (const j of index.neighbors[i]!) {
      const other = graph.nodes[j]!.territoryId;
      if (other === territoryId || !index.territories.has(other)) continue;
      const list = reach.get(other);
      if (list) {
        if (!list.includes(i)) list.push(i);
      } else reach.set(other, [i]);
    }
  const stubIds = [...reach.keys()]
    .sort((a, b) => reach.get(b)!.length - reach.get(a)!.length)
    .slice(0, MAX_STUBS);

  const pinned = options.pinned;
  const priority = (i: number) => {
    const node = graph.nodes[i]!;
    return pinned?.has(node.id) || isLanded(node.landedReceiptId, options) ? 1 : 0;
  };
  const nodeBudget = Math.max(0, MAX_MARKS - stubIds.length - 1);
  const ranked = [...candidates].sort((a, b) => priority(b) - priority(a));
  const shown = ranked.slice(0, nodeBudget);
  const more = Math.max(0, territory.nodeCount - shown.length);

  const positions = normalizePositions(shown.map((i) => [graph.nodes[i]!.x, graph.nodes[i]!.y]));
  const at = new Map<number, number>();
  let reachRadius = 0;
  const marks: MapMark[] = shown.map((i, k) => {
    const node = graph.nodes[i]!;
    const [x, y] = positions[k]!;
    reachRadius = Math.max(reachRadius, Math.hypot(x, y));
    at.set(i, k);
    return nodeMark(node, x, y, 4.5 + Math.min(9, node.score / 9), 1, null, options);
  });
  const edges: MapEdge[] = [];
  const structural: MapEdge[] = [];
  for (const i of shown)
    for (const j of index.neighbors[i]!)
      if (j > i && at.has(j))
        structural.push({ a: at.get(i)!, b: at.get(j)!, weight: 1, faint: false, arc: false });

  const R = Math.max(reachRadius, 60);
  const stubEdges: MapEdge[] = [];
  for (const other of stubIds) {
    const target = index.territories.get(other)!;
    const angle = Math.atan2(target.y - territory.y, target.x - territory.x);
    const s = marks.length;
    marks.push({
      kind: "stub",
      id: other,
      territoryId: other,
      x: Math.cos(angle) * (R + 90),
      y: Math.sin(angle) * (R + 90),
      r: 13,
      type: target.dominantType,
      label: target.label,
      score: 0,
      alpha: 0.9,
      hop: null,
      count: target.nodeCount,
      muted: !target.recalled,
      landed: 0,
      stale: false,
    });
    for (const i of reach
      .get(other)!
      .filter((i) => at.has(i))
      .slice(0, STUB_EDGES))
      stubEdges.push({ a: s, b: at.get(i)!, weight: 1, faint: true, arc: false });
  }
  if (more > 0)
    marks.push({
      kind: "more",
      id: `more:${territoryId}`,
      territoryId,
      x: -R * 0.95,
      y: R * 0.95,
      r: 21,
      type: null,
      label: `+${formatCount(more)} more`,
      score: 0,
      alpha: 1,
      hop: null,
      count: more,
      muted: false,
      landed: 0,
      stale: false,
    });
  const room = Math.max(0, MAX_EDGES - stubEdges.length);
  const score = (e: MapEdge) => Math.min(marks[e.a]!.score, marks[e.b]!.score);
  edges.push(...structural.sort((p, q) => score(q) - score(p)).slice(0, room), ...stubEdges);
  return { marks, edges };
}

function lensScene(graph: MemoryGraph, nodeId: string, options: SceneOptions): Built {
  const index = indexGraph(graph);
  const f = index.nodeIndex.get(nodeId)!;
  const focus = graph.nodes[f]!;
  const seen = new Set([f]);
  const hop1All = index.neighbors[f]!;
  const hop1 = hop1All.slice(0, LENS_HOP1);
  for (const i of hop1) seen.add(i);

  const marks: MapMark[] = [nodeMark(focus, 0, 0, 15, 1, 0, options, 1e3)];
  const at = new Map([[f, 0]]);
  const edges: MapEdge[] = [];
  const angles: number[] = [0];
  hop1.forEach((i, k) => {
    const node = graph.nodes[i]!;
    const angle = -Math.PI / 2 + (k / hop1.length) * Math.PI * 2;
    at.set(i, marks.length);
    angles.push(angle);
    marks.push(
      nodeMark(
        node,
        Math.cos(angle) * 170,
        Math.sin(angle) * 155,
        5 + Math.min(8, node.score / 10),
        1,
        1,
        options,
        500 + node.score,
      ),
    );
    edges.push({ a: 0, b: at.get(i)!, weight: 2, faint: false, arc: false });
  });

  const hop2All: Array<[node: number, parent: number]> = [];
  for (const i of hop1)
    for (const j of index.neighbors[i]!)
      if (!seen.has(j)) {
        seen.add(j);
        hop2All.push([j, i]);
      }
  hop2All.sort((p, q) => graph.nodes[q[0]]!.score - graph.nodes[p[0]]!.score);
  const hop2 = hop2All
    .slice(0, LENS_HOP2)
    .sort((p, q) => angles[at.get(p[1])!]! - angles[at.get(q[1])!]!);
  hop2.forEach(([i, parent], k) => {
    const node = graph.nodes[i]!;
    const angle = -Math.PI / 2 + ((k + 0.5) / hop2.length) * Math.PI * 2;
    at.set(i, marks.length);
    marks.push(
      nodeMark(
        node,
        Math.cos(angle) * 285,
        Math.sin(angle) * 280,
        4 + Math.min(5, node.score / 14),
        0.4,
        2,
        options,
        node.score * 0.1,
      ),
    );
    edges.push({ a: at.get(parent)!, b: at.get(i)!, weight: 1, faint: true, arc: false });
  });
  for (let p = 0; p < hop1.length; p++)
    for (let q = p + 1; q < hop1.length; q++)
      if (index.neighbors[hop1[p]!]!.includes(hop1[q]!))
        edges.push({
          a: at.get(hop1[p]!)!,
          b: at.get(hop1[q]!)!,
          weight: 1,
          faint: false,
          arc: false,
        });

  const culled = hop1All.length - hop1.length + hop2All.length - hop2.length;
  if (culled > 0)
    marks.push({
      kind: "more",
      id: `more:lens:${nodeId}`,
      territoryId: focus.territoryId,
      x: 260,
      y: 330,
      r: 19,
      type: null,
      label: `+${formatCount(culled)} culled`,
      score: 0,
      alpha: 0.8,
      hop: null,
      count: culled,
      muted: false,
      landed: 0,
      stale: false,
    });
  return { marks, edges };
}

function nodeMark(
  node: MemoryGraph["nodes"][number],
  x: number,
  y: number,
  r: number,
  alpha: number,
  hop: 0 | 1 | 2 | null,
  options: SceneOptions,
  score = node.score,
): MapMark {
  return {
    kind: "node",
    id: node.id,
    territoryId: node.territoryId,
    x,
    y,
    r,
    type: node.type,
    label: node.label,
    score,
    alpha,
    hop,
    count: 1,
    muted: false,
    landed: isLanded(node.landedReceiptId, options) ? 1 : 0,
    stale: node.stale,
  };
}

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

/** Layout scale for territory centers. Server layouts in world units keep
    their shape; overlapping pairs spread until they just touch, and tiny
    normalized layouts (0..1 style) grow to world size. */
function spacingScale(
  points: ReadonlyArray<readonly [number, number]>,
  minDistance: (i: number, j: number) => number,
): number {
  let touch = 0;
  let span = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i]![0] - points[j]![0], points[i]![1] - points[j]![1]);
      span = Math.max(span, d);
      if (d > 1e-9) touch = Math.max(touch, minDistance(i, j) / d);
    }
  if (touch === 0) return 1;
  return touch > 1 || span < 100 ? touch : 1;
}

/** Centers node positions and scales them so the median nearest-neighbor
    distance is `NODE_SPACING`. Coincident points fan out on a spiral. */
export function normalizePositions(
  points: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  if (points.length === 0) return [];
  const cx = mean(points.map((p) => p[0]));
  const cy = mean(points.map((p) => p[1]));
  const centered = points.map(([x, y]) => [x - cx, y - cy] as [number, number]);
  const nearest: number[] = [];
  for (let i = 0; i < centered.length; i++) {
    let best = Infinity;
    for (let j = 0; j < centered.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(centered[i]![0] - centered[j]![0], centered[i]![1] - centered[j]![1]);
      if (d > 1e-9) best = Math.min(best, d);
    }
    if (best < Infinity) nearest.push(best);
  }
  if (nearest.length === 0)
    return centered.map((_, i) =>
      i === 0
        ? [0, 0]
        : [
            Math.cos(i * 2.4) * NODE_SPACING * Math.sqrt(i),
            Math.sin(i * 2.4) * NODE_SPACING * Math.sqrt(i),
          ],
    );
  nearest.sort((a, b) => a - b);
  const fitted = NODE_SPACING / nearest[Math.floor(nearest.length / 2)]!;
  // Layouts already in world units keep their exact shape.
  const scale = fitted > 0.5 && fitted < 2 ? 1 : fitted;
  return centered.map(([x, y]) => [x * scale, y * scale]);
}

/* ---------- camera and hit testing ---------- */

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}
export interface Viewport {
  readonly w: number;
  readonly h: number;
}
export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const toScreenX = (camera: Camera, viewport: Viewport, x: number) =>
  (x - camera.x) * camera.k + viewport.w / 2;
export const toScreenY = (camera: Camera, viewport: Viewport, y: number) =>
  (y - camera.y) * camera.k + viewport.h / 2;

/** On-screen radius. Territories scale with zoom; nodes stay legible. */
export function screenRadius(mark: MapMark, k: number): number {
  return mark.kind === "territory"
    ? mark.r * k
    : Math.max(3.5, mark.r * Math.min(1.5, Math.max(0.75, k)));
}

/** Index of the mark under a screen point, nearest center wins; -1 if none. */
export function hitTest(
  marks: ReadonlyArray<MapMark>,
  camera: Camera,
  viewport: Viewport,
  px: number,
  py: number,
  slop = 4,
): number {
  let best = -1;
  let bestDistance = Infinity;
  marks.forEach((mark, i) => {
    const d = Math.hypot(
      px - toScreenX(camera, viewport, mark.x),
      py - toScreenY(camera, viewport, mark.y),
    );
    if (d <= screenRadius(mark, camera.k) + slop && d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  });
  return best;
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

/** Camera that fits every mark inside the viewport minus insets. */
export function fitCamera(
  marks: ReadonlyArray<MapMark>,
  viewport: Viewport,
  insets: Insets,
): Camera {
  if (marks.length === 0 || viewport.w <= 0 || viewport.h <= 0) return { x: 0, y: 0, k: 1 };
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const m of marks) {
    // Node labels hang to the right, up to ~180 px for a truncated label;
    // leave them room so the rightmost ones clear the node sheet.
    const labelRoom = m.kind === "node" ? 170 : m.kind === "stub" ? 30 : 0;
    x0 = Math.min(x0, m.x - m.r - labelRoom / 3);
    x1 = Math.max(x1, m.x + m.r + labelRoom);
    y0 = Math.min(y0, m.y - m.r);
    y1 = Math.max(y1, m.y + m.r + (m.kind === "stub" ? 26 : 0));
  }
  const availW = Math.max(40, viewport.w - insets.left - insets.right);
  const availH = Math.max(40, viewport.h - insets.top - insets.bottom);
  const k = Math.max(
    MIN_ZOOM,
    Math.min(1.7, availW / Math.max(1, x1 - x0 + 24), availH / Math.max(1, y1 - y0 + 24)),
  );
  // Center the content inside the inset box, then express as camera center.
  const boxCx = insets.left + availW / 2;
  const boxCy = insets.top + availH / 2;
  return {
    x: (x0 + x1) / 2 - (boxCx - viewport.w / 2) / k,
    y: (y0 + y1) / 2 - (boxCy - viewport.h / 2) / k,
    k,
  };
}

/** Zoom by a wheel delta around a screen point, keeping it fixed. */
export function zoomCameraAt(
  camera: Camera,
  viewport: Viewport,
  px: number,
  py: number,
  deltaY: number,
): Camera {
  const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.k * Math.exp(-deltaY * 0.0016)));
  const wx = (px - viewport.w / 2) / camera.k + camera.x;
  const wy = (py - viewport.h / 2) / camera.k + camera.y;
  return { x: wx - (px - viewport.w / 2) / k, y: wy - (py - viewport.h / 2) / k, k };
}

/* ---------- labels ---------- */

export interface LabelCandidate {
  readonly index: number;
  /** Box in screen pixels. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly priority: number;
  /** Always placed (hovered or focused mark), still blocks later labels. */
  readonly force?: boolean;
}

/** Top-K labels by priority with simple box collision rejection. Returns the
    placed candidate indexes (mark indexes) in placement order. */
export function pickLabels(candidates: ReadonlyArray<LabelCandidate>, k: number): number[] {
  const ordered = [...candidates].sort(
    (p, q) => Number(q.force ?? false) - Number(p.force ?? false) || q.priority - p.priority,
  );
  const placed: LabelCandidate[] = [];
  for (const c of ordered) {
    if (!c.force && placed.length >= k) break;
    const hits = placed.some((b) => c.x0 < b.x1 && c.x1 > b.x0 && c.y0 < b.y1 && c.y1 > b.y0);
    if (hits && !c.force) continue;
    placed.push(c);
  }
  return placed.map((c) => c.index);
}

/* ---------- query reveal ---------- */

export interface MapReveal {
  readonly query: string;
  /** Entry nodes: the hits. */
  readonly entry: ReadonlySet<string>;
  /** Hits plus the traversal path. */
  readonly lit: ReadonlySet<string>;
  readonly territories: ReadonlySet<string>;
  readonly approxTokens: number;
  readonly bestTerritoryId: string | null;
}

/** Folds a query result into what the map lights. The best territory is the
    one whose hits carry the most score. */
export function revealFromResult(
  graph: MemoryGraph,
  query: string,
  result: MemoryQueryResult,
): MapReveal {
  const index = indexGraph(graph);
  const entry = new Set(result.hits.map((h) => h.nodeId));
  const lit = new Set([...entry, ...result.pathIds]);
  const territories = new Set(result.hits.map((h) => h.territoryId));
  for (const id of result.pathIds) {
    const i = index.nodeIndex.get(id);
    if (i !== undefined) territories.add(graph.nodes[i]!.territoryId);
  }
  const weight = new Map<string, number>();
  for (const hit of result.hits)
    if (index.territories.has(hit.territoryId))
      weight.set(hit.territoryId, (weight.get(hit.territoryId) ?? 0) + Math.max(hit.score, 1e-6));
  let bestTerritoryId: string | null = null;
  let best = 0;
  for (const [id, w] of weight)
    if (w > best) {
      best = w;
      bestTerritoryId = id;
    }
  return { query, entry, lit, territories, approxTokens: result.approxTokens, bestTerritoryId };
}

/** Reveal state per mark: 0 dimmed, 1 on the path, 2 entry. Null when no
    reveal is active, meaning nothing dims. */
export function revealFlags(scene: MapScene, reveal: MapReveal | null): Uint8Array | null {
  if (reveal === null) return null;
  return Uint8Array.from(scene.marks, (mark) => {
    if (mark.kind === "node")
      return reveal.entry.has(mark.id) ? 2 : reveal.lit.has(mark.id) ? 1 : 0;
    if (mark.kind === "territory" || mark.kind === "stub")
      return reveal.territories.has(mark.id) ? 1 : 0;
    return 0;
  });
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** "2.1k" style token estimate. */
export function formatTokens(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}
