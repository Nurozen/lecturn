import type { MemoryGraph, MemoryGraphNode, MemoryNodeType } from "@lecturn/contracts";
import { assert, describe, it } from "vite-plus/test";
import {
  MAX_EDGES,
  MAX_MARKS,
  buildScene,
  fitCamera,
  hitTest,
  pickLabels,
  revealFlags,
  revealFromResult,
  screenRadius,
  toScreenX,
  toScreenY,
} from "./memoryMapMarks";

const TYPES: MemoryNodeType[] = ["function", "class", "decision", "concept"];

/** Deterministic sample warren: `sizes` nodes per territory in the payload,
    `counts` total per territory, a chain plus chords inside each territory
    and a few cross links. */
function sampleGraph(
  sizes: Record<string, number>,
  counts: Record<string, number> = sizes,
  landed: Record<string, string> = {},
): MemoryGraph {
  const ids = Object.keys(sizes);
  const nodes: MemoryGraphNode[] = [];
  const edges: Array<readonly [number, number]> = [];
  const first = new Map<string, number>();
  ids.forEach((tid) => {
    first.set(tid, nodes.length);
    for (let i = 0; i < sizes[tid]!; i++) {
      const at = nodes.length;
      const id = `${tid}/n${i}`;
      nodes.push({
        id,
        territoryId: tid,
        type: TYPES[i % TYPES.length]!,
        label: `${tid} node ${i}`,
        score: 100 - i,
        x: Math.cos(i * 2.4) * (10 + i * 3),
        y: Math.sin(i * 2.4) * (10 + i * 3),
        stale: false,
        landedReceiptId: landed[id] ?? null,
      });
      if (i > 0) edges.push([at, at - 1]);
      if (i > 3) edges.push([at, at - 3]);
    }
  });
  for (let t = 1; t < ids.length; t++) edges.push([first.get(ids[t]!)!, first.get(ids[t - 1]!)!]);
  return {
    revision: 1,
    territories: ids.map((id, i) => ({
      id,
      label: id,
      project: i % 2 ? "web" : "api",
      nodeCount: counts[id]!,
      dominantType: "function",
      recalled: i !== 0,
      x: Math.cos(i) * 5,
      y: Math.sin(i) * 5,
    })),
    territoryEdges: [],
    nodes,
    edges: edges.map(([a, b]) => [a, b] as const),
  };
}

describe("buildScene", () => {
  it("draws one mark per territory and aggregates cross-territory edges", () => {
    const graph = sampleGraph({ auth: 5, billing: 8, webhooks: 3 });
    const scene = buildScene(graph, { kind: "territories" });
    assert.deepEqual(
      scene.marks.map((m) => m.kind),
      ["territory", "territory", "territory"],
    );
    assert.equal(scene.marks[0]!.id, "billing");
    assert.isTrue(scene.marks.find((m) => m.id === "auth")!.muted);
    assert.equal(scene.edges.length, 2);
    assert.isTrue(scene.edges.every((e) => e.weight === 1));
  });

  it("caps a large territory at the mark and edge budget", () => {
    const graph = sampleGraph({ big: 400, a: 2, b: 2 }, { big: 900, a: 2, b: 2 });
    const scene = buildScene(graph, { kind: "territory", territoryId: "big" });
    assert.isAtMost(scene.marks.length, MAX_MARKS);
    assert.isAtMost(scene.edges.length, MAX_EDGES);
    assert.isTrue(scene.edges.every((e) => e.a < scene.marks.length && e.b < scene.marks.length));
    const nodes = scene.marks.filter((m) => m.kind === "node");
    // Highest scores win the budget.
    assert.equal(nodes[0]!.id, "big/n0");
    const more = scene.marks.find((m) => m.kind === "more")!;
    assert.equal(more.count, 900 - nodes.length);
    assert.equal(more.label, `+${(900 - nodes.length).toLocaleString("en-US")} more`);
  });

  it("adds a +N more mark only when the territory has nodes beyond the payload", () => {
    const graph = sampleGraph({ auth: 40, billing: 5 }, { auth: 131, billing: 5 });
    const auth = buildScene(graph, { kind: "territory", territoryId: "auth" });
    assert.equal(auth.marks.find((m) => m.kind === "more")?.label, "+91 more");
    const billing = buildScene(graph, { kind: "territory", territoryId: "billing" });
    assert.isUndefined(billing.marks.find((m) => m.kind === "more"));
    assert.deepEqual(
      billing.marks.filter((m) => m.kind === "stub").map((m) => m.id),
      ["auth"],
    );
  });

  it("pins reveal hits and landed nodes ahead of higher scores", () => {
    const graph = sampleGraph({ big: 300 }, { big: 300 }, { "big/n299": "a3f9c2e" });
    const scene = buildScene(
      graph,
      { kind: "territory", territoryId: "big" },
      { litReceiptId: "a3f9c2e", pinned: new Set(["big/n250"]) },
    );
    const ids = scene.marks.map((m) => m.id);
    assert.include(ids, "big/n299");
    assert.include(ids, "big/n250");
    assert.equal(scene.marks.find((m) => m.id === "big/n299")!.landed, 1);
  });

  it("lens shows the focus, full-strength 1-hop, faded 2-hop, and culls the rest", () => {
    const graph = sampleGraph({ auth: 30 });
    const scene = buildScene(graph, { kind: "lens", territoryId: "auth", nodeId: "auth/n10" });
    const byId = new Map(scene.marks.map((m) => [m.id, m]));
    assert.equal(byId.get("auth/n10")!.hop, 0);
    // Neighbors of n10: n9, n11, n7, n13.
    for (const id of ["auth/n9", "auth/n11", "auth/n7", "auth/n13"]) {
      assert.equal(byId.get(id)!.hop, 1);
      assert.equal(byId.get(id)!.alpha, 1);
    }
    // n8 is two hops out (n9 -> n8), n20 is far away.
    assert.equal(byId.get("auth/n8")!.hop, 2);
    assert.isBelow(byId.get("auth/n8")!.alpha, 1);
    assert.isFalse(byId.has("auth/n20"));
  });

  it("falls back up the hierarchy when ids disappear", () => {
    const graph = sampleGraph({ auth: 3 });
    assert.deepEqual(buildScene(graph, { kind: "territory", territoryId: "gone" }).view, {
      kind: "territories",
    });
    assert.deepEqual(buildScene(graph, { kind: "lens", territoryId: "auth", nodeId: "x" }).view, {
      kind: "territory",
      territoryId: "auth",
    });
  });
});

describe("hitTest", () => {
  it("returns the nearest mark under the point and -1 on empty space", () => {
    const graph = sampleGraph({ auth: 12 });
    const scene = buildScene(graph, { kind: "territory", territoryId: "auth" });
    const viewport = { w: 800, h: 600 };
    const camera = fitCamera(scene.marks, viewport, { top: 0, right: 0, bottom: 0, left: 0 });
    scene.marks.forEach((mark, i) => {
      const x = toScreenX(camera, viewport, mark.x);
      const y = toScreenY(camera, viewport, mark.y);
      assert.equal(hitTest(scene.marks, camera, viewport, x, y), i);
      assert.equal(
        hitTest(scene.marks, camera, viewport, x + screenRadius(mark, camera.k) + 2, y) >= 0,
        true,
      );
    });
    assert.equal(hitTest(scene.marks, camera, viewport, -500, -500), -1);
  });
});

describe("pickLabels", () => {
  it("keeps the top K by priority and rejects overlapping boxes", () => {
    const box = (index: number, x: number, priority: number, force = false) => ({
      index,
      x0: x,
      y0: 0,
      x1: x + 50,
      y1: 16,
      priority,
      force,
    });
    assert.deepEqual(pickLabels([box(0, 0, 1), box(1, 20, 5), box(2, 100, 3)], 5), [1, 2]);
    assert.deepEqual(pickLabels([box(0, 0, 1), box(1, 100, 5), box(2, 200, 3)], 2), [1, 2]);
    assert.deepEqual(pickLabels([box(0, 0, 9), box(1, 10, 1, true)], 1), [1]);
  });
});

describe("reveal", () => {
  it("lights hits and path, dims the rest, and picks the territory with the most hit score", () => {
    const graph = sampleGraph({ auth: 6, webhooks: 6 });
    const reveal = revealFromResult(graph, "retry", {
      hits: [
        {
          nodeId: "webhooks/n1",
          scope: "warren",
          territoryId: "webhooks",
          type: "function",
          summary: "",
          score: 4,
          matched: ["retry"],
        },
        {
          nodeId: "auth/n0",
          scope: "warren",
          territoryId: "auth",
          type: "function",
          summary: "",
          score: 1,
          matched: ["retry"],
        },
      ],
      pathIds: ["webhooks/n1", "webhooks/n2", "auth/n0"],
      approxTokens: 2100,
    });
    assert.equal(reveal.bestTerritoryId, "webhooks");
    assert.equal(reveal.lit.size, 3);
    const scene = buildScene(graph, { kind: "territory", territoryId: "webhooks" });
    const flags = revealFlags(scene, reveal)!;
    const flagOf = (id: string) => flags[scene.marks.findIndex((m) => m.id === id)];
    assert.equal(flagOf("webhooks/n1"), 2);
    assert.equal(flagOf("webhooks/n2"), 1);
    assert.equal(flagOf("webhooks/n4"), 0);
    assert.isNull(revealFlags(scene, null));
  });
});
