/**
 * demoState - the memory demo's in-memory state and its pure transitions.
 * `MemoryDemoStore` holds one `DemoState` in a Ref and publishes the returned
 * changes. The base warren is immutable; landings write an overlay on top of
 * it so a receipt can be reverted by restoring the overlay entries it touched.
 *
 * @module demoState
 */
import {
  MemoryDemoError,
  type ContributionCard,
  type ContributionPlan,
  type MemoryChange,
  type MemoryDen,
  type MemoryDenNode,
  type MemoryGraph,
  type MemoryGraphNode,
  type MemoryJudgments,
  type MemoryLandInput,
  type MemoryNodeDetail,
  type MemoryNodeType,
  type MemoryQueryInput,
  type MemoryQueryResult,
  type MemoryReceipt,
  type MemoryRecentQuery,
  type MemoryWriteInput,
  type ProjectId,
  type ThreadId,
} from "@lecturn/contracts";
import { DateTime, Schema } from "effect";
import {
  approxTokens,
  indexDoc,
  rankDocs,
  recallPath,
  type IndexedDoc,
  type LexicalDoc,
} from "./lexicalScore.ts";
import { denSeedIds, recordedJudgments, type SpikeFixture } from "./spikeFixture.ts";
import { deriveOp, findSecret, heuristicJudgments, tierFor } from "./tiering.ts";
import {
  fnv1a,
  jitterNear,
  slugify,
  territoryFor,
  territorySpec,
  TERRITORY_PAIRS,
  type Warren,
  type WarrenLayout,
} from "./warren.ts";

/** A warren node written by a landing: new, or a rewrite of an existing id. */
export interface OverlayNode {
  readonly id: string;
  readonly territoryId: string;
  readonly type: MemoryNodeType;
  readonly label: string;
  readonly summary: string;
  readonly context: string;
  readonly tags: readonly string[];
  readonly sourcePath: string | null;
  readonly score: number;
  readonly stale: boolean;
  readonly judgments: MemoryJudgments | null;
  /** Node whose position this one is drawn next to, if it has none of its own. */
  readonly anchorId: string | null;
}

export interface DenState {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly nodes: readonly MemoryDenNode[];
  readonly recentQueries: readonly MemoryRecentQuery[];
  /** Store revision of the last den content change; plans older than this are stale. */
  readonly changedAt: number;
}

interface ReceiptRecord {
  readonly receipt: MemoryReceipt;
  /** Overlay values before the landing; `undefined` means the id had no entry. */
  readonly overlayBefore: ReadonlyMap<string, OverlayNode | null | undefined>;
  readonly litBefore: ReadonlyMap<string, string | undefined>;
  /** Den nodes the landing removed (landed and silent). */
  readonly denRemoved: readonly MemoryDenNode[];
}

type Edge = readonly [a: string, b: string, receiptId: string];

interface PlanRecord {
  readonly plan: ContributionPlan;
  /** `DemoState.warrenRevision` when planned; a later land or revert makes the plan stale. */
  readonly warrenRevision: number;
}

export interface DemoState {
  readonly revision: number;
  readonly dens: ReadonlyMap<ProjectId, DenState>;
  /** Warren rewrites: a node, or null for a node removed by a supersede. */
  readonly overlay: ReadonlyMap<string, OverlayNode | null>;
  readonly extraEdges: readonly Edge[];
  /** Warren node id to the receipt that landed it. */
  readonly lit: ReadonlyMap<string, string>;
  /** Receipts in landing order. */
  readonly receipts: ReadonlyMap<string, ReceiptRecord>;
  readonly plans: ReadonlyMap<string, PlanRecord>;
  /** Store revision of the last land or revert. */
  readonly warrenRevision: number;
  readonly lastReceiptId: string | null;
  readonly recalledTerritories: ReadonlySet<string>;
}

export const initialState = (): DemoState => ({
  revision: 0,
  dens: new Map(),
  overlay: new Map(),
  extraEdges: [],
  lit: new Map(),
  receipts: new Map(),
  plans: new Map(),
  warrenRevision: 0,
  lastReceiptId: null,
  recalledTerritories: new Set(),
});

const fail = (code: MemoryDemoError["code"], message: string) =>
  new MemoryDemoError({ code, message });

export const isMemoryDemoError = Schema.is(MemoryDemoError);

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

// ---------------------------------------------------------------- warren view

/** A warren node as currently visible: base node with overlay applied. */
export interface EffectiveNode extends OverlayNode {
  readonly baseIndex: number | null;
}

/** Read access to the warren with the state's overlay applied. */
export class WarrenView {
  readonly warren: Warren;
  readonly state: DemoState;

  constructor(warren: Warren, state: DemoState) {
    this.warren = warren;
    this.state = state;
  }

  node(id: string): EffectiveNode | null {
    const baseIndex = this.warren.byId.get(id) ?? null;
    const overlay = this.state.overlay.get(id);
    if (overlay === null) return null;
    if (overlay) return { ...overlay, baseIndex };
    if (baseIndex === null) return null;
    const base = this.warren.nodes[baseIndex]!;
    return { ...base, anchorId: null, baseIndex };
  }

  neighborIds(id: string): string[] {
    const ids = new Set<string>();
    const baseIndex = this.warren.byId.get(id);
    if (baseIndex !== undefined) {
      for (const index of this.warren.adjacency[baseIndex]!) ids.add(this.warren.nodes[index]!.id);
    }
    for (const [a, b] of this.state.extraEdges) {
      if (a === id) ids.add(b);
      if (b === id) ids.add(a);
    }
    ids.delete(id);
    return [...ids].filter((neighbor) => this.state.overlay.get(neighbor) !== null);
  }

  /** Ids added by landings (not in the base warren). */
  addedIds(): string[] {
    return [...this.state.overlay]
      .filter(([id, node]) => node !== null && !this.warren.byId.has(id))
      .map(([id]) => id);
  }

  count(): number {
    let count = this.warren.nodes.length;
    for (const [id, node] of this.state.overlay) {
      const inBase = this.warren.byId.has(id);
      if (node === null && inBase) count--;
      if (node !== null && !inBase) count++;
    }
    return count;
  }

  has(id: string): boolean {
    return this.node(id) !== null;
  }
}

// ---------------------------------------------------------------- dens

function denNodeFromFixture(
  fixture: SpikeFixture,
  id: string,
  projectId: ProjectId,
  createdAt: string,
): MemoryDenNode | null {
  const node = fixture.nodes.find((candidate) => candidate.id === id);
  if (!node) return null;
  const targetId = fixture.placement.targets[id] ?? null;
  return {
    id: node.id,
    projectId,
    type: node.type,
    namespace: node.namespace,
    summary: node.summary,
    context: node.context,
    tags: node.tags,
    sourcePath: node.sourcePath,
    origin: "fixture",
    threadId: null,
    createdAt,
    targetId,
    judgments: recordedJudgments(fixture, node, targetId),
  };
}

/** Seeds a project's den with the 11 fixture nodes if it has never had one. */
export function ensureDen(
  state: DemoState,
  fixture: SpikeFixture,
  projectId: ProjectId,
  name: string,
  nowMs: number,
): DemoState {
  if (state.dens.has(projectId)) return state;
  const ids = denSeedIds(fixture);
  const nodes = ids.flatMap((id, i) => {
    // Stagger seeded writes over the last hour so the panel reads naturally.
    const createdAt = isoAt(nowMs - (ids.length - i) * 5 * 60_000);
    const node = denNodeFromFixture(fixture, id, projectId, createdAt);
    return node ? [node] : [];
  });
  const dens = new Map(state.dens);
  dens.set(projectId, { projectId, name, nodes, recentQueries: [], changedAt: state.revision });
  return { ...state, dens };
}

export function denView(state: DemoState, projectId: ProjectId): MemoryDen {
  const den = state.dens.get(projectId);
  return {
    projectId,
    name: den?.name ?? "den",
    revision: state.revision,
    nodes: den?.nodes ?? [],
    recentQueries: den?.recentQueries ?? [],
  };
}

function setDen(state: DemoState, den: DenState): Map<ProjectId, DenState> {
  const dens = new Map(state.dens);
  dens.set(den.projectId, den);
  return dens;
}

function denTerritory(node: MemoryDenNode): string {
  return territoryFor(node);
}

const KNOWN_NAMESPACES = new Set([
  "billing",
  "auth",
  "api",
  "web",
  "infra",
  "migrations",
  "team",
  "conventions",
  "webhooks",
]);

/** Appends a live-written node with heuristic judgments. */
export function writeDenNode(
  state: DemoState,
  view: WarrenView,
  input: MemoryWriteInput,
  source: { origin: "agent" | "simulated"; threadId: ThreadId | null },
  nowMs: number,
): readonly [MemoryDenNode, DemoState, MemoryChange] | MemoryDemoError {
  const summary = input.summary.trim();
  if (summary.length === 0) return fail("invalid", "A memory needs a summary.");
  const den = state.dens.get(input.projectId);
  if (!den) return fail("not-found", "No den for this project.");
  const tags = (input.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  const namespace = tags.map((tag) => tag.toLowerCase()).find((tag) => KNOWN_NAMESPACES.has(tag));
  const prefix = namespace ?? "agent";
  const slug = slugify(summary.split(/\s+/).slice(0, 8).join(" "), 48) || "note";
  const taken = (id: string) =>
    view.has(id) || [...state.dens.values()].some((d) => d.nodes.some((n) => n.id === id));
  let id = `${prefix}/${slug}`;
  for (let n = 2; taken(id); n++) id = `${prefix}/${slug}-${n}`;
  const context = input.context?.trim() ?? "";
  const sourcePath = input.sourcePath?.trim() || null;
  const node: MemoryDenNode = {
    id,
    projectId: input.projectId,
    type: input.type ?? "concept",
    namespace: prefix,
    summary,
    context,
    tags,
    sourcePath,
    origin: source.origin,
    threadId: source.threadId,
    createdAt: isoAt(nowMs),
    targetId: null,
    judgments: heuristicJudgments({ summary, context, sourcePath }),
  };
  const revision = state.revision + 1;
  const next: DemoState = {
    ...state,
    revision,
    dens: setDen(state, { ...den, nodes: [...den.nodes, node], changedAt: revision }),
  };
  return [node, next, { revision, kind: "den-write", projectId: input.projectId, nodeIds: [id] }];
}

export function removeDenNode(
  state: DemoState,
  projectId: ProjectId,
  nodeId: string,
): readonly [DemoState, MemoryChange] | MemoryDemoError {
  const den = state.dens.get(projectId);
  if (!den || !den.nodes.some((node) => node.id === nodeId)) {
    return fail("not-found", `No den node ${nodeId}.`);
  }
  const revision = state.revision + 1;
  const next: DemoState = {
    ...state,
    revision,
    dens: setDen(state, {
      ...den,
      nodes: den.nodes.filter((node) => node.id !== nodeId),
      changedAt: revision,
    }),
  };
  return [next, { revision, kind: "den-remove", projectId, nodeIds: [nodeId] }];
}

// ---------------------------------------------------------------- recall

/** Lexical docs for the base warren, built once per warren. */
export function indexBaseWarren(warren: Warren): IndexedDoc[] {
  return warren.nodes.map((node) =>
    indexDoc({
      id: node.id,
      scope: "warren",
      territoryId: node.territoryId,
      type: node.type,
      summary: node.summary,
      context: node.context,
      tags: node.tags,
      namespace: node.territoryId,
      weight: node.score,
    }),
  );
}

const DEFAULT_QUERY_LIMIT = 8;
const RECENT_QUERY_CAP = 10;

export function queryMemory(
  state: DemoState,
  view: WarrenView,
  baseIndex: readonly IndexedDoc[],
  input: MemoryQueryInput,
  nowMs: number,
): readonly [MemoryQueryResult, DemoState, MemoryChange | null] {
  const docs: IndexedDoc[] = [];
  for (const indexed of baseIndex) {
    if (!state.overlay.has(indexed.doc.id)) docs.push(indexed);
  }
  const overlayDoc = (node: EffectiveNode): LexicalDoc => ({
    id: node.id,
    scope: "warren",
    territoryId: node.territoryId,
    type: node.type,
    summary: node.summary,
    context: node.context,
    tags: node.tags,
    namespace: node.territoryId,
    weight: node.score,
  });
  for (const [id, node] of state.overlay) {
    if (node)
      docs.push(indexDoc(overlayDoc({ ...node, baseIndex: view.warren.byId.get(id) ?? null })));
  }
  const den = input.projectId === undefined ? undefined : state.dens.get(input.projectId);
  const denDocs = new Map<string, LexicalDoc>();
  for (const node of den?.nodes ?? []) {
    const doc: LexicalDoc = {
      id: node.id,
      scope: "den",
      territoryId: denTerritory(node),
      type: node.type,
      summary: node.summary,
      context: node.context,
      tags: node.tags,
      namespace: node.namespace,
      weight: 0,
    };
    denDocs.set(node.id, doc);
    docs.push(indexDoc(doc));
  }
  const ranked = rankDocs(docs, input.text).slice(0, input.limit ?? DEFAULT_QUERY_LIMIT);
  const docOf = (id: string): LexicalDoc | null => {
    const denDoc = denDocs.get(id);
    if (denDoc) return denDoc;
    const node = view.node(id);
    return node ? overlayDoc(node) : null;
  };
  const neighborsOf = (id: string): LexicalDoc[] => {
    const denNode = den?.nodes.find((node) => node.id === id);
    const ids = denNode ? (denNode.targetId ? [denNode.targetId] : []) : view.neighborIds(id);
    return ids.flatMap((neighbor) => {
      const doc = docOf(neighbor);
      return doc ? [doc] : [];
    });
  };
  const pathIds = recallPath(ranked, neighborsOf);
  const result: MemoryQueryResult = {
    hits: ranked.map((hit) => ({
      nodeId: hit.doc.id,
      scope: hit.doc.scope,
      territoryId: hit.doc.territoryId,
      type: hit.doc.type,
      summary: hit.doc.summary,
      score: Math.round(hit.score * 1000) / 1000,
      matched: hit.matched,
    })),
    pathIds,
    approxTokens: approxTokens(pathIds.flatMap((id) => docOf(id) ?? [])),
  };
  const recalledTerritories = new Set(state.recalledTerritories);
  for (const hit of ranked)
    if (hit.doc.scope === "warren") recalledTerritories.add(hit.doc.territoryId);
  if (!den) return [result, { ...state, recalledTerritories }, null];
  // Recording a recall is visible in the Memory panel, so it bumps the revision
  // (publishes den-write with no node ids) without touching the den's content.
  const revision = state.revision + 1;
  const recent: MemoryRecentQuery = {
    text: input.text,
    at: isoAt(nowMs),
    hitCount: ranked.length,
  };
  const next: DemoState = {
    ...state,
    revision,
    recalledTerritories,
    dens: setDen(state, {
      ...den,
      recentQueries: [recent, ...den.recentQueries].slice(0, RECENT_QUERY_CAP),
    }),
  };
  return [result, next, { revision, kind: "den-write", projectId: den.projectId, nodeIds: [] }];
}

// ---------------------------------------------------------------- gate

const TIER_ORDER = { review: 0, auto: 1, silent: 2 } as const;

function leaf(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

function cardFor(view: WarrenView, node: MemoryDenNode): ContributionCard {
  const target = node.targetId ? view.node(node.targetId) : null;
  const op = deriveOp(node, target, node.judgments);
  const { tier, flags } = tierFor({
    op,
    den: node,
    target: target && { id: target.id, summary: target.summary, context: target.context },
    judgments: node.judgments,
  });
  const territoryId = target ? target.territoryId : denTerritory(node);
  const landingId = op === "update" && target ? target.id : node.id;
  return {
    nodeId: node.id,
    op,
    tier,
    type: node.type,
    territoryId,
    destination: `${territorySpec(territoryId).label}/${leaf(landingId)}`,
    den: { summary: node.summary, context: node.context, sourcePath: node.sourcePath },
    target: target && { id: target.id, summary: target.summary, context: target.context },
    flags,
    judgments: node.judgments,
  };
}

export function planDen(
  state: DemoState,
  view: WarrenView,
  projectId: ProjectId,
): readonly [ContributionPlan, DemoState] {
  const den = state.dens.get(projectId);
  const cards = (den?.nodes ?? [])
    .map((node) => cardFor(view, node))
    .map((card, index) => ({ card, index }))
    .sort((a, b) => TIER_ORDER[a.card.tier] - TIER_ORDER[b.card.tier] || a.index - b.index)
    .map(({ card }) => card);
  const counts = { silent: 0, auto: 0, review: 0 };
  for (const card of cards) counts[card.tier]++;
  const planId = `plan-${state.revision}-${(fnv1a(`${projectId}:${state.plans.size}`) >>> 0).toString(16)}`;
  const plan: ContributionPlan = { planId, projectId, denRevision: state.revision, cards, counts };
  const plans = new Map(state.plans);
  plans.set(planId, { plan, warrenRevision: state.warrenRevision });
  return [plan, { ...state, plans }];
}

/** 7-hex receipt id: FNV-1a of plan id and landing time. */
export function receiptIdFor(
  planId: string,
  nowMs: number,
  taken: (id: string) => boolean,
): string {
  for (let salt = 0; ; salt++) {
    const id = fnv1a(`${planId}:${nowMs}:${salt}`).toString(16).padStart(8, "0").slice(0, 7);
    if (!taken(id)) return id;
  }
}

const unionTags = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

export function landPlan(
  state: DemoState,
  view: WarrenView,
  layoutScore: (territoryId: string) => number,
  input: MemoryLandInput,
  nowMs: number,
): readonly [MemoryReceipt, DemoState, MemoryChange] | MemoryDemoError {
  // A missing plan was dropped by a reset or a landing; re-planning recovers either way.
  const planned = state.plans.get(input.planId);
  if (!planned) return fail("stale-plan", "That Gate plan no longer exists. Review the den again.");
  const { plan } = planned;
  if (plan.projectId !== input.projectId)
    return fail("invalid", "The plan is for another project.");
  const den = state.dens.get(input.projectId);
  if (!den || den.changedAt > plan.denRevision) {
    return fail("stale-plan", "The den changed since this plan was made. Review it again.");
  }
  if (state.warrenRevision > planned.warrenRevision) {
    return fail("stale-plan", "The warren changed since this plan was made. Review it again.");
  }
  const verdicts = new Map(input.verdicts.map((verdict) => [verdict.nodeId, verdict]));
  for (const verdict of input.verdicts) {
    if (verdict.verdict === "edit" && !verdict.summary?.trim()) {
      return fail("invalid", `Edit on ${verdict.nodeId} needs a summary.`);
    }
  }

  const receiptId = receiptIdFor(plan.planId, nowMs, (id) => state.receipts.has(id));
  const overlay = new Map(state.overlay);
  const lit = new Map(state.lit);
  const overlayBefore = new Map<string, OverlayNode | null | undefined>();
  const litBefore = new Map<string, string | undefined>();
  const edges: Edge[] = [];
  const setOverlay = (id: string, node: OverlayNode | null) => {
    if (!overlayBefore.has(id))
      overlayBefore.set(id, state.overlay.has(id) ? state.overlay.get(id) : undefined);
    overlay.set(id, node);
  };
  const light = (id: string) => {
    if (!litBefore.has(id)) litBefore.set(id, state.lit.get(id));
    lit.set(id, receiptId);
  };
  const liveView = () => new WarrenView(view.warren, { ...state, overlay });
  const freeId = (id: string) => {
    let candidate = id;
    for (let n = 2; liveView().has(candidate); n++) candidate = `${id}-${n}`;
    return candidate;
  };

  const counts = { added: 0, updated: 0, superseded: 0, merged: 0, distinct: 0, skipped: 0 };
  const landedNodeIds: string[] = [];
  const skippedNodeIds: string[] = [];
  const removed: MemoryDenNode[] = [];
  const grown = new Map<string, number>();
  const grow = (territoryId: string) => grown.set(territoryId, (grown.get(territoryId) ?? 0) + 1);

  for (const card of plan.cards) {
    const node = den.nodes.find((candidate) => candidate.id === card.nodeId);
    if (!node) continue;
    if (card.op === "noop") {
      removed.push(node);
      continue;
    }
    const explicit = verdicts.get(card.nodeId);
    const verdict = explicit?.verdict ?? (card.tier === "review" ? "skip" : "accept");
    if (verdict === "skip") {
      counts.skipped++;
      skippedNodeIds.push(node.id);
      continue;
    }
    const target = node.targetId ? liveView().node(node.targetId) : null;
    const summary = verdict === "edit" ? explicit!.summary!.trim() : node.summary;
    // The Gate blocks these too; this holds for any caller. Edit only rewrites the summary.
    const leakedSummary = findSecret(summary);
    if (leakedSummary)
      return fail("invalid", `${node.id} still looks like it contains ${leakedSummary}.`);
    const leakedContext = findSecret(node.context);
    if (leakedContext)
      return fail(
        "invalid",
        `${node.id} has ${leakedContext} in its body; skip this node to keep it in the den.`,
      );
    const asOverlay = (
      id: string,
      territoryId: string,
      anchorId: string | null,
      score: number,
    ): OverlayNode => ({
      id,
      territoryId,
      type: node.type,
      label: id.slice(0, 80),
      summary,
      context: node.context,
      tags: node.tags,
      sourcePath: node.sourcePath,
      score,
      stale: false,
      judgments: node.judgments,
      anchorId,
    });
    const addNew = (anchor: EffectiveNode | null) => {
      const territoryId = anchor?.territoryId ?? card.territoryId;
      const id = freeId(node.id);
      setOverlay(
        id,
        asOverlay(id, territoryId, anchor?.id ?? null, anchor?.score ?? layoutScore(territoryId)),
      );
      light(id);
      grow(territoryId);
      return id;
    };

    if ((verdict === "merge" || verdict === "distinct") && !target) {
      return fail("invalid", `${node.id} has no warren node to ${verdict} with.`);
    }
    if (verdict === "merge" && target) {
      const appended = [summary, node.context].filter((part) => part.trim().length > 0).join("\n");
      setOverlay(target.id, {
        ...target,
        context: target.context.trim().length > 0 ? `${target.context}\n\n${appended}` : appended,
        tags: unionTags(target.tags, node.tags),
      });
      light(target.id);
      grow(target.territoryId);
      counts.merged++;
    } else if (verdict === "distinct" && target) {
      const id = addNew(target);
      edges.push([id, target.id, receiptId]);
      counts.distinct++;
    } else {
      // accept / edit: the op follows the (possibly edited) text.
      const op = target
        ? deriveOp({ summary, context: node.context }, target, node.judgments)
        : "add";
      if (!target || op === "add") {
        addNew(null);
        counts.added++;
      } else if (op === "update" || op === "noop") {
        setOverlay(target.id, {
          ...target,
          summary,
          context: node.context,
          tags: unionTags(target.tags, node.tags),
          sourcePath: node.sourcePath ?? target.sourcePath,
          judgments: node.judgments,
        });
        light(target.id);
        grow(target.territoryId);
        counts.updated++;
      } else {
        const neighbors = liveView().neighborIds(target.id);
        setOverlay(target.id, null);
        const id = freeId(node.id);
        setOverlay(id, asOverlay(id, target.territoryId, target.id, target.score));
        for (const neighbor of neighbors) edges.push([id, neighbor, receiptId]);
        light(id);
        grow(target.territoryId);
        counts.superseded++;
      }
    }
    landedNodeIds.push(node.id);
    removed.push(node);
  }

  const revision = state.revision + 1;
  const removedIds = new Set(removed.map((node) => node.id));
  const receipt: MemoryReceipt = {
    id: receiptId,
    projectId: input.projectId,
    at: isoAt(nowMs),
    counts,
    landedNodeIds,
    skippedNodeIds,
    territoriesGrown: [...grown]
      .map(([territoryId, count]) => ({ territoryId, count }))
      .sort((a, b) => b.count - a.count || a.territoryId.localeCompare(b.territoryId)),
    reverted: false,
  };
  const receipts = new Map(state.receipts);
  receipts.set(receiptId, { receipt, overlayBefore, litBefore, denRemoved: removed });
  const plans = new Map(state.plans);
  plans.delete(plan.planId);
  const next: DemoState = {
    ...state,
    revision,
    overlay,
    lit,
    extraEdges: [...state.extraEdges, ...edges],
    receipts,
    plans,
    warrenRevision: revision,
    lastReceiptId: receiptId,
    dens: setDen(state, {
      ...den,
      nodes: den.nodes.filter((node) => !removedIds.has(node.id)),
      changedAt: revision,
    }),
  };
  return [
    receipt,
    next,
    { revision, kind: "land", projectId: input.projectId, nodeIds: landedNodeIds },
  ];
}

export function revertReceipt(
  state: DemoState,
  receiptId: string,
): readonly [MemoryReceipt, DemoState, MemoryChange | null] | MemoryDemoError {
  const record = state.receipts.get(receiptId);
  if (!record) return fail("not-found", `No receipt ${receiptId}.`);
  if (record.receipt.reverted) return fail("invalid", `Receipt ${receiptId} is already reverted.`);
  // Restoring `overlayBefore` under a later landing that touched the same nodes
  // would drop that landing's writes, so those must be reverted first.
  const touched = (other: ReceiptRecord) =>
    [...other.overlayBefore.keys()].some((id) => record.overlayBefore.has(id));
  const later = [...state.receipts.values()].slice(
    [...state.receipts.keys()].indexOf(receiptId) + 1,
  );
  const blocking = later.findLast((other) => !other.receipt.reverted && touched(other));
  if (blocking) {
    return fail(
      "invalid",
      `Revert ${blocking.receipt.id} first; it landed on the same nodes later.`,
    );
  }
  const overlay = new Map(state.overlay);
  for (const [id, before] of record.overlayBefore) {
    if (before === undefined) overlay.delete(id);
    else overlay.set(id, before);
  }
  const lit = new Map(state.lit);
  for (const [id, before] of record.litBefore) {
    if (before === undefined) lit.delete(id);
    else lit.set(id, before);
  }
  const projectId = record.receipt.projectId;
  const den = state.dens.get(projectId);
  const revision = state.revision + 1;
  const current = den?.nodes ?? [];
  const currentIds = new Set(current.map((node) => node.id));
  const restored = record.denRemoved.filter((node) => !currentIds.has(node.id));
  const receipt: MemoryReceipt = { ...record.receipt, reverted: true };
  const receipts = new Map(state.receipts);
  receipts.set(receiptId, { ...record, receipt });
  const next: DemoState = {
    ...state,
    revision,
    overlay,
    lit,
    extraEdges: state.extraEdges.filter(([, , owner]) => owner !== receiptId),
    receipts,
    warrenRevision: revision,
    dens: setDen(state, {
      projectId,
      name: den?.name ?? "den",
      recentQueries: den?.recentQueries ?? [],
      nodes: [...restored, ...current],
      changedAt: revision,
    }),
  };
  return [
    receipt,
    next,
    { revision, kind: "revert", projectId, nodeIds: record.receipt.landedNodeIds },
  ];
}

// ---------------------------------------------------------------- map

const ORIGIN = { x: 0, y: 0 };
/** Floor for how close a landed node may sit to another mark in its territory. */
const LANDED_GAP = 40;

/** Median nearest-neighbour distance among `points`, the territory's own spacing. */
function typicalSpacing(points: ReadonlyArray<{ x: number; y: number }>): number {
  const nearest = points.map((p) =>
    Math.min(...points.filter((q) => q !== p).map((q) => Math.hypot(p.x - q.x, p.y - q.y))),
  );
  nearest.sort((a, b) => a - b);
  const median = nearest[Math.floor(nearest.length / 2)];
  return median !== undefined && Number.isFinite(median) ? median : LANDED_GAP;
}

/** The first spot on a spiral out from `anchor` (starting at a hashed angle) that
    keeps `gap` from every placed mark. Un-anchored nodes land at the territory
    centre, among the hub nodes, and the map scales each territory by its own
    spacing, so a fixed small offset would draw them on top of their neighbours. */
function openSpotNear(
  anchor: { x: number; y: number },
  id: string,
  placed: ReadonlyArray<{ x: number; y: number }>,
  gap: number,
): { x: number; y: number } {
  const hashed = jitterNear(anchor, id);
  const base = Math.atan2(hashed.y - anchor.y, hashed.x - anchor.x);
  const clear = (p: { x: number; y: number }) =>
    placed.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= gap);
  for (let k = 0; k < 400; k++) {
    const angle = base + k * 2.4;
    const radius = gap * (0.9 + k * 0.12);
    const p = { x: anchor.x + Math.cos(angle) * radius, y: anchor.y + Math.sin(angle) * radius };
    if (clear(p)) return p;
  }
  return hashed;
}

export function buildGraph(view: WarrenView, layout: WarrenLayout): MemoryGraph {
  const { warren, state } = view;
  const nodes: MemoryGraphNode[] = [];
  const counts = new Map(warren.territories.map((t) => [t.spec.id, t.nodeIndexes.length]));
  for (const [id, node] of state.overlay) {
    const baseIndex = warren.byId.get(id);
    if (node === null && baseIndex !== undefined) {
      const territoryId = warren.nodes[baseIndex]!.territoryId;
      counts.set(territoryId, (counts.get(territoryId) ?? 1) - 1);
    }
    if (node !== null && baseIndex === undefined) {
      counts.set(node.territoryId, (counts.get(node.territoryId) ?? 0) + 1);
    }
  }
  const positionOf = (id: string): { x: number; y: number } | null => {
    const baseIndex = warren.byId.get(id);
    return baseIndex === undefined ? null : (layout.nodes.get(baseIndex) ?? null);
  };
  // Positions are relative to each territory's centre, so overlap checks stay per territory.
  const placed = new Map<string, Array<{ x: number; y: number }>>();
  const pushNode = (node: EffectiveNode, position: { x: number; y: number }) => {
    const list = placed.get(node.territoryId);
    if (list) list.push(position);
    else placed.set(node.territoryId, [position]);
    nodes.push({
      id: node.id,
      territoryId: node.territoryId,
      type: node.type,
      label: node.label.slice(0, 80),
      score: Math.round(node.score * 100) / 100,
      x: Math.round(position.x * 10) / 10,
      y: Math.round(position.y * 10) / 10,
      stale: node.stale,
      landedReceiptId: state.lit.get(node.id) ?? null,
    });
  };
  for (const territory of warren.territories) {
    for (const index of territory.top) {
      const node = view.node(warren.nodes[index]!.id);
      if (node) pushNode(node, layout.nodes.get(index) ?? ORIGIN);
    }
  }
  const spacing = new Map(
    [...placed].map(([territoryId, points]) => [
      territoryId,
      Math.max(LANDED_GAP, typicalSpacing(points) * 0.75),
    ]),
  );
  for (const id of view.addedIds()) {
    const node = view.node(id);
    if (!node) continue;
    const anchor = (node.anchorId && positionOf(node.anchorId)) || ORIGIN;
    pushNode(
      node,
      openSpotNear(
        anchor,
        id,
        placed.get(node.territoryId) ?? [],
        spacing.get(node.territoryId) ?? LANDED_GAP,
      ),
    );
  }
  const indexById = new Map(nodes.map((node, i) => [node.id, i]));
  const edges: Array<readonly [number, number]> = [];
  nodes.forEach((node, i) => {
    for (const neighbor of view.neighborIds(node.id)) {
      const j = indexById.get(neighbor);
      if (j !== undefined && j > i) edges.push([i, j]);
    }
  });
  return {
    revision: state.revision,
    territories: warren.territories.map((territory) => {
      const centre = layout.territories.get(territory.spec.id) ?? ORIGIN;
      return {
        id: territory.spec.id,
        label: territory.spec.label,
        project: territory.spec.project,
        nodeCount: Math.max(0, counts.get(territory.spec.id) ?? 0),
        dominantType: territory.spec.dom,
        recalled: state.recalledTerritories.has(territory.spec.id),
        x: Math.round(centre.x * 10) / 10,
        y: Math.round(centre.y * 10) / 10,
      };
    }),
    territoryEdges: TERRITORY_PAIRS.map(([a, b, weight]) => ({ a, b, weight })),
    nodes,
    edges,
  };
}

const NEIGHBOR_CAP = 8;

export function nodeDetail(
  view: WarrenView,
  fixture: SpikeFixture,
  nodeId: string,
): MemoryNodeDetail | MemoryDemoError {
  const warrenNode = view.node(nodeId);
  if (warrenNode) {
    const neighbors = view
      .neighborIds(nodeId)
      .flatMap((id) => view.node(id) ?? [])
      .sort((a, b) => b.score - a.score)
      .slice(0, NEIGHBOR_CAP)
      .map((node) => ({ id: node.id, summary: node.summary }));
    return {
      id: warrenNode.id,
      scope: "warren",
      territoryId: warrenNode.territoryId,
      type: warrenNode.type,
      summary: warrenNode.summary,
      context: warrenNode.context,
      tags: warrenNode.tags,
      sourcePath: warrenNode.sourcePath,
      neighbors,
      judgments: warrenNode.judgments,
      landedReceiptId: view.state.lit.get(nodeId) ?? null,
    };
  }
  for (const den of view.state.dens.values()) {
    const node = den.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) continue;
    const linked = [
      ...(node.targetId ? [node.targetId] : []),
      ...(fixture.nodes.find((candidate) => candidate.id === nodeId)?.edges.map((e) => e.target) ??
        []),
    ];
    const neighbors = [...new Set(linked)]
      .flatMap((id) => view.node(id) ?? [])
      .map((neighbor) => ({ id: neighbor.id, summary: neighbor.summary }));
    return {
      id: node.id,
      scope: "den",
      territoryId: node.targetId
        ? (view.node(node.targetId)?.territoryId ?? denTerritory(node))
        : denTerritory(node),
      type: node.type,
      summary: node.summary,
      context: node.context,
      tags: node.tags,
      sourcePath: node.sourcePath,
      neighbors,
      judgments: node.judgments,
      landedReceiptId: null,
    };
  }
  return fail("not-found", `No memory node ${nodeId}.`);
}

/** Score for a landed node without a target: middle of its territory's top 40. */
export function landingScore(warren: Warren, territoryId: string): number {
  const territory = warren.territories.find((t) => t.spec.id === territoryId);
  const top = territory?.top ?? [];
  const middle = top[Math.floor(top.length / 2)];
  return middle === undefined ? 10 : warren.nodes[middle]!.score;
}
