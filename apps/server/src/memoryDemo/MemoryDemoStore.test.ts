import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Option, Stream } from "effect";
import * as ServerConfig from "../config.ts";
import { layer, make, MemoryDemoStore } from "./MemoryDemoStore.ts";

const projectId = ProjectId.make("memory-demo-project");
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

describe("MemoryDemoStore", () => {
  it.effect("write appends a heuristic den node and publishes den-write", () =>
    Effect.gen(function* () {
      const store = yield* make();
      const nextChange = yield* Stream.runHead(store.changes).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const den = yield* store.den({ projectId });
      expect(den.nodes).toHaveLength(11);
      expect(den.name).toBe(`den/${projectId.slice(0, 8)}`);

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
