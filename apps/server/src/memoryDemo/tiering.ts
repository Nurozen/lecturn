/**
 * tiering - how the Contribution Gate sorts den nodes. Pure functions:
 * `deriveOp` decides what landing a node does to the warren, `tierFor` decides
 * whether a person must look at it and why, and `heuristicJudgments` scores
 * live-written nodes locally (no Jev).
 *
 * @module tiering
 */
import type {
  ContributionFlag,
  ContributionOp,
  ContributionTier,
  MemoryJudgments,
  MemoryStandardJudgment,
} from "@lecturn/contracts";
import { noulVerdict, scoreVerdict } from "./spikeFixture.ts";

export interface NodeText {
  readonly summary: string;
  readonly context: string;
}

const normalize = (text: NodeText) =>
  `${text.summary}\n${text.context}`.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * No target: add. Identical text: noop. Den text contains the target's text:
 * update, unless the recorded duplicate check says the two are different facts
 * (related/different), which makes it a supersede. Anything else: supersede.
 */
export function deriveOp(
  den: NodeText,
  target: NodeText | null,
  judgments?: MemoryJudgments,
): ContributionOp {
  if (target === null) return "add";
  const denText = normalize(den);
  const targetText = normalize(target);
  if (denText === targetText) return "noop";
  const judgedDistinct = judgments?.duplicate != null && judgments.duplicate.level !== "same";
  if (denText.includes(targetText) && !judgedDistinct) return "update";
  return "supersede";
}

export interface TierFacts {
  readonly op: ContributionOp;
  readonly den: NodeText;
  readonly target: (NodeText & { readonly id: string }) | null;
  readonly judgments: MemoryJudgments;
}

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/whsec_/, "a webhook signing secret (whsec_)"],
  [/sk_live_/, "a live Stripe key (sk_live_)"],
  [/AKIA/, "an AWS access key (AKIA)"],
  [/password\s*[:=]/i, "a password assignment"],
];

/** What `text` looks like it leaks (e.g. "a live Stripe key (sk_live_)"), or null. */
export function findSecret(text: string): string | null {
  return SECRET_PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

const DUPLICATE_THRESHOLD = 0.3;
const fmt = (value: number) => value.toFixed(2);

function standardFlags(standard: MemoryStandardJudgment): ContributionFlag | null {
  switch (standard.kind) {
    case "noul": {
      const verdict = noulVerdict(standard.p);
      if (verdict === "pass") return null;
      return {
        kind: verdict === "fail" ? "standard-fail" : "standard-uncertain",
        reason: `${standard.title}: ${fmt(standard.p)}`,
      };
    }
    case "score":
      return scoreVerdict(standard.score) === "pass"
        ? null
        : { kind: "standard-uncertain", reason: `${standard.title}: ${fmt(standard.score)}` };
    case "choice":
      return null;
  }
}

/**
 * Tier and flags for one card. Noop is silent. Otherwise every rule that
 * matches adds a flag, in order: secret, destructive diff, duplicate,
 * heuristic, standards. Any flag means review; no flags means auto.
 */
export function tierFor(facts: TierFacts): {
  tier: ContributionTier;
  flags: ContributionFlag[];
} {
  if (facts.op === "noop") return { tier: "silent", flags: [] };
  const flags: ContributionFlag[] = [];
  const text = `${facts.den.summary}\n${facts.den.context}`;
  const secret = findSecret(text);
  if (secret) flags.push({ kind: "secret-suspect", reason: `Looks like it contains ${secret}` });
  if (facts.target && (facts.op === "supersede" || removesText(facts.den, facts.target))) {
    flags.push({
      kind: "destructive-diff",
      reason: `Replaces the text of ${facts.target.id}`,
    });
  }
  const duplicate = facts.judgments.duplicate;
  if (duplicate) {
    const { same, related } = duplicate.probabilities;
    if (same >= DUPLICATE_THRESHOLD || related >= DUPLICATE_THRESHOLD) {
      const parts = [
        same >= DUPLICATE_THRESHOLD ? `same ${fmt(same)}` : null,
        related >= DUPLICATE_THRESHOLD ? `related ${fmt(related)}` : null,
      ].filter((part) => part !== null);
      flags.push({
        kind: "duplicate-suspect",
        reason: `Duplicate check against ${duplicate.targetId}: ${parts.join(", ")}`,
      });
    }
  }
  if (facts.judgments.method === "heuristic") {
    flags.push({
      kind: "heuristic",
      reason: "Checked by local heuristics, not recorded Jev judgments",
    });
  }
  for (const standard of facts.judgments.standards) {
    const flag = standardFlags(standard);
    if (flag) flags.push(flag);
  }
  return { tier: flags.length > 0 ? "review" : "auto", flags };
}

/** An update that drops any word the target had. */
function removesText(den: NodeText, target: NodeText): boolean {
  const denWords = new Set(normalize(den).split(" "));
  return normalize(target)
    .split(" ")
    .some((word) => word.length > 0 && !denWords.has(word));
}

const WORK_LOG_LEAD =
  /^\s*(fixed|added|removed|updated|changed|refactored|implemented|bumped|tried|todo|to-do|remember|ask|need to|should|wip|don't forget|follow up)\b/i;
const WORD = /[a-z0-9]+/g;
const COMMON = new Set(
  "the a an and or of to in on for is are was be it this that with by as at from".split(" "),
);

function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(WORD) ?? []).filter((w) => !COMMON.has(w)));
}

/** Identifiers (camelCase, snake_case, dotted), paths and numbers in the text. */
function specificityCount(text: string, sourcePath: string | null): number {
  const identifiers = text.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b\w+_\w+\b|\b\w+\.\w+\b/g) ?? [];
  const paths = text.match(/\S+\/\S+/g) ?? [];
  const numbers = text.match(/\b\d+(\.\d+)?\b/g) ?? [];
  return identifiers.length + paths.length + numbers.length + (sourcePath ? 1 : 0);
}

/**
 * Local stand-in for Jev on live writes. S1 fails a leading past-tense verb or
 * to-do word, S4 is summary/context word overlap, S5 counts identifiers,
 * paths and numbers. The values are internal scores, not probabilities.
 */
export function heuristicJudgments(input: {
  readonly summary: string;
  readonly context: string;
  readonly sourcePath: string | null;
}): MemoryJudgments {
  const workLog = WORK_LOG_LEAD.test(input.summary) || /\bTODO\b/.test(input.summary);
  const s1 = workLog ? 0.1 : 0.85;
  const summaryWords = contentWords(input.summary);
  const contextWords = contentWords(input.context);
  let s4 = 0.5;
  if (contextWords.size > 0 && summaryWords.size > 0) {
    const shared = [...summaryWords].filter((w) => contextWords.has(w)).length;
    s4 = Math.min(0.95, 0.2 + shared / summaryWords.size);
  }
  const s5 = Math.min(
    3,
    specificityCount(`${input.summary} ${input.context}`, input.sourcePath) * 0.75,
  );
  return {
    method: "heuristic",
    model: null,
    standards: [
      {
        kind: "noul",
        id: "S1",
        title: "States a fact, not a work log",
        p: s1,
        verdict: noulVerdict(s1),
      },
      {
        kind: "noul",
        id: "S4",
        title: "Summary is backed by the body",
        p: s4,
        verdict: noulVerdict(s4),
      },
      {
        kind: "score",
        id: "S5",
        title: "Specific enough to act on",
        score: s5,
        confidence: 0.5,
        verdict: scoreVerdict(s5),
      },
    ],
    duplicate: null,
  };
}
