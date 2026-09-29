import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect";
import * as ServerConfig from "../config.ts";
import { layer, make, MemoryDemoStore } from "./MemoryDemoStore.ts";

const projectId = ProjectId.make("memory-demo-project");
const otherProjectId = ProjectId.make("memory-demo-other");
const AGENT = { origin: "agent" } as const;

const configLayer = (memoryDemoEnabled: boolean) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return ServerConfig.make({ ...config, memoryDemoEnabled });
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-memory-demo-test-" })),
    Layer.provide(NodeServices.layer),
  );

const failureCode = <A, E extends { code: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((r) => (r._tag === "Fail" ? [r.error.code] : []))
    : [];

const failureMessage = <A, E extends { message: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((r) => (r._tag === "Fail" ? [r.error.message] : [])).join("")
    : "";

/** Review verdicts from the round-trip test; the merge makes two landings overlap. */
const reviewVerdicts = [
  { nodeId: "infra/rotate-staging-password", verdict: "skip" },
  { nodeId: "web/cart-test-timers", verdict: "merge" },
] as const;

describe("MemoryDemoStore", () => {
  it.effect("write appends a heuristic den node and publishes den-write", () =>
    Effect.gen(function* () {
      const store = yield* make();
      const den = yield* store.den({ projectId });
      expect(den.nodes).toHaveLength(11);
      expect(den.name).toBe(`den/${projectId.slice(0, 8)}`);
      const nextChange = yield* Stream.runHead(store.changes).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const node = yield* store.write(
        {
          projectId,
          summary: "Stripe webhook retries back off exponentially, capped at 5 attempts.",
          context: "scheduleRetry in src/billing/webhooks/retry.ts doubles the delay.",
          tags: ["webhooks"],
        },
        AGENT,
      );
      expect(node).toMatchObject({ origin: "agent", namespace: "webhooks", targetId: null });
      expect(node.id.startsWith("webhooks/")).toBe(true);
      expect(node.judgments.method).toBe("heuristic");
      const change = Option.getOrThrow(yield* Fiber.join(nextChange));
      expect(change).toMatchObject({ kind: "den-write", projectId, nodeIds: [node.id] });
      expect((yield* store.den({ projectId })).nodes).toHaveLength(12);

      const plan = yield* store.plan({ projectId });
      expect(plan.counts).toEqual({ silent: 0, auto: 6, review: 6 });
      expect(
        plan.cards.find((card) => card.nodeId === node.id)?.flags.map((f) => f.kind),
      ).toContain("heuristic");
    }),
  );

  it.effect("seeding a den publishes den-write so status counts it", () =>
    Effect.gen(function* () {
      const store = yield* make();
      expect((yield* store.status).pending).toEqual([]);
      const nextChange = yield* Stream.runHead(store.changes).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* store.den({ projectId });
      const change = Option.getOrThrow(yield* Fiber.join(nextChange));
      expect(change).toMatchObject({ kind: "den-write", projectId, nodeIds: [] });
      expect((yield* store.status).pending).toEqual([{ projectId, count: 11 }]);
    }),
  );

  it.effect("query ranks recall and records it on the den", () =>
    Effect.gen(function* () {
      const store = yield* make();
      const result = yield* store.query({ projectId, text: "webhook retry idempotent" }, AGENT);
      expect(result.hits[0]?.territoryId).toBe("webhooks");
      expect(result.pathIds.length).toBeLessThanOrEqual(10);
      const den = yield* store.den({ projectId });
      expect(den.recentQueries[0]).toMatchObject({
        text: "webhook retry idempotent",
        hitCount: result.hits.length,
      });
      const graph = yield* store.graph;
      expect(graph.territories.find((t) => t.id === "webhooks")?.recalled).toBe(true);
    }),
  );

  it.effect("plan, land, graph and revert round-trip", () =>
    Effect.gen(function* () {
      const store = yield* make();
      const before = yield* store.graph;
      const statusBefore = yield* store.status;
      const plan = yield* store.plan({ projectId });
      expect(plan.counts).toEqual({ silent: 0, auto: 6, review: 5 });

      const receipt = yield* store.land({
        projectId,
        planId: plan.planId,
        verdicts: [
          { nodeId: "infra/rotate-staging-password", verdict: "skip" },
          {
            nodeId: "auth/password-hashing",
            verdict: "edit",
            summary: "Passwords are hashed with argon2id in hashPassword.",
          },
          { nodeId: "web/cart-test-timers", verdict: "merge" },
          { nodeId: "infra/tfstate-backend", verdict: "distinct" },
          { nodeId: "infra/ci-runners", verdict: "accept" },
        ],
      });
      expect(receipt.id).toMatch(/^[0-9a-f]{7}$/);
      expect(receipt.counts).toEqual({
        added: 6,
        updated: 0,
        superseded: 2,
        merged: 1,
        distinct: 1,
        skipped: 1,
      });
      expect(receipt.skippedNodeIds).toEqual(["infra/rotate-staging-password"]);
      expect(receipt.territoriesGrown.reduce((sum, t) => sum + t.count, 0)).toBe(10);
      expect((yield* store.den({ projectId })).nodes.map((n) => n.id)).toEqual([
        "infra/rotate-staging-password",
      ]);

      const graph = yield* store.graph;
      const lit = graph.nodes
        .filter((node) => node.landedReceiptId === receipt.id)
        .map((n) => n.id);
      expect(lit.sort()).toEqual(
        [
          "auth/password-hashing",
          "billing/webhook-async",
          "conventions/error-envelope",
          "infra/ci-runners",
          "infra/tfstate-backend",
          "infra/vpc-module",
          "team/feature-flags",
          "team/request-id",
          "team/three-repos",
          "web/cart-flaky-test",
        ].sort(),
      );
      // New nodes land in open space at the territory's own spacing, not on its hubs.
      const beforeIds = new Set(before.nodes.map((node) => node.id));
      const nearestIn = (nodes: typeof graph.nodes, node: (typeof graph.nodes)[number]) =>
        Math.min(
          ...nodes
            .filter((other) => other !== node && other.territoryId === node.territoryId)
            .map((other) => Math.hypot(other.x - node.x, other.y - node.y)),
        );
      for (const node of graph.nodes) {
        if (node.landedReceiptId !== receipt.id || beforeIds.has(node.id)) continue;
        const base = before.nodes.filter((other) => other.territoryId === node.territoryId);
        const spacing = base.map((other) => nearestIn(base, other)).sort((a, b) => a - b);
        const median = spacing[Math.floor(spacing.length / 2)]!;
        expect(nearestIn(graph.nodes, node)).toBeGreaterThanOrEqual(median * 0.7);
      }
      const ids = new Set(graph.nodes.map((node) => node.id));
      expect(ids.has("auth/password-hashing-old")).toBe(false);
      expect(ids.has("infra/ci-runners-hosted")).toBe(false);
      expect(graph.edges.every(([i, j]) => i < j && j < graph.nodes.length)).toBe(true);
      const merged = yield* store.node({ nodeId: "web/cart-flaky-test" });
      expect(merged.context).toContain("advanceTimersByTime");
      expect(merged.landedReceiptId).toBe(receipt.id);
      const landed = yield* store.node({ nodeId: "auth/password-hashing" });
      expect(landed).toMatchObject({
        scope: "warren",
        summary: "Passwords are hashed with argon2id in hashPassword.",
      });
      expect((yield* store.status).warrenNodes).toBe(statusBefore.warrenNodes + 7);

      const nextChange = yield* Stream.runHead(store.changes).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const reverted = yield* store.revert({ receiptId: receipt.id });
      expect(reverted.reverted).toBe(true);
      const change = Option.getOrThrow(yield* Fiber.join(nextChange));
      expect(change).toMatchObject({ kind: "revert", projectId });
      expect((yield* store.den({ projectId })).nodes).toHaveLength(11);
      const after = yield* store.graph;
      expect(after.nodes.map((n) => [n.id, n.landedReceiptId])).toEqual(
        before.nodes.map((n) => [n.id, n.landedReceiptId]),
      );
      const status = yield* store.status;
      expect(status.warrenNodes).toBe(statusBefore.warrenNodes);
      expect(status.lastReceipt).toMatchObject({ id: receipt.id, reverted: true });
    }),
  );

  it.effect("fails a stale plan after the den moves", () =>
    Effect.gen(function* () {
      const store = yield* make();
      const plan = yield* store.plan({ projectId });
      yield* store.removeDenNode({ projectId, nodeId: "team/three-repos" });
      const exit = yield* Effect.exit(store.land({ projectId, planId: plan.planId, verdicts: [] }));
      expect(failureCode(exit)).toEqual(["stale-plan"]);
      const fresh = yield* store.plan({ projectId });
      const receipt = yield* store.land({ projectId, planId: fresh.planId, verdicts: [] });
      expect(receipt.counts.added).toBe(5);
      expect(receipt.counts.skipped).toBe(5);
    }),
  );

  it.effect("revert refuses a receipt that a later landing overlaps", () =>
    Effect.gen(function* () {
      const store = yield* make();
      const before = yield* store.graph;
      const mergeTarget = yield* store.node({ nodeId: "web/cart-flaky-test" });
      const planA = yield* store.plan({ projectId });
      const older = yield* store.land({
        projectId,
        planId: planA.planId,
        verdicts: reviewVerdicts,
      });
      const planB = yield* store.plan({ projectId: otherProjectId });
      const newer = yield* store.land({
        projectId: otherProjectId,
        planId: planB.planId,
        verdicts: reviewVerdicts,
      });
      expect(newer.counts.merged).toBe(1);

      const refused = yield* Effect.exit(store.revert({ receiptId: older.id }));
      expect(failureCode(refused)).toEqual(["invalid"]);
      expect(failureMessage(refused)).toContain(`Revert ${newer.id} first`);

      yield* store.revert({ receiptId: newer.id });
      yield* store.revert({ receiptId: older.id });
      const after = yield* store.graph;
      expect(after.nodes.map((n) => [n.id, n.label, n.landedReceiptId])).toEqual(
        before.nodes.map((n) => [n.id, n.label, n.landedReceiptId]),
      );
      expect(after.edges).toEqual(before.edges);
      expect(yield* store.node({ nodeId: "web/cart-flaky-test" })).toEqual(mergeTarget);
      expect((yield* store.den({ projectId })).nodes).toHaveLength(11);
      expect((yield* store.den({ projectId: otherProjectId })).nodes).toHaveLength(11);

      const again = yield* Effect.exit(store.revert({ receiptId: older.id }));
      expect(failureCode(again)).toEqual(["invalid"]);
    }),
  );

  it.effect("land refuses a card whose landed text still holds a secret", () =>
    Effect.gen(function* () {
      const store = yield* make();
      const inSummary = yield* store.write(
        { projectId, summary: "Billing reads sk_live_abc123 from the environment." },
        AGENT,
      );
      const inContext = yield* store.write(
        {
          projectId,
          summary: "Staging database credentials live in the vault.",
          context: "staging password: hunter2",
        },
        AGENT,
      );
      const land = (
        verdicts: ReadonlyArray<{
          nodeId: string;
          verdict: "accept" | "edit" | "skip";
          summary?: string;
        }>,
      ) =>
        Effect.gen(function* () {
          const plan = yield* store.plan({ projectId });
          return yield* Effect.exit(store.land({ projectId, planId: plan.planId, verdicts }));
        });

      const accepted = yield* land([{ nodeId: inSummary.id, verdict: "accept" }]);
      expect(failureCode(accepted)).toEqual(["invalid"]);
      expect(failureMessage(accepted)).toContain(inSummary.id);
      const stillSecret = yield* land([
        { nodeId: inSummary.id, verdict: "edit", summary: "Uses sk_live_abc123 for billing." },
      ]);
      expect(failureCode(stillSecret)).toEqual(["invalid"]);
      const cleanSummary = yield* land([
        { nodeId: inSummary.id, verdict: "skip" },
        {
          nodeId: inContext.id,
          verdict: "edit",
          summary: "Staging credentials live in the vault.",
        },
      ]);
      expect(failureCode(cleanSummary)).toEqual(["invalid"]);
      expect(failureMessage(cleanSummary)).toContain(
        `${inContext.id} has a password assignment in its body`,
      );

      const cleaned = yield* land([
        {
          nodeId: inSummary.id,
          verdict: "edit",
          summary: "Billing reads its Stripe key from the environment.",
        },
        { nodeId: inContext.id, verdict: "skip" },
      ]);
      expect(Exit.isSuccess(cleaned)).toBe(true);
      const landed = yield* store.node({ nodeId: inSummary.id });
      expect(landed).toMatchObject({ scope: "warren" });
      expect(landed.summary).not.toContain("sk_live_");
    }),
  );

  it.effect("land reports stale-plan after a reset or a landing elsewhere", () =>
    Effect.gen(function* () {
      const store = yield* make();
      const beforeReset = yield* store.plan({ projectId });
      yield* store.reset;
      const afterReset = yield* Effect.exit(
        store.land({ projectId, planId: beforeReset.planId, verdicts: [] }),
      );
      expect(failureCode(afterReset)).toEqual(["stale-plan"]);

      const mine = yield* store.plan({ projectId });
      const theirs = yield* store.plan({ projectId: otherProjectId });
      const receipt = yield* store.land({
        projectId: otherProjectId,
        planId: theirs.planId,
        verdicts: [],
      });
      const moved = yield* Effect.exit(
        store.land({ projectId, planId: mine.planId, verdicts: [] }),
      );
      expect(failureCode(moved)).toEqual(["stale-plan"]);

      const replanned = yield* store.plan({ projectId });
      yield* store.revert({ receiptId: receipt.id });
      const reverted = yield* Effect.exit(
        store.land({ projectId, planId: replanned.planId, verdicts: [] }),
      );
      expect(failureCode(reverted)).toEqual(["stale-plan"]);
      const fresh = yield* store.plan({ projectId });
      expect(
        Exit.isSuccess(
          yield* Effect.exit(store.land({ projectId, planId: fresh.planId, verdicts: [] })),
        ),
      ).toBe(true);
    }),
  );

  it.effect("warm-up builds the warren, index and layout in the background", () =>
    Effect.gen(function* () {
      const warmed = yield* Deferred.make<void>();
      const store = yield* make({ warmUp: { done: Deferred.succeed(warmed, undefined) } });
      expect(yield* Deferred.isDone(warmed)).toBe(false);
      yield* Deferred.await(warmed);
      expect((yield* store.graph).nodes.length).toBeGreaterThan(0);
      expect((yield* store.query({ text: "webhook retry" }, AGENT)).hits.length).toBeGreaterThan(0);
    }),
  );

  it.effect("reset clears dens and landings and publishes reset", () =>
    Effect.gen(function* () {
      const store = yield* make();
      const plan = yield* store.plan({ projectId });
      yield* store.land({ projectId, planId: plan.planId, verdicts: [] });
      const nextChange = yield* Stream.runHead(store.changes).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* store.reset;
      const change = Option.getOrThrow(yield* Fiber.join(nextChange));
      expect(change).toMatchObject({ kind: "reset", projectId: null });
      const status = yield* store.status;
      expect(status).toMatchObject({ pending: [], lastReceipt: null, warrenNodes: 1533 });
      expect((yield* store.den({ projectId })).nodes).toHaveLength(11);
    }),
  );

  it.effect("the layer is disabled without the flag", () =>
    Effect.gen(function* () {
      const store = yield* MemoryDemoStore;
      expect(failureCode(yield* Effect.exit(store.status))).toEqual(["disabled"]);
      expect(failureCode(yield* Effect.exit(store.graph))).toEqual(["disabled"]);
      expect(
        failureCode(yield* Effect.exit(store.write({ projectId, summary: "x" }, AGENT))),
      ).toEqual(["disabled"]);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(configLayer(false))))),
  );

  it.effect("the layer serves the store with the flag on", () =>
    Effect.gen(function* () {
      const store = yield* MemoryDemoStore;
      expect((yield* store.den({ projectId })).nodes).toHaveLength(11);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(configLayer(true))))),
  );
});
