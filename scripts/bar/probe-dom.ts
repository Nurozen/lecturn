// @effect-diagnostics nodeBuiltinImport:off - Host-side checklist tooling reading JSON files from the repo.

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * A mechanical presence check for one checklist row. Probes name DOM
 * structure (hooks and roles), never mockup strings; the only literal text
 * they match is UI copy Lecturn itself renders.
 */
export type Probe =
  | {
      readonly kind: "count";
      readonly selector: string;
      readonly min?: number;
      readonly max?: number;
    }
  | { readonly kind: "absent"; readonly selector: string }
  | {
      readonly kind: "text";
      readonly selector: string;
      readonly equals?: string;
      readonly pattern?: string;
    }
  | {
      readonly kind: "each";
      readonly selector: string;
      readonly min?: number;
      readonly probes: ReadonlyArray<Probe>;
    }
  | { readonly kind: "some"; readonly selector: string; readonly probes: ReadonlyArray<Probe> }
  | { readonly kind: "frame"; readonly selector: string; readonly probes: ReadonlyArray<Probe> }
  | { readonly kind: "chart-points"; readonly selector: string; readonly min: number }
  | { readonly kind: "all"; readonly probes: ReadonlyArray<Probe> };

export interface ChecklistRow {
  readonly id: string;
  readonly element: string;
  readonly owner: string | null;
  readonly scenes: ReadonlyArray<string>;
  /** Null when only a critic can judge the row (native mobile, color, placement). */
  readonly probe: Probe | null;
}

export interface Checklist {
  readonly mockup: string;
  readonly scenes: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ChecklistRow>;
  /** sha256 over the canonical rows; a changed row needs a plan deviation entry. */
  readonly rowsHash: string;
}

export const CHECKLIST_NAMES = ["desktop", "mobile", "embed"] as const;
export type ChecklistName = (typeof CHECKLIST_NAMES)[number];

const CHECKLIST_DIR = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "checklists",
);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function checklistRowsHash(rows: ReadonlyArray<ChecklistRow>): string {
  return `sha256:${NodeCrypto.createHash("sha256").update(canonicalJson(rows)).digest("hex")}`;
}

export async function loadChecklist(name: ChecklistName): Promise<Checklist> {
  const text = await NodeFSP.readFile(NodePath.join(CHECKLIST_DIR, `${name}.json`), "utf8");
  return JSON.parse(text) as Checklist;
}

/** Structural problems in a checklist file; empty when it is well formed and its hash holds. */
export function checklistProblems(checklist: Checklist): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const scenes = new Set(checklist.scenes);
  const ids = new Set<string>();
  const checkProbe = (rowId: string, probe: Probe): void => {
    if (probe.kind !== "all" && probe.selector.trim() === "") {
      problems.push(`${rowId}: ${probe.kind} probe has an empty selector`);
    }
    if (probe.kind === "text" && (probe.equals === undefined) === (probe.pattern === undefined)) {
      problems.push(`${rowId}: text probe needs exactly one of equals or pattern`);
    }
    if ("probes" in probe) {
      if (probe.probes.length === 0) problems.push(`${rowId}: ${probe.kind} probe has no probes`);
      for (const inner of probe.probes) checkProbe(rowId, inner);
    }
  };
  for (const row of checklist.rows) {
    if (ids.has(row.id)) problems.push(`${row.id}: duplicate row id`);
    ids.add(row.id);
    if (row.scenes.length === 0) problems.push(`${row.id}: names no scene`);
    for (const scene of row.scenes) {
      if (!scenes.has(scene)) problems.push(`${row.id}: unknown scene ${scene}`);
    }
    if (row.probe !== null) checkProbe(row.id, row.probe);
  }
  const hash = checklistRowsHash(checklist.rows);
  if (hash !== checklist.rowsHash) {
    problems.push(`rows changed: hash is ${hash}, file records ${checklist.rowsHash}`);
  }
  return problems;
}

/** The queries a probe needs, over a page, an element scope or a frame. */
export interface ProbeRoot {
  readonly count: (selector: string) => Promise<number>;
  readonly texts: (selector: string) => Promise<ReadonlyArray<string>>;
  readonly scopes: (selector: string) => Promise<ReadonlyArray<ProbeRoot>>;
  readonly frame: (selector: string) => Promise<ProbeRoot | null>;
  readonly pointCounts: (selector: string) => Promise<ReadonlyArray<number>>;
}

export type ProbeOutcome =
  | { readonly passed: true }
  | { readonly passed: false; readonly reason: string };

const pass: ProbeOutcome = { passed: true };
const fail = (reason: string): ProbeOutcome => ({ passed: false, reason });

export async function evaluateProbe(probe: Probe, root: ProbeRoot): Promise<ProbeOutcome> {
  switch (probe.kind) {
    case "count": {
      const count = await root.count(probe.selector);
      const min = probe.min ?? 1;
      if (count < min) return fail(`${probe.selector}: ${count} found, expected at least ${min}`);
      if (probe.max !== undefined && count > probe.max) {
        return fail(`${probe.selector}: ${count} found, expected at most ${probe.max}`);
      }
      return pass;
    }
    case "absent": {
      const count = await root.count(probe.selector);
      return count === 0 ? pass : fail(`${probe.selector}: ${count} found, expected none`);
    }
    case "text": {
      const texts = (await root.texts(probe.selector)).map((text) =>
        text.trim().replace(/\s+/gu, " "),
      );
      const pattern = probe.pattern === undefined ? null : new RegExp(probe.pattern, "u");
      const matched = texts.some((text) => (pattern ? pattern.test(text) : text === probe.equals));
      return matched
        ? pass
        : fail(
            `${probe.selector}: no element with text ${pattern ? `matching /${probe.pattern}/` : JSON.stringify(probe.equals)} (saw ${JSON.stringify(texts.slice(0, 5))})`,
          );
    }
    case "each": {
      const scopes = await root.scopes(probe.selector);
      const min = probe.min ?? 1;
      if (scopes.length < min) {
        return fail(`${probe.selector}: ${scopes.length} found, expected at least ${min}`);
      }
      for (const [index, scope] of scopes.entries()) {
        const outcome = await evaluateProbe({ kind: "all", probes: probe.probes }, scope);
        if (!outcome.passed) return fail(`${probe.selector}[${index}]: ${outcome.reason}`);
      }
      return pass;
    }
    case "some": {
      const scopes = await root.scopes(probe.selector);
      const reasons: Array<string> = [];
      for (const scope of scopes) {
        const outcome = await evaluateProbe({ kind: "all", probes: probe.probes }, scope);
        if (outcome.passed) return pass;
        reasons.push(outcome.reason);
      }
      return fail(
        scopes.length === 0
          ? `${probe.selector}: none found`
          : `${probe.selector}: no match satisfied every probe (${reasons[0]})`,
      );
    }
    case "frame": {
      const frame = await root.frame(probe.selector);
      if (frame === null) return fail(`${probe.selector}: no frame found`);
      const outcome = await evaluateProbe({ kind: "all", probes: probe.probes }, frame);
      return outcome.passed ? pass : fail(`in ${probe.selector}: ${outcome.reason}`);
    }
    case "chart-points": {
      const counts = await root.pointCounts(probe.selector);
      return counts.some((count) => count >= probe.min)
        ? pass
        : fail(
            `${probe.selector}: no shape with at least ${probe.min} points (saw ${JSON.stringify(counts)})`,
          );
    }
    case "all": {
      for (const inner of probe.probes) {
        const outcome = await evaluateProbe(inner, root);
        if (!outcome.passed) return outcome;
      }
      return pass;
    }
  }
}

export type RowResult =
  | { readonly id: string; readonly status: "present" }
  | { readonly id: string; readonly status: "missing"; readonly reason: string }
  /** No mechanical probe; a critic marks it. */
  | { readonly id: string; readonly status: "critic" }
  /** The row is scoped to other scenes and was not probed here. */
  | { readonly id: string; readonly status: "not-in-scene" };

export async function probeScene(
  checklist: Checklist,
  scene: string,
  root: ProbeRoot,
): Promise<ReadonlyArray<RowResult>> {
  if (!checklist.scenes.includes(scene)) {
    throw new Error(`Scene '${scene}' is not one of this checklist's scenes.`);
  }
  const results: Array<RowResult> = [];
  for (const row of checklist.rows) {
    if (!row.scenes.includes(scene)) {
      results.push({ id: row.id, status: "not-in-scene" });
    } else if (row.probe === null) {
      results.push({ id: row.id, status: "critic" });
    } else {
      const outcome = await evaluateProbe(row.probe, root);
      results.push(
        outcome.passed
          ? { id: row.id, status: "present" }
          : { id: row.id, status: "missing", reason: outcome.reason },
      );
    }
  }
  return results;
}

/** Runs in the page; counts the vertices a chart shape draws. */
function countShapePoints(
  elements: ReadonlyArray<{ getAttribute(name: string): string | null; readonly tagName: string }>,
) {
  return elements.map((element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "polyline" || tag === "polygon") {
      const numbers = (element.getAttribute("points") ?? "")
        .trim()
        .split(/[\s,]+/u)
        .filter(Boolean);
      return Math.floor(numbers.length / 2);
    }
    if (tag === "path") {
      return ((element.getAttribute("d") ?? "").match(/[MLHVCSQTA]/giu) ?? []).length;
    }
    return 0;
  });
}

/** The Playwright surface the probes use; Page, Locator and FrameLocator all fit. */
export interface LocatorHost {
  locator(selector: string): ProbeLocator;
}
export interface ProbeLocator extends LocatorHost {
  count(): Promise<number>;
  allInnerTexts(): Promise<Array<string>>;
  all(): Promise<Array<ProbeLocator>>;
  first(): ProbeLocator;
  contentFrame(): LocatorHost;
  evaluateAll<Result>(
    fn: (
      elements: Array<{ getAttribute(name: string): string | null; readonly tagName: string }>,
    ) => Result,
  ): Promise<Result>;
}

export function playwrightProbeRoot(host: LocatorHost): ProbeRoot {
  return {
    count: (selector) => host.locator(selector).count(),
    texts: (selector) => host.locator(selector).allInnerTexts(),
    scopes: async (selector) => (await host.locator(selector).all()).map(playwrightProbeRoot),
    frame: async (selector) => {
      const frames = host.locator(selector);
      return (await frames.count()) === 0
        ? null
        : playwrightProbeRoot(frames.first().contentFrame());
    },
    pointCounts: (selector) => host.locator(selector).evaluateAll(countShapePoints),
  };
}

/** A staged live state a scene must show before it is captured (A38). */
export interface StagingCheck {
  readonly id: string;
  readonly probe: Probe;
}

/** The failed staging checks, as `id: reason`; empty when the scene shows every staged state. */
export async function stagingProblems(
  checks: ReadonlyArray<StagingCheck>,
  root: ProbeRoot,
): Promise<ReadonlyArray<string>> {
  const problems: Array<string> = [];
  for (const check of checks) {
    const outcome = await evaluateProbe(check.probe, root);
    if (!outcome.passed) problems.push(`${check.id}: ${outcome.reason}`);
  }
  return problems;
}
