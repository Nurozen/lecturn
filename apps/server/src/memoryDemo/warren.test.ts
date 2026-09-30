import { describe, expect, it } from "@effect/vitest";
import { buildGraph, initialState, WarrenView } from "./demoState.ts";
import { spikeFixture } from "./spikeFixture.ts";
import {
  buildWarren,
  GENERATED_NODE_COUNT,
  layoutWarren,
  TERRITORIES,
  TOP_PER_TERRITORY,
} from "./warren.ts";

describe("warren", () => {
  it("generates the same 1,500 nodes plus the spike's warren nodes every time", () => {
    const a = buildWarren(spikeFixture());
    const b = buildWarren(spikeFixture());
    expect(GENERATED_NODE_COUNT).toBe(1500);
    expect(a.generatedCount).toBe(1500);
    expect(TERRITORIES).toHaveLength(10);
    // 44 fixture nodes minus the 11 that seed dens.
    expect(a.nodes.length).toBe(1500 + 33);
    expect(new Set(a.nodes.map((node) => node.id)).size).toBe(a.nodes.length);
    expect(a.nodes.map((n) => [n.id, n.score, n.summary])).toEqual(
      b.nodes.map((n) => [n.id, n.score, n.summary]),
    );
    expect(a.adjacency).toEqual(b.adjacency);
    expect(layoutWarren(a)).toEqual(layoutWarren(b));
  });

  it("maps spike nodes into territories and ranks them into the top 40", () => {
    const warren = buildWarren(spikeFixture());
    const territoryOf = (id: string) => warren.nodes[warren.byId.get(id)!]!.territoryId;
    expect(territoryOf("billing/event-ledger")).toBe("webhooks");
    expect(territoryOf("conventions/naming")).toBe("conventions");
    expect(territoryOf("team/on-call-handbook")).toBe("conventions");
    expect(territoryOf("infra/ci-runners-hosted")).toBe("infra-ci");
    expect(territoryOf("api/rate-limiting")).toBe("api-errors");
    expect(territoryOf("web/cart-flaky-test")).toBe("web-checkout");
    expect(warren.byId.has("infra/rotate-staging-password")).toBe(false);
    for (const node of warren.nodes.slice(warren.generatedCount)) {
      const territory = warren.territories.find((t) => t.spec.id === node.territoryId)!;
      expect(territory.top).toContain(node.index);
    }
  });

  it("ships at most 40 nodes per territory with index edges and short labels", () => {
    const fixture = spikeFixture();
    const started = performance.now();
    const warren = buildWarren(fixture);
    const layout = layoutWarren(warren);
    const graph = buildGraph(new WarrenView(warren, initialState()), layout);
    const elapsed = performance.now() - started;
    // @effect-diagnostics-next-line globalConsole:off - reports generation time against the 150 ms budget.
    console.log(`memory demo warren generation + layout + graph: ${elapsed.toFixed(1)} ms`);

    expect(graph.territories).toHaveLength(10);
    expect(graph.territories.reduce((sum, t) => sum + t.nodeCount, 0)).toBe(1533);
    const perTerritory = new Map<string, number>();
    for (const node of graph.nodes) {
      perTerritory.set(node.territoryId, (perTerritory.get(node.territoryId) ?? 0) + 1);
      expect(node.label.length).toBeLessThanOrEqual(80);
      expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
    }
    for (const count of perTerritory.values()) expect(count).toBeLessThanOrEqual(TOP_PER_TERRITORY);
    expect(graph.nodes.length).toBe(10 * TOP_PER_TERRITORY);
    expect(graph.edges.length).toBeGreaterThan(0);
    for (const [i, j] of graph.edges) {
      expect(i).toBeLessThan(j);
      expect(j).toBeLessThan(graph.nodes.length);
    }
    expect(JSON.stringify(graph).length).toBeLessThan(120_000);
  });
});
