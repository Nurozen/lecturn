import type { ContributionCard, ContributionPlan, ProjectId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  canLand,
  createGateState,
  currentCard,
  draftBlock,
  gateReducer,
  landNodeCount,
  landVerdicts,
  rebaseGateState,
  suggestedVerdict,
  tierCounts,
  undecidedCount,
  verdictBlock,
  type GateAction,
  type GateState,
} from "./gateState";

const judgments = { method: "heuristic", model: null, standards: [], duplicate: null } as const;

function card(
  nodeId: string,
  overrides: Partial<Omit<ContributionCard, "nodeId">> = {},
): ContributionCard {
  return {
    nodeId,
    op: "add",
    tier: "review",
    type: "concept",
    territoryId: nodeId.split("/")[0]!,
    destination: nodeId,
    den: { summary: `${nodeId} summary`, context: "", sourcePath: null },
    target: null,
    flags: [],
    judgments,
    ...overrides,
  };
}

const target = (id: string) => ({ id, summary: `${id} summary`, context: "" });

function plan(cards: ContributionCard[], planId = "plan-1"): ContributionPlan {
  return {
    planId,
    projectId: "project" as ProjectId,
    denRevision: 1,
    cards,
    counts: {
      silent: cards.filter((c) => c.tier === "silent").length,
      auto: cards.filter((c) => c.tier === "auto").length,
      review: cards.filter((c) => c.tier === "review").length,
    },
  };
}

const secret = card("infra/staging-password", {
  den: { summary: "Staging password is hunter2", context: "", sourcePath: null },
  flags: [{ kind: "secret-suspect", reason: "Looks like a password." }],
});
const demoPlan = plan([
  card("infra/rotate-staging-password"),
  card("auth/password-hashing", { op: "supersede", target: target("auth/password-hashing-old") }),
  card("web/cart-test-timers", { op: "update", target: target("web/cart-flaky-test") }),
  secret,
  card("billing/webhook-async", { tier: "auto" }),
  card("team/three-repos", { tier: "auto" }),
  card("infra/vpc-module", { tier: "silent", op: "noop" }),
]);

const run = (state: GateState, ...actions: GateAction[]) => actions.reduce(gateReducer, state);
const accept: GateAction = { type: "verdict", verdict: "accept" };
const skip: GateAction = { type: "verdict", verdict: "skip" };
const merge: GateAction = { type: "verdict", verdict: "merge" };

describe("gateState", () => {
  it("splits the plan into tiers and starts on the first review card", () => {
    const state = createGateState(demoPlan);
    expect(tierCounts(state)).toEqual({ silent: 1, auto: 2, review: 4 });
    expect(currentCard(state)?.nodeId).toBe("infra/rotate-staging-password");
    expect(undecidedCount(state)).toBe(4);
    expect(canLand(state)).toBe(false);
    expect(landNodeCount(state)).toBe(2);
  });

  it("advances to the next undecided card after a verdict, wrapping around", () => {
    let state = run(createGateState(demoPlan), { type: "jump", index: 2 }, accept);
    expect(currentCard(state)?.nodeId).toBe("infra/staging-password");
    state = run(state, skip);
    expect(currentCard(state)?.nodeId).toBe("infra/rotate-staging-password");
    state = run(state, skip);
    expect(currentCard(state)?.nodeId).toBe("auth/password-hashing");
  });

  it("blocks merge and distinct without a target", () => {
    const state = createGateState(demoPlan);
    expect(verdictBlock(currentCard(state)!, "merge")).toMatch(/warren target/);
    expect(run(state, merge)).toBe(state);
    expect(run(state, { type: "verdict", verdict: "distinct" })).toBe(state);
    const onTarget = run(state, { type: "jump", index: 2 }, merge);
    expect(onTarget.verdicts.get("web/cart-test-timers")).toEqual({ verdict: "merge" });
  });

  it("defaults secret suspects to skip and requires an edit before accepting", () => {
    const state = run(createGateState(demoPlan), { type: "jump", index: 3 });
    const secretCard = currentCard(state)!;
    expect(suggestedVerdict(secretCard)).toBe("skip");
    expect(suggestedVerdict(demoPlan.cards[0]!)).toBeNull();
    expect(run(state, accept)).toBe(state);

    const editing = run(state, { type: "edit" });
    expect(editing.draft).toBe("Staging password is hunter2");
    expect(draftBlock(secretCard, editing.draft!)).toMatch(/flagged text/);
    expect(run(editing, { type: "confirmEdit" })).toBe(editing);

    const edited = run(
      editing,
      { type: "draft", text: "  Staging password lives in the vault.  " },
      {
        type: "confirmEdit",
      },
    );
    expect(edited.draft).toBeNull();
    expect(edited.verdicts.get(secretCard.nodeId)).toEqual({
      verdict: "edit",
      summary: "Staging password lives in the vault.",
    });
  });

  it("re-tests an edited summary for secrets", () => {
    const leaky = card("billing/stripe-key", {
      den: { summary: "Billing reads sk_live_abc123.", context: "", sourcePath: null },
      flags: [{ kind: "secret-suspect", reason: "Looks like a live Stripe key." }],
    });
    expect(verdictBlock(leaky, "accept")).toMatch(/secret/);
    expect(draftBlock(leaky, "Billing now reads sk_live_abc123 from env.")).toMatch(
      /live Stripe key/,
    );
    expect(draftBlock(leaky, "Billing reads its Stripe key from the environment.")).toBeNull();
  });

  it("allows only skip when the secret is in the body", () => {
    const inBody = card("infra/staging-db", {
      op: "update",
      target: target("infra/staging"),
      den: {
        summary: "Staging database credentials live in the vault.",
        context: "staging password: hunter2",
        sourcePath: null,
      },
      flags: [{ kind: "secret-suspect", reason: "Looks like a password assignment." }],
    });
    for (const verdict of ["accept", "merge", "distinct", "edit"] as const)
      expect(verdictBlock(inBody, verdict)).toBe("Secret is in the body; skip this node.");
    expect(verdictBlock(inBody, "skip")).toBeNull();
    expect(draftBlock(inBody, "Staging credentials are in the vault.")).toBe(
      "Secret is in the body; skip this node.",
    );
    let state = run(createGateState(plan([inBody])), accept, merge, { type: "edit" });
    state = run(state, { type: "draft", text: "Clean summary." }, { type: "confirmEdit" });
    expect(state.verdicts.size).toBe(0);
    expect(run(state, { type: "cancelEdit" }, skip).verdicts.get(inBody.nodeId)).toEqual({
      verdict: "skip",
    });
  });

  it("rejects empty and oversized drafts and cancels without a verdict", () => {
    const first = demoPlan.cards[0]!;
    expect(draftBlock(first, "   ")).toMatch(/empty/);
    expect(draftBlock(first, "x".repeat(401))).toMatch(/400/);
    const state = run(
      createGateState(demoPlan),
      { type: "edit" },
      { type: "draft", text: "new" },
      {
        type: "cancelEdit",
      },
    );
    expect(state.draft).toBeNull();
    expect(state.verdicts.size).toBe(0);
  });

  it("ignores verdict keys while a draft is open", () => {
    const editing = run(createGateState(demoPlan), { type: "edit" });
    expect(run(editing, skip)).toBe(editing);
  });

  it("undoes the last verdict, restoring the previous one and the cursor", () => {
    let state = run(createGateState(demoPlan), accept);
    state = run(state, { type: "jump", index: 0 }, skip);
    expect(state.verdicts.get("infra/rotate-staging-password")).toEqual({ verdict: "skip" });
    state = run(state, { type: "undo" });
    expect(state.verdicts.get("infra/rotate-staging-password")).toEqual({ verdict: "accept" });
    expect(state.cursor).toBe(0);
    state = run(state, { type: "undo" });
    expect(state.verdicts.size).toBe(0);
    expect(run(state, { type: "undo" })).toBe(state);
  });

  it("enables land once every review card has a verdict and reports what lands", () => {
    let state = createGateState(demoPlan);
    state = run(
      state,
      skip,
      accept,
      merge,
      { type: "edit" },
      { type: "draft", text: "Password is in the vault" },
      { type: "confirmEdit" },
    );
    expect(canLand(state)).toBe(true);
    expect(state.complete).toBe(true);
    expect(landNodeCount(state)).toBe(2 + 3);
    expect(landVerdicts(state)).toEqual([
      { nodeId: "infra/rotate-staging-password", verdict: "skip" },
      { nodeId: "auth/password-hashing", verdict: "accept" },
      { nodeId: "web/cart-test-timers", verdict: "merge" },
      { nodeId: "infra/staging-password", verdict: "edit", summary: "Password is in the vault" },
    ]);
    expect(run(state, { type: "move", delta: -1 }).complete).toBe(false);
  });

  it("clamps J and K at the ends", () => {
    const state = createGateState(demoPlan);
    expect(run(state, { type: "move", delta: -1 })).toBe(state);
    expect(
      run(state, ...Array.from({ length: 9 }, (): GateAction => ({ type: "move", delta: 1 })))
        .cursor,
    ).toBe(3);
  });

  it("pulls an auto card into review and returns it", () => {
    let state = run(createGateState(demoPlan), { type: "pull", nodeId: "team/three-repos" });
    expect(tierCounts(state)).toEqual({ silent: 1, auto: 1, review: 5 });
    expect(currentCard(state)?.nodeId).toBe("team/three-repos");
    state = run(state, accept);
    expect(landVerdicts(state)).toContainEqual({ nodeId: "team/three-repos", verdict: "accept" });
    state = run(state, { type: "unpull", nodeId: "team/three-repos" });
    expect(tierCounts(state)).toEqual({ silent: 1, auto: 2, review: 4 });
    expect(state.verdicts.has("team/three-repos")).toBe(false);
    expect(state.undo).toEqual([]);
  });

  it("starts complete when the plan has no review cards", () => {
    const state = createGateState(plan([card("a/b", { tier: "auto" })]));
    expect(state.complete).toBe(true);
    expect(canLand(state)).toBe(true);
    expect(currentCard(state)).toBeNull();
    expect(run(state, accept)).toBe(state);
  });

  it("rebases on a new plan, keeping verdicts for unchanged cards", () => {
    const state = run(createGateState(demoPlan), skip, accept, merge);
    const next = plan(
      [
        card("infra/rotate-staging-password"),
        card("auth/password-hashing", {
          op: "supersede",
          target: target("auth/password-hashing-old"),
          den: { summary: "changed by an agent", context: "", sourcePath: null },
        }),
        card("web/cart-test-timers", { op: "update", target: target("web/cart-flaky-test") }),
        secret,
        card("agent/new-fact"),
      ],
      "plan-2",
    );
    const rebased = rebaseGateState(state, next);
    expect(rebased.state.planId).toBe("plan-2");
    expect([...rebased.state.verdicts.keys()]).toEqual([
      "infra/rotate-staging-password",
      "web/cart-test-timers",
    ]);
    expect(rebased.requeued).toBe(3);
    expect(currentCard(rebased.state)?.nodeId).toBe("auth/password-hashing");
    expect(rebased.state.undo).toEqual([]);
  });
});
