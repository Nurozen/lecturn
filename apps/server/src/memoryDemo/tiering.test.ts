import type { MemoryJudgments } from "@lecturn/contracts";
import { ProjectId } from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import { ensureDen, initialState, planDen, WarrenView } from "./demoState.ts";
import { spikeFixture } from "./spikeFixture.ts";
import { deriveOp, heuristicJudgments, tierFor } from "./tiering.ts";
import { buildWarren } from "./warren.ts";

const clean: MemoryJudgments = {
  method: "recorded-jev",
  model: "jev-test",
  standards: [
    { kind: "noul", id: "S1", title: "States a fact, not a work log", p: 0.95, verdict: "pass" },
    {
      kind: "score",
      id: "S5",
      title: "Specific enough to act on",
      score: 2.4,
      confidence: 0.9,
      verdict: "pass",
    },
  ],
  duplicate: null,
};
const text = (summary: string, context = "") => ({ summary, context });

describe("deriveOp", () => {
  it.each([
    ["no target", text("a"), null, "add"],
    ["identical text", text("Same fact.", "ctx"), text("same  fact.", "ctx"), "noop"],
    ["den extends target", text("Old fact.", "More detail."), text("Old fact."), "update"],
    ["different text", text("New fact."), text("Old fact."), "supersede"],
  ] as const)("%s", (_label, den, target, op) => {
    expect(deriveOp(den, target)).toBe(op);
  });

  it("treats containment as supersede when Jev judged the pair distinct facts", () => {
    const judged: MemoryJudgments = {
      ...clean,
      duplicate: {
        targetId: "t",
        level: "related",
        probabilities: { different: 0, related: 1, same: 0 },
      },
    };
    expect(deriveOp(text("Old fact.", "More."), text("Old fact."), judged)).toBe("supersede");
  });
});

describe("tierFor", () => {
  const facts = (overrides: Partial<Parameters<typeof tierFor>[0]> = {}) => ({
    op: "add" as const,
    den: text("Webhooks retry with backoff.", "See scheduleRetry."),
    target: null,
    judgments: clean,
    ...overrides,
  });
  const kinds = (input: Parameters<typeof tierFor>[0]) => tierFor(input).flags.map((f) => f.kind);

  it("keeps noop silent and a clean add automatic", () => {
    expect(tierFor(facts({ op: "noop" }))).toEqual({ tier: "silent", flags: [] });
    expect(tierFor(facts())).toEqual({ tier: "auto", flags: [] });
  });

  it.each(["whsec_abc", "sk_live_123", "AKIAABCDEFGH", "password: hunter2", "PASSWORD = x"])(
    "flags a suspected secret: %s",
    (secret) => {
      const result = tierFor(facts({ den: text(`Config uses ${secret}`) }));
      expect(result.tier).toBe("review");
      expect(result.flags[0]!.kind).toBe("secret-suspect");
    },
  );

  it("flags supersedes as destructive", () => {
    expect(kinds(facts({ op: "supersede", target: { id: "t", ...text("Old.") } }))).toEqual([
      "destructive-diff",
    ]);
  });

  it("flags duplicates at 0.3 and above, same or related", () => {
    const dup = (same: number, related: number): MemoryJudgments => ({
      ...clean,
      duplicate: {
        targetId: "t",
        level: "same",
        probabilities: { different: 1 - same - related, related, same },
      },
    });
    expect(kinds(facts({ judgments: dup(0.3, 0) }))).toEqual(["duplicate-suspect"]);
    expect(kinds(facts({ judgments: dup(0, 0.3) }))).toEqual(["duplicate-suspect"]);
    expect(kinds(facts({ judgments: dup(0.29, 0.29) }))).toEqual([]);
  });

  it("uses Noul and score thresholds with named reasons", () => {
    const standards = (p: number, score: number): MemoryJudgments => ({
      ...clean,
      standards: [
        { kind: "noul", id: "S1", title: "States a fact, not a work log", p, verdict: "pass" },
        {
          kind: "score",
          id: "S5",
          title: "Specific enough to act on",
          score,
          confidence: 0.5,
          verdict: "pass",
        },
      ],
    });
    expect(tierFor(facts({ judgments: standards(0.03, 2) })).flags).toEqual([
      { kind: "standard-fail", reason: "States a fact, not a work log: 0.03" },
    ]);
    expect(kinds(facts({ judgments: standards(0.3, 2) }))).toEqual(["standard-uncertain"]);
    expect(kinds(facts({ judgments: standards(0.69, 2) }))).toEqual(["standard-uncertain"]);
    expect(kinds(facts({ judgments: standards(0.7, 1.5) }))).toEqual([]);
    expect(kinds(facts({ judgments: standards(0.9, 1.49) }))).toEqual(["standard-uncertain"]);
  });

  it("always reviews heuristic judgments", () => {
    const judgments = heuristicJudgments({
      summary: "Stripe webhook retries use exponential backoff capped at 5 attempts.",
      context:
        "Stripe webhook retries back off exponentially: scheduleRetry in src/billing/webhooks/retry.ts doubles the delay, capped at 5 attempts.",
      sourcePath: "src/billing/webhooks/retry.ts",
    });
    expect(judgments.method).toBe("heuristic");
    expect(judgments.model).toBeNull();
    expect(judgments.standards.every((s) => s.kind === "choice" || s.verdict === "pass")).toBe(
      true,
    );
    expect(kinds(facts({ judgments }))).toEqual(["heuristic"]);
  });

  it("fails work-log summaries heuristically", () => {
    const judgments = heuristicJudgments({
      summary: "Fixed the flaky cart test",
      context: "",
      sourcePath: null,
    });
    expect(judgments.standards.find((s) => s.id === "S1")).toMatchObject({ verdict: "fail" });
    const todo = heuristicJudgments({
      summary: "TODO: ask Dana about the vault",
      context: "",
      sourcePath: null,
    });
    expect(todo.standards.find((s) => s.id === "S1")).toMatchObject({ verdict: "fail" });
  });
});

describe("fixture den", () => {
  const fixture = spikeFixture();
  const warren = buildWarren(fixture);
  const projectId = ProjectId.make("tiering-project");
  const state = ensureDen(initialState(), fixture, projectId, "den/test", 0);
  const [plan] = planDen(state, new WarrenView(warren, state), projectId);
  const card = (id: string) => plan.cards.find((c) => c.nodeId === id)!;
  const reasons = (id: string) => card(id).flags.map((f) => f.reason);

  it("tiers exactly 5 review and 6 auto", () => {
    expect(plan.counts).toEqual({ silent: 0, auto: 6, review: 5 });
    expect(
      plan.cards
        .filter((c) => c.tier === "review")
        .map((c) => c.nodeId)
        .sort(),
    ).toEqual([...fixture.placement.denReview].sort());
    expect(plan.cards.slice(0, 5).every((c) => c.tier === "review")).toBe(true);
  });

  it("surfaces the recorded values", () => {
    expect(reasons("infra/rotate-staging-password")).toEqual(
      expect.arrayContaining([
        "States a fact, not a work log: 0.03",
        "Summary is backed by the body: 0.02",
        "Specific enough to act on: 0.16",
      ]),
    );
    expect(card("auth/password-hashing").op).toBe("supersede");
    expect(card("auth/password-hashing").target?.id).toBe("auth/password-hashing-old");
    expect(reasons("auth/password-hashing")).toContain("Summary is backed by the body: 0.02");
    expect(card("web/cart-test-timers").judgments.duplicate).toMatchObject({
      targetId: "web/cart-flaky-test",
      level: "same",
      probabilities: { same: 0.96 },
    });
    expect(card("infra/tfstate-backend").judgments.duplicate?.probabilities).toMatchObject({
      same: 0.56,
      related: 0.44,
    });
    const ciRunners = card("infra/ci-runners");
    expect(ciRunners.op).toBe("supersede");
    expect(ciRunners.flags.some((f) => f.kind.startsWith("standard"))).toBe(false);
  });

  it("ignores pairs against non-target nodes (P02, P06) and passes S5 at 1.50 and 1.51", () => {
    expect(card("conventions/error-envelope")).toMatchObject({
      tier: "auto",
      op: "add",
      flags: [],
    });
    expect(card("team/request-id")).toMatchObject({ tier: "auto", op: "add", flags: [] });
    expect(card("team/request-id").judgments.duplicate).toBeNull();
    expect(card("team/feature-flags").tier).toBe("auto");
  });
});
