/**
 * spikeFixture - decoded view of `fixtures/jevSpike.json`, the recorded
 * (synthetic) Jev judgments from the memory-standards spike. Fixture nodes in
 * `placement.denReview` / `placement.denAuto` seed every den; all other nodes
 * seed the warren. Decoded once, on first use.
 *
 * @module spikeFixture
 */
import {
  MemoryNodeType,
  type MemoryDuplicateJudgment,
  type MemoryDuplicateLevel,
  type MemoryJudgments,
  type MemoryStandardJudgment,
  type MemoryStandardVerdict,
} from "@lecturn/contracts";
import { Schema } from "effect";
import fixtureJson from "./fixtures/jevSpike.json" with { type: "json" };

const FixtureJudgment = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("noul"), p: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("score"), score: Schema.Finite, confidence: Schema.Finite }),
  Schema.Struct({
    kind: Schema.Literal("choice"),
    choice: Schema.String,
    confidence: Schema.Finite,
  }),
]);

const FixtureNode = Schema.Struct({
  id: Schema.String,
  type: MemoryNodeType,
  namespace: Schema.String,
  summary: Schema.String,
  context: Schema.String,
  tags: Schema.Array(Schema.String),
  sourcePath: Schema.NullOr(Schema.String),
  edges: Schema.Array(Schema.Struct({ target: Schema.String, relation: Schema.String })),
  pairOnly: Schema.Boolean,
  judgments: Schema.Record(Schema.String, FixtureJudgment),
});
export type FixtureNode = typeof FixtureNode.Type;

const PairSide = Schema.Struct({
  id: Schema.String,
  type: MemoryNodeType,
  summary: Schema.String,
  context: Schema.String,
});

const FixturePair = Schema.Struct({
  id: Schema.String,
  a: PairSide,
  b: PairSide,
  d1: Schema.Struct({
    score: Schema.Finite,
    confidence: Schema.Finite,
    probabilities: Schema.Struct({
      different: Schema.Finite,
      related: Schema.Finite,
      same: Schema.Finite,
    }),
  }),
});
export type FixturePair = typeof FixturePair.Type;

const SpikeFixture = Schema.Struct({
  label: Schema.String,
  model: Schema.String,
  recordedAt: Schema.String,
  standards: Schema.Array(
    Schema.Struct({ id: Schema.String, title: Schema.String, primitive: Schema.String }),
  ),
  nodes: Schema.Array(FixtureNode),
  pairs: Schema.Array(FixturePair),
  placement: Schema.Struct({
    denReview: Schema.Array(Schema.String),
    denAuto: Schema.Array(Schema.String),
    targets: Schema.Record(Schema.String, Schema.String),
  }),
});
export type SpikeFixture = typeof SpikeFixture.Type;

const decodeSpikeFixture = Schema.decodeUnknownSync(SpikeFixture);
let decoded: SpikeFixture | undefined;

/** The decoded fixture; decoded on first call and cached. */
export function spikeFixture(): SpikeFixture {
  decoded ??= decodeSpikeFixture(fixtureJson);
  return decoded;
}

/** Fixture node ids that seed each den, review cards first. */
export function denSeedIds(fixture: SpikeFixture): readonly string[] {
  return [...fixture.placement.denReview, ...fixture.placement.denAuto];
}

/** Noul verdict: below 0.3 fails, below 0.7 is uncertain. */
export function noulVerdict(p: number): MemoryStandardVerdict {
  return p < 0.3 ? "fail" : p < 0.7 ? "uncertain" : "pass";
}

/** Score verdict: below 1.5 is uncertain. Scores never fail on their own. */
export function scoreVerdict(score: number): MemoryStandardVerdict {
  return score < 1.5 ? "uncertain" : "pass";
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function duplicateLevel(p: { different: number; related: number; same: number }) {
  const levels: MemoryDuplicateLevel[] = ["same", "related", "different"];
  return levels.reduce((best, level) => (p[level] > p[best] ? level : best), "different");
}

/**
 * Recorded Jev judgments for a fixture node. `targetId` selects the D1 pair
 * between this node and its placement target; pairs against anything else
 * (for example P02, P06) are deliberately ignored.
 */
export function recordedJudgments(
  fixture: SpikeFixture,
  node: FixtureNode,
  targetId: string | null,
): MemoryJudgments {
  const standards: MemoryStandardJudgment[] = [];
  for (const standard of fixture.standards) {
    const judgment = node.judgments[standard.id];
    if (!judgment) continue;
    const base = { id: standard.id, title: standard.title };
    switch (judgment.kind) {
      case "noul":
        standards.push({
          kind: "noul",
          ...base,
          p: clamp01(judgment.p),
          verdict: noulVerdict(judgment.p),
        });
        break;
      case "score":
        standards.push({
          kind: "score",
          ...base,
          score: judgment.score,
          confidence: clamp01(judgment.confidence),
          verdict: scoreVerdict(judgment.score),
        });
        break;
      case "choice":
        standards.push({
          kind: "choice",
          ...base,
          choice: judgment.choice,
          confidence: clamp01(judgment.confidence),
        });
        break;
    }
  }
  let duplicate: MemoryDuplicateJudgment | null = null;
  if (targetId !== null) {
    const pair = fixture.pairs.find(
      (candidate) =>
        (candidate.a.id === node.id && candidate.b.id === targetId) ||
        (candidate.b.id === node.id && candidate.a.id === targetId),
    );
    if (pair) {
      const probabilities = {
        different: clamp01(pair.d1.probabilities.different),
        related: clamp01(pair.d1.probabilities.related),
        same: clamp01(pair.d1.probabilities.same),
      };
      duplicate = { targetId, level: duplicateLevel(probabilities), probabilities };
    }
  }
  return { method: "recorded-jev", model: fixture.model, standards, duplicate };
}
