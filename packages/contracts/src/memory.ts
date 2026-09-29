import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/* Memory demo (LECTURN_MEMORY_DEMO). Agents write facts into a per-project
   den; the Contribution Gate reviews a den and lands it into the shared warren. */

/** Warren or den node id, e.g. `billing/event-ledger`. */
export const MemoryNodeId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
/** Territory (warren cluster) id, e.g. `webhooks`. */
export const MemoryTerritoryId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
/** Short lowercase hex id shown to users as "Landed a3f9c2e". */
export const MemoryReceiptId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7}$/));
export type MemoryReceiptId = typeof MemoryReceiptId.Type;
/** Server-issued id for one Contribution Gate plan; land must echo it. */
export const MemoryPlanId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/** Kind of code or knowledge a node describes. */
export const MemoryNodeType = Schema.Literals([
  "function",
  "module",
  "class",
  "interface",
  "concept",
  "decision",
  "reference",
  "composite",
]);
export type MemoryNodeType = typeof MemoryNodeType.Type;

/** Outcome of one standard applied to one node. */
export const MemoryStandardVerdict = Schema.Literals(["pass", "uncertain", "fail"]);
export type MemoryStandardVerdict = typeof MemoryStandardVerdict.Type;

const standardFields = {
  /** Standard id, e.g. `S1`. */
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
  title: Schema.String.check(Schema.isMaxLength(200)),
};
/** One standard judgment. `noul` is a yes/no probability, `score` a 0..N rating,
    `choice` a pick among labelled options (no verdict of its own). */
export const MemoryStandardJudgment = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("noul"),
    ...standardFields,
    p: Probability,
    verdict: MemoryStandardVerdict,
  }),
  Schema.Struct({
    kind: Schema.Literal("score"),
    ...standardFields,
    score: Schema.Finite,
    confidence: Probability,
    verdict: MemoryStandardVerdict,
  }),
  Schema.Struct({
    kind: Schema.Literal("choice"),
    ...standardFields,
    choice: Schema.String.check(Schema.isMaxLength(200)),
    confidence: Probability,
  }),
]);
export type MemoryStandardJudgment = typeof MemoryStandardJudgment.Type;

/** Duplicate relation between a node and its closest warren node. */
export const MemoryDuplicateLevel = Schema.Literals(["same", "related", "different"]);
export type MemoryDuplicateLevel = typeof MemoryDuplicateLevel.Type;
export const MemoryDuplicateJudgment = Schema.Struct({
  targetId: MemoryNodeId,
  level: MemoryDuplicateLevel,
  probabilities: Schema.Struct({
    different: Probability,
    related: Probability,
    same: Probability,
  }),
});
export type MemoryDuplicateJudgment = typeof MemoryDuplicateJudgment.Type;

/** All judgments for a node. `recorded-jev` replays synthetic spike data
    (`model` names the Jev build); `heuristic` is computed locally (`model` null). */
export const MemoryJudgments = Schema.Struct({
  method: Schema.Literals(["recorded-jev", "heuristic"]),
  model: Schema.NullOr(Schema.String),
  standards: Schema.Array(MemoryStandardJudgment),
  duplicate: Schema.NullOr(MemoryDuplicateJudgment),
});
export type MemoryJudgments = typeof MemoryJudgments.Type;

/** Where a den node came from: seeded fixture, an agent's memory_write, or the
    palette "simulate agent write" / memory.write RPC. */
export const MemoryNodeOrigin = Schema.Literals(["fixture", "agent", "simulated"]);
export type MemoryNodeOrigin = typeof MemoryNodeOrigin.Type;

/** A pending, project-local node waiting for the Contribution Gate.
    `targetId` is the warren node it would update or supersede, if any. */
export const MemoryDenNode = Schema.Struct({
  id: MemoryNodeId,
  projectId: ProjectId,
  type: MemoryNodeType,
  namespace: Schema.String,
  summary: Schema.String,
  context: Schema.String,
  tags: Schema.Array(Schema.String),
  sourcePath: Schema.NullOr(Schema.String),
  origin: MemoryNodeOrigin,
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  targetId: Schema.NullOr(MemoryNodeId),
  judgments: MemoryJudgments,
});
export type MemoryDenNode = typeof MemoryDenNode.Type;

/** A recent memory_query against this project, newest first. */
export const MemoryRecentQuery = Schema.Struct({
  text: Schema.String,
  at: IsoDateTime,
  hitCount: NonNegativeInt,
});
export type MemoryRecentQuery = typeof MemoryRecentQuery.Type;

/** A project's den. `revision` is the store-wide revision at read time. */
export const MemoryDen = Schema.Struct({
  projectId: ProjectId,
  name: Schema.String,
  revision: NonNegativeInt,
  nodes: Schema.Array(MemoryDenNode),
  recentQueries: Schema.Array(MemoryRecentQuery),
});
export type MemoryDen = typeof MemoryDen.Type;

/** Result of landing a plan. Reverting marks it `reverted` and returns the
    landed nodes to the den. */
export const MemoryReceipt = Schema.Struct({
  id: MemoryReceiptId,
  projectId: ProjectId,
  at: IsoDateTime,
  counts: Schema.Struct({
    added: NonNegativeInt,
    updated: NonNegativeInt,
    superseded: NonNegativeInt,
    merged: NonNegativeInt,
    distinct: NonNegativeInt,
    skipped: NonNegativeInt,
  }),
  landedNodeIds: Schema.Array(MemoryNodeId),
  skippedNodeIds: Schema.Array(MemoryNodeId),
  territoriesGrown: Schema.Array(
    Schema.Struct({ territoryId: MemoryTerritoryId, count: NonNegativeInt }),
  ),
  reverted: Schema.Boolean,
});
export type MemoryReceipt = typeof MemoryReceipt.Type;

/** Cheap summary for badges: pending den counts per project and warren size. */
export const MemoryStatus = Schema.Struct({
  pending: Schema.Array(Schema.Struct({ projectId: ProjectId, count: NonNegativeInt })),
  warrenNodes: NonNegativeInt,
  lastReceipt: Schema.NullOr(MemoryReceipt),
});
export type MemoryStatus = typeof MemoryStatus.Type;

/** A warren cluster drawn as one mark at the top map level. `recalled` is true
    when a recent query hit it. `x`/`y` are layout units, not pixels. */
export const MemoryTerritory = Schema.Struct({
  id: MemoryTerritoryId,
  label: Schema.String.check(Schema.isMaxLength(80)),
  project: Schema.String,
  nodeCount: NonNegativeInt,
  dominantType: MemoryNodeType,
  recalled: Schema.Boolean,
  x: Schema.Finite,
  y: Schema.Finite,
});
export type MemoryTerritory = typeof MemoryTerritory.Type;
export const MemoryTerritoryEdge = Schema.Struct({
  a: MemoryTerritoryId,
  b: MemoryTerritoryId,
  weight: Schema.Finite,
});
export type MemoryTerritoryEdge = typeof MemoryTerritoryEdge.Type;
/** A warren node shipped to the map. `landedReceiptId` marks nodes landed by
    a (non-reverted) receipt so the map can light them. */
export const MemoryGraphNode = Schema.Struct({
  id: MemoryNodeId,
  territoryId: MemoryTerritoryId,
  type: MemoryNodeType,
  label: Schema.String.check(Schema.isMaxLength(80)),
  score: Schema.Finite,
  x: Schema.Finite,
  y: Schema.Finite,
  stale: Schema.Boolean,
  landedReceiptId: Schema.NullOr(MemoryReceiptId),
});
export type MemoryGraphNode = typeof MemoryGraphNode.Type;
/** Map payload: up to 40 top nodes per territory plus every landed node.
    `edges` are `[i, j]` indexes into `nodes`. Fetched on demand only. */
export const MemoryGraph = Schema.Struct({
  revision: NonNegativeInt,
  territories: Schema.Array(MemoryTerritory),
  territoryEdges: Schema.Array(MemoryTerritoryEdge),
  nodes: Schema.Array(MemoryGraphNode),
  edges: Schema.Array(Schema.Tuple([NonNegativeInt, NonNegativeInt])),
});
export type MemoryGraph = typeof MemoryGraph.Type;

/** Which store a node lives in. */
export const MemoryNodeScope = Schema.Literals(["warren", "den"]);
export type MemoryNodeScope = typeof MemoryNodeScope.Type;

/** Full node for the node sheet, warren or den. */
export const MemoryNodeDetail = Schema.Struct({
  id: MemoryNodeId,
  scope: MemoryNodeScope,
  territoryId: MemoryTerritoryId,
  type: MemoryNodeType,
  summary: Schema.String,
  context: Schema.String,
  tags: Schema.Array(Schema.String),
  sourcePath: Schema.NullOr(Schema.String),
  neighbors: Schema.Array(Schema.Struct({ id: MemoryNodeId, summary: Schema.String })),
  judgments: Schema.NullOr(MemoryJudgments),
  landedReceiptId: Schema.NullOr(MemoryReceiptId),
});
export type MemoryNodeDetail = typeof MemoryNodeDetail.Type;

/** Payload of memory.den. */
export const MemoryDenInput = Schema.Struct({ projectId: ProjectId });
export type MemoryDenInput = typeof MemoryDenInput.Type;
/** Payload of memory.node. */
export const MemoryNodeInput = Schema.Struct({ nodeId: MemoryNodeId });
export type MemoryNodeInput = typeof MemoryNodeInput.Type;

/** Lexical recall. With `projectId` the project's den is searched alongside the
    warren; `limit` defaults server-side. */
export const MemoryQueryInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});
export type MemoryQueryInput = typeof MemoryQueryInput.Type;
/** One recall hit. `matched` lists the query terms that matched. */
export const MemoryQueryHit = Schema.Struct({
  nodeId: MemoryNodeId,
  scope: MemoryNodeScope,
  territoryId: MemoryTerritoryId,
  type: MemoryNodeType,
  summary: Schema.String,
  score: Schema.Finite,
  matched: Schema.Array(Schema.String),
});
export type MemoryQueryHit = typeof MemoryQueryHit.Type;
/** Hits, ranked. `pathIds` are hits plus best 1-hop neighbors (map lights
    these); `approxTokens` estimates the recalled text size (chars / 4). */
export const MemoryQueryResult = Schema.Struct({
  hits: Schema.Array(MemoryQueryHit),
  pathIds: Schema.Array(MemoryNodeId),
  approxTokens: NonNegativeInt,
});
export type MemoryQueryResult = typeof MemoryQueryResult.Type;

/** Record one fact into a project's den. `type` defaults to `concept`. */
export const MemoryWriteInput = Schema.Struct({
  projectId: ProjectId,
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  context: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  type: Schema.optionalKey(MemoryNodeType),
  tags: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(Schema.isMaxLength(8)),
  ),
  sourcePath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
});
export type MemoryWriteInput = typeof MemoryWriteInput.Type;
/** Drop one node from a den without landing it. */
export const MemoryRemoveDenNodeInput = Schema.Struct({
  projectId: ProjectId,
  nodeId: MemoryNodeId,
});
export type MemoryRemoveDenNodeInput = typeof MemoryRemoveDenNodeInput.Type;

/** Why a card needs attention. `reason` is user-facing copy. */
export const ContributionFlag = Schema.Struct({
  kind: Schema.Literals([
    "secret-suspect",
    "duplicate-suspect",
    "destructive-diff",
    "standard-fail",
    "standard-uncertain",
    "heuristic",
  ]),
  reason: Schema.String,
});
export type ContributionFlag = typeof ContributionFlag.Type;
/** What landing this card does to the warren. */
export const ContributionOp = Schema.Literals(["add", "update", "supersede", "noop"]);
export type ContributionOp = typeof ContributionOp.Type;
/** `silent` lands unseen (noop), `auto` lands unless skipped, `review` needs a verdict. */
export const ContributionTier = Schema.Literals(["silent", "auto", "review"]);
export type ContributionTier = typeof ContributionTier.Type;
/** One den node as the Gate shows it. `destination` is the warren path it lands
    at; `target` is the existing warren node for update/supersede/duplicate. */
export const ContributionCard = Schema.Struct({
  nodeId: MemoryNodeId,
  op: ContributionOp,
  tier: ContributionTier,
  type: MemoryNodeType,
  territoryId: MemoryTerritoryId,
  destination: Schema.String,
  den: Schema.Struct({
    summary: Schema.String,
    context: Schema.String,
    sourcePath: Schema.NullOr(Schema.String),
  }),
  target: Schema.NullOr(
    Schema.Struct({ id: MemoryNodeId, summary: Schema.String, context: Schema.String }),
  ),
  flags: Schema.Array(ContributionFlag),
  judgments: MemoryJudgments,
});
export type ContributionCard = typeof ContributionCard.Type;
/** Payload of memory.plan. */
export const MemoryPlanInput = Schema.Struct({ projectId: ProjectId });
export type MemoryPlanInput = typeof MemoryPlanInput.Type;
/** A Gate plan for one den at `denRevision`. Landing fails `stale-plan` if the
    den changed since. Cards are ordered review, auto, silent. */
export const ContributionPlan = Schema.Struct({
  planId: MemoryPlanId,
  projectId: ProjectId,
  denRevision: NonNegativeInt,
  cards: Schema.Array(ContributionCard),
  counts: Schema.Struct({
    silent: NonNegativeInt,
    auto: NonNegativeInt,
    review: NonNegativeInt,
  }),
});
export type ContributionPlan = typeof ContributionPlan.Type;

/** Gate verdict per card: accept (A), skip (S), edit (E, with `summary`),
    merge into target (M), keep distinct from target (D). */
export const MemoryVerdict = Schema.Literals(["accept", "skip", "edit", "merge", "distinct"]);
export type MemoryVerdict = typeof MemoryVerdict.Type;
export const MemoryCardVerdict = Schema.Struct({
  nodeId: MemoryNodeId,
  verdict: MemoryVerdict,
  /** Replacement summary; required by the server when `verdict` is `edit`. */
  summary: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400))),
});
export type MemoryCardVerdict = typeof MemoryCardVerdict.Type;
/** Land a plan. Cards without a verdict land by tier (auto/silent accept). */
export const MemoryLandInput = Schema.Struct({
  projectId: ProjectId,
  planId: MemoryPlanId,
  verdicts: Schema.Array(MemoryCardVerdict),
});
export type MemoryLandInput = typeof MemoryLandInput.Type;
/** Undo a landed receipt. */
export const MemoryRevertInput = Schema.Struct({ receiptId: MemoryReceiptId });
export type MemoryRevertInput = typeof MemoryRevertInput.Type;

/** Pushed on memory.subscribe after every store mutation. `projectId` is null
    for store-wide changes (reset). Clients refetch what the revision touches. */
export const MemoryChange = Schema.Struct({
  revision: NonNegativeInt,
  kind: Schema.Literals(["den-write", "den-remove", "land", "revert", "reset"]),
  projectId: Schema.NullOr(ProjectId),
  nodeIds: Schema.Array(MemoryNodeId),
});
export type MemoryChange = typeof MemoryChange.Type;

/** `disabled` when the server runs without LECTURN_MEMORY_DEMO. */
export class MemoryDemoError extends Schema.TaggedErrorClass<MemoryDemoError>()("MemoryDemoError", {
  code: Schema.Literals(["disabled", "not-found", "invalid", "stale-plan"]),
  message: Schema.String,
}) {}
