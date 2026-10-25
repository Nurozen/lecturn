import { assert, expect, it } from "@effect/vitest";

import {
  CHECKLIST_NAMES,
  type Checklist,
  checklistProblems,
  checklistRowsHash,
  evaluateProbe,
  loadChecklist,
  type ProbeRoot,
  probeScene,
} from "./probe-dom.ts";

interface FakeNode {
  readonly text?: string;
  readonly points?: number;
  readonly children?: FakeTree;
  readonly frame?: FakeTree;
}
type FakeTree = Readonly<Record<string, ReadonlyArray<FakeNode>>>;

function fakeRoot(tree: FakeTree, queried: Array<string> = []): ProbeRoot {
  const nodes = (selector: string) => {
    queried.push(selector);
    return tree[selector] ?? [];
  };
  return {
    count: async (selector) => nodes(selector).length,
    texts: async (selector) => nodes(selector).map((node) => node.text ?? ""),
    scopes: async (selector) =>
      nodes(selector).map((node) => fakeRoot(node.children ?? {}, queried)),
    frame: async (selector) => {
      const frame = nodes(selector)[0]?.frame;
      return frame === undefined ? null : fakeRoot(frame, queried);
    },
    pointCounts: async (selector) => nodes(selector).map((node) => node.points ?? 0),
  };
}

it("keeps every checklist well formed and frozen by its recorded hash", async () => {
  for (const name of CHECKLIST_NAMES) {
    const checklist = await loadChecklist(name);
    assert.deepEqual(checklistProblems(checklist), [], name);
  }
});

it("detects an edited row through the hash", async () => {
  const checklist = await loadChecklist("embed");
  const [first, ...rest] = checklist.rows;
  assert.isDefined(first);
  const edited: Checklist = {
    ...checklist,
    rows: [{ ...first!, element: `${first!.element} (edited)` }, ...rest],
  };
  assert.notEqual(checklistRowsHash(edited.rows), checklist.rowsHash);
  assert.match(checklistProblems(edited).join("\n"), /rows changed/u);
});

it("probes a scene-scoped row only on the scenes it names", async () => {
  const checklist = await loadChecklist("embed");
  const withSwitcher = { '[data-testid="embed-thread-switcher"]': [{}] };

  const timeline = await probeScene(checklist, "embed-host-timeline", fakeRoot(withSwitcher));
  const byId = (results: typeof timeline) => new Map(results.map((result) => [result.id, result]));
  assert.equal(byId(timeline).get("embed.pane.no-switcher")?.status, "not-in-scene");
  assert.equal(byId(timeline).get("embed.pane.compact-switcher")?.status, "present");

  const mockup = await probeScene(checklist, "embed-host-mockup-scene", fakeRoot(withSwitcher));
  assert.equal(byId(mockup).get("embed.pane.no-switcher")?.status, "missing");
  assert.equal(byId(mockup).get("embed.pane.compact-switcher")?.status, "not-in-scene");
  assert.equal(byId(mockup).get("embed.pane.header")?.status, "critic");

  const queried: Array<string> = [];
  await probeScene(checklist, "embed-host-full-access", fakeRoot({}, queried));
  assert.notInclude(queried, '[data-testid="app-ref-chip-strip"]');
  await expect(probeScene(checklist, "desktop-scene", fakeRoot({}))).rejects.toThrow(/not one of/u);
});

it("evaluates count, absent and text probes", async () => {
  const root = fakeRoot({
    ".stat": [{}, {}, {}],
    ".label": [{ text: "  Settled  (3) " }, { text: "Pinned" }],
  });
  assert.isTrue(
    (await evaluateProbe({ kind: "count", selector: ".stat", min: 3, max: 3 }, root)).passed,
  );
  assert.isFalse((await evaluateProbe({ kind: "count", selector: ".stat", max: 2 }, root)).passed);
  assert.isFalse((await evaluateProbe({ kind: "count", selector: ".missing" }, root)).passed);
  assert.isTrue((await evaluateProbe({ kind: "absent", selector: ".missing" }, root)).passed);
  assert.isFalse((await evaluateProbe({ kind: "absent", selector: ".stat" }, root)).passed);
  assert.isTrue(
    (await evaluateProbe({ kind: "text", selector: ".label", equals: "Pinned" }, root)).passed,
  );
  assert.isTrue(
    (
      await evaluateProbe(
        { kind: "text", selector: ".label", pattern: "^Settled \\(\\d+\\)$" },
        root,
      )
    ).passed,
  );
  assert.isFalse(
    (await evaluateProbe({ kind: "text", selector: ".label", equals: "Active" }, root)).passed,
  );
});

it("requires every scope for each, one scope for some, and reaches into frames", async () => {
  const icon = { ".icon": [{}] };
  const root = fakeRoot({
    ".row": [{ children: icon }, { children: {} }],
    ".card": [
      { frame: { "[data-card-stat]": [{}, {}, {}], "svg path": [{ points: 1 }, { points: 9 }] } },
    ],
  });
  const iconProbe = [{ kind: "count", selector: ".icon" }] as const;
  const each = await evaluateProbe({ kind: "each", selector: ".row", probes: iconProbe }, root);
  assert.isFalse(each.passed);
  if (!each.passed) assert.match(each.reason, /\.row\[1\]/u);
  assert.isTrue(
    (await evaluateProbe({ kind: "some", selector: ".row", probes: iconProbe }, root)).passed,
  );
  assert.isFalse(
    (await evaluateProbe({ kind: "each", selector: ".row", min: 3, probes: iconProbe }, root))
      .passed,
  );
  const card = await evaluateProbe(
    {
      kind: "frame",
      selector: ".card",
      probes: [
        { kind: "count", selector: "[data-card-stat]", min: 3, max: 3 },
        { kind: "chart-points", selector: "svg path", min: 2 },
      ],
    },
    root,
  );
  assert.isTrue(card.passed);
  assert.isFalse(
    (await evaluateProbe({ kind: "frame", selector: ".none", probes: iconProbe }, root)).passed,
  );
  assert.isFalse(
    (await evaluateProbe({ kind: "chart-points", selector: ".card", min: 2 }, root)).passed,
  );
});
