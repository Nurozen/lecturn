import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import type { Atom } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createPendingThreadOrder } from "../features/threads/threadOrder";
import { makeThreadShellFixture } from "../test-fixtures";
import { appAtomRegistry } from "./atom-registry";
import {
  beginPendingThreadOrder,
  getPendingThreadOrder,
  pendingThreadOrderAtom,
} from "./thread-order";
import { environmentThreadShells } from "./threads";
import { queuedThreadKeysAtom } from "./use-thread-outbox";

vi.mock("./atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentThreadShells: { threadShellsAtom: Atom.make([]).pipe(Atom.keepAlive) } };
});
vi.mock("./projects", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentProjects: { projectsAtom: Atom.make([]).pipe(Atom.keepAlive) } };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentServerConfigsAtom: Atom.make(
      new Map([["env", { environment: { capabilities: { threadSettlement: true } } }]]),
    ).pipe(Atom.keepAlive),
  };
});
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return { queuedThreadKeysAtom: Atom.make(new Set<string>()).pipe(Atom.keepAlive) };
});

// The mocked shell source is writable so tests can deliver canonical upserts.
const shellsAtom = environmentThreadShells.threadShellsAtom as Atom.Writable<
  readonly EnvironmentThreadShell[],
  readonly EnvironmentThreadShell[]
>;

const queuedKeysAtom = queuedThreadKeysAtom as Atom.Writable<
  ReadonlySet<string>,
  ReadonlySet<string>
>;

function fixture() {
  // The shared section helper also reads lineage/settled/snooze fields, so
  // partial casts break when it grows — build complete shells instead.
  const rows = ["a", "b"].map((id, index) =>
    makeThreadShellFixture({
      id: ThreadId.make(id),
      environmentId: EnvironmentId.make("env"),
      projectId: ProjectId.make("project"),
      createdAt: `2026-06-01T0${2 - index}:00:00.000Z`,
    }),
  );
  appAtomRegistry.set(shellsAtom, rows);
  const pending = createPendingThreadOrder({
    section: "active",
    ordered: rows,
    movedId: "env:b",
    direction: "up",
    assignments: [
      { id: "env:b", orderKey: "aa" },
      { id: "env:a", orderKey: "bb" },
    ],
  });
  const start = () => beginPendingThreadOrder(pending);
  const upsert = (id: string, key: string) => {
    const current = appAtomRegistry.get(shellsAtom);
    appAtomRegistry.set(
      shellsAtom,
      current.map((row) => (row.id === id ? { ...row, activeOrderKey: key } : row)),
    );
  };
  return { rows, start, upsert };
}

afterEach(() => appAtomRegistry.reset());

describe("shared mobile pending move", () => {
  it("blocks another pickup after receipts and clears on final canonical upsert", () => {
    const { start, upsert } = fixture();
    const move = start();
    move.complete();
    expect(getPendingThreadOrder()).not.toBeNull();
    upsert("b", "aa");
    expect(getPendingThreadOrder()).not.toBeNull();
    upsert("a", "bb");
    expect(getPendingThreadOrder()).toBeNull();
    expect(move.isPending()).toBe(false);
  });

  it("waits for receipts when shells arrive first", () => {
    const { start, upsert } = fixture();
    const move = start();
    upsert("b", "aa");
    upsert("a", "bb");
    expect(getPendingThreadOrder()).not.toBeNull();
    move.complete();
    expect(getPendingThreadOrder()).toBeNull();
  });

  it.each(["failure", "interruption"])("releases a %s without restoring old canonical keys", () => {
    const { start, upsert } = fixture();
    const move = start();
    upsert("b", "aa");
    move.cancel();
    expect(getPendingThreadOrder()).toBeNull();
    expect(appAtomRegistry.get(shellsAtom)[1]?.activeOrderKey).toBe("aa");
    const next = start();
    move.cancel();
    expect(next.isPending()).toBe(true);
    next.cancel();
  });

  it("stops remaining writes when a canonical membership change invalidates the move", () => {
    const { rows, start } = fixture();
    const move = start();
    appAtomRegistry.set(shellsAtom, rows.slice(1));
    expect(move.isPending()).toBe(false);
    expect(appAtomRegistry.get(pendingThreadOrderAtom)).toBeNull();
    move.complete();
    appAtomRegistry.set(shellsAtom, rows);
    expect(getPendingThreadOrder()).toBeNull();
  });
});

it("reconciles only its owning project section and detects new members there", () => {
  const { rows, upsert } = fixture();
  const pending = createPendingThreadOrder({
    section: "active",
    ordered: rows,
    movedId: "env:b",
    direction: "up",
    assignments: [
      { id: "env:b", orderKey: "aa" },
      { id: "env:a", orderKey: "bb" },
    ],
    scopeProjectKeys: ["env:project"],
  });
  const move = beginPendingThreadOrder(pending);
  const foreign = {
    ...rows[0]!,
    id: ThreadId.make("foreign"),
    projectId: ProjectId.make("elsewhere"),
  };
  appAtomRegistry.set(shellsAtom, [...rows, foreign]);
  expect(move.isPending()).toBe(true);
  upsert("b", "aa");
  expect(getPendingThreadOrder()?.confirmed.has("env:b")).toBe(true);
  appAtomRegistry.set(shellsAtom, [
    ...appAtomRegistry.get(shellsAtom),
    { ...rows[0]!, id: ThreadId.make("new-member") },
  ]);
  expect(move.isPending()).toBe(false);
  expect(appAtomRegistry.get(shellsAtom).find((row) => row.id === "b")?.activeOrderKey).toBe("aa");
});

it("invalidates a scoped move when a settled member gains a queued message", () => {
  const { rows } = fixture();
  const settled = {
    ...rows[0]!,
    id: ThreadId.make("settled"),
    settledOverride: "settled" as const,
  };
  appAtomRegistry.set(shellsAtom, [...rows, settled]);
  const move = beginPendingThreadOrder(
    createPendingThreadOrder({
      section: "active",
      ordered: rows,
      movedId: "env:b",
      direction: "up",
      assignments: [
        { id: "env:b", orderKey: "aa" },
        { id: "env:a", orderKey: "bb" },
      ],
      scopeProjectKeys: ["env:project"],
    }),
  );
  expect(move.isPending()).toBe(true);
  appAtomRegistry.set(queuedKeysAtom, new Set(["env:settled"]));
  expect(appAtomRegistry.get(pendingThreadOrderAtom)).toBeNull();
  expect(move.isPending()).toBe(false);
});

it("ignores foreign queued members but invalidates a move when its queued member drains", () => {
  const { rows } = fixture();
  const settled = { ...rows[0]!, settledOverride: "settled" as const };
  const foreign = { ...settled, id: ThreadId.make("foreign"), projectId: ProjectId.make("other") };
  appAtomRegistry.set(shellsAtom, [settled, rows[1]!, foreign]);
  appAtomRegistry.set(queuedKeysAtom, new Set(["env:a"]));
  const move = beginPendingThreadOrder(
    createPendingThreadOrder({
      section: "active",
      ordered: [settled, rows[1]!],
      movedId: "env:b",
      direction: "up",
      assignments: [
        { id: "env:b", orderKey: "aa" },
        { id: "env:a", orderKey: "bb" },
      ],
      scopeProjectKeys: ["env:project"],
    }),
  );
  appAtomRegistry.set(queuedKeysAtom, new Set(["env:a", "env:foreign"]));
  expect(move.isPending()).toBe(true);
  appAtomRegistry.set(queuedKeysAtom, new Set(["env:foreign"]));
  expect(appAtomRegistry.get(pendingThreadOrderAtom)).toBeNull();
  expect(move.isPending()).toBe(false);
});
