import {
  EnvironmentId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  SquireId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { v2Now, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import { isThreadWorking } from "./threadInbox.ts";
import {
  childThreadInputsTitle,
  createEnvironmentThreadShellAtoms,
  isListedThread,
  runningThreadCount,
} from "./threadShell.ts";

const environmentId = EnvironmentId.make("environment-v2");
const remoteEnvironmentId = EnvironmentId.make("remote-environment-v2");
const otherProjectId = ProjectId.make("other-project");

function makeHarness(environmentIds: ReadonlyArray<EnvironmentId> = [environmentId]) {
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(v2ShellSnapshot),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map(
      environmentIds.map((id) => [
        id,
        {
          target: new PrimaryConnectionTarget({
            environmentId: id,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  });
  const serverConfigAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<{
      readonly environment: { readonly capabilities: { readonly squire?: boolean } };
    } | null>(null),
  );
  return {
    registry: AtomRegistry.make(),
    snapshotAtom,
    catalogValueAtom,
    serverConfigAtom,
    threads: createEnvironmentThreadShellAtoms({
      catalogValueAtom,
      snapshotAtom,
      serverConfigAtom,
    }),
  };
}

const squireThreads = () => {
  const home = {
    ...v2ThreadShell,
    id: ThreadId.make("squire-home"),
    squire: { squireId: SquireId.make("squire"), role: "home" as const },
  };
  const probe = {
    ...v2ThreadShell,
    id: ThreadId.make("squire-probe"),
    lineage: {
      ...v2ThreadShell.lineage,
      parentThreadId: v2ThreadShell.id,
      relationshipToParent: "fork" as const,
    },
    squire: { squireId: SquireId.make("squire"), role: "probe" as const },
  };
  return { home, probe };
};

describe("v2 thread shell lists", () => {
  it("preserves ordered reference arrays when a middle thread changes", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const snapshot = {
      ...v2ShellSnapshot,
      threads: ["a", "b", "c"].map((id) => ({ ...v2ThreadShell, id: ThreadId.make(id) })),
    };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.threadRefsAtom);
    const before = registry.get(threads.threadRefsAtom);
    registry.set(
      snapshotAtom(environmentId),
      applyShellStreamEvent(snapshot, {
        kind: "thread.updated",
        location: "active",
        sequence: 1,
        thread: { ...snapshot.threads[1]!, title: "Updated" },
      }),
    );
    expect(registry.get(threads.threadRefsAtom)).toBe(before);
    dispose();
    registry.dispose();
  });

  it("keeps navigation stable on hidden subagent updates and retains user forks", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const child = {
      ...root,
      id: ThreadId.make("child"),
      lineage: {
        ...root.lineage,
        parentThreadId: root.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const fork = {
      ...child,
      id: ThreadId.make("fork"),
      lineage: { ...child.lineage, relationshipToParent: "fork" as const },
    };
    const snapshot = { ...v2ShellSnapshot, threads: [root, child, fork] };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    const before = registry.get(threads.navigationThreadShellsAtom);
    expect(before.map((thread) => thread.id)).toEqual([root.id, fork.id]);
    registry.set(snapshotAtom(environmentId), {
      ...snapshot,
      threads: [root, { ...child, title: "Child streaming" }, fork],
    });
    expect(registry.get(threads.navigationThreadShellsAtom)).toBe(before);
    expect(registry.get(threads.threadShellsAtom)).toHaveLength(3);
    dispose();
    registry.dispose();
  });

  it("counts a subagent question on its parent only while the subagent runs", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const child = {
      ...root,
      id: ThreadId.make("child"),
      creationSource: "mcp" as const,
      status: "running" as const,
      activityRunStatus: "running" as const,
      lineage: {
        ...root.lineage,
        parentThreadId: root.id,
        relationshipToParent: "subagent" as const,
      },
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("question"),
        kind: "user_input" as const,
        createdAt: v2Now,
      },
    };
    const inputs = threads.childThreadInputsAtom({ environmentId, threadId: root.id });
    const dispose = registry.mount(inputs);
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [root, child] });
    expect(registry.get(inputs).map((thread) => thread.id)).toEqual([child.id]);
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...child, status: "queued" as const }],
    });
    expect(registry.get(inputs).map((thread) => thread.id)).toEqual([child.id]);
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...child, status: "completed" as const, activityRunStatus: null }],
    });
    expect(registry.get(inputs)).toEqual([]);
    const { activityRunStatus: _omitted, ...legacyChild } = child;
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...legacyChild, status: "completed" as const }],
    });
    expect(registry.get(inputs)).toEqual([]);
    dispose();
    registry.dispose();
  });

  it("brings a parent back from Working while a nested subagent waits for approval", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const child = {
      ...v2ThreadShell,
      id: ThreadId.make("review"),
      creationSource: "mcp" as const,
      status: "running" as const,
      activityRunStatus: "running" as const,
      lineage: {
        ...v2ThreadShell.lineage,
        parentThreadId: v2ThreadShell.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const grandchild = {
      ...child,
      id: ThreadId.make("review-helper"),
      lineage: { ...child.lineage, parentThreadId: child.id },
    };
    const root = {
      ...v2ThreadShell,
      latestRunId: RunId.make("root-run"),
      status: "completed" as const,
      pendingBackgroundTasks: [
        { taskId: "review", kind: "subagent" as const, childThreadId: child.id },
      ],
    };
    const approval = {
      id: RuntimeRequestId.make("cat-file"),
      kind: "command" as const,
      createdAt: v2Now,
    };
    const parent = threads.threadShellAtom({ environmentId, threadId: root.id });
    const inputs = threads.childThreadInputsAtom({ environmentId, threadId: root.id });
    const disposeParent = registry.mount(parent);
    const disposeInputs = registry.mount(inputs);
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, child, grandchild],
    });
    expect(isThreadWorking(registry.get(parent)!)).toBe(true);

    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, child, { ...grandchild, pendingRuntimeRequest: approval }],
    });
    expect(registry.get(parent)?.pendingSubagentRequest).toBe("approval");
    expect(isThreadWorking(registry.get(parent)!)).toBe(false);
    const asking = registry.get(inputs);
    expect(asking.map((thread) => thread.id)).toEqual([grandchild.id]);
    expect(childThreadInputsTitle(asking)).toBe("Subagent needs approval");

    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, child, grandchild],
    });
    expect(registry.get(parent)?.pendingSubagentRequest).toBeNull();
    expect(isThreadWorking(registry.get(parent)!)).toBe(true);
    disposeInputs();
    disposeParent();
    registry.dispose();
  });

  it("lists a thread unless it is a subagent or a Squire thread its environment hides", () => {
    const { home, probe } = squireThreads();
    const subagent = {
      ...v2ThreadShell,
      lineage: { ...v2ThreadShell.lineage, relationshipToParent: "subagent" as const },
    };
    const squire = { squire: true };
    expect(isListedThread(v2ThreadShell, squire)).toBe(true);
    expect(isListedThread(subagent, undefined)).toBe(false);
    expect(isListedThread(home, squire)).toBe(false);
    expect(isListedThread(probe, squire)).toBe(false);
    expect(isListedThread(home, undefined)).toBe(true);
    expect(isListedThread(probe, null)).toBe(true);
    expect(isListedThread(home, {})).toBe(true);
  });

  it("hides Squire threads only on environments that advertise Squires", () => {
    const { registry, threads, snapshotAtom, serverConfigAtom } = makeHarness([
      environmentId,
      remoteEnvironmentId,
    ]);
    const { home, probe } = squireThreads();
    const snapshot = { ...v2ShellSnapshot, threads: [v2ThreadShell, home, probe] };
    registry.set(snapshotAtom(environmentId), snapshot);
    registry.set(snapshotAtom(remoteEnvironmentId), snapshot);
    const configWith = (squire?: boolean) => ({
      environment: { capabilities: squire === undefined ? {} : { squire } },
    });
    registry.set(serverConfigAtom(environmentId), configWith(true));
    registry.set(serverConfigAtom(remoteEnvironmentId), configWith());
    const disposers = [
      registry.mount(threads.navigationThreadShellsAtom),
      registry.mount(threads.visibleThreadShellsAtom),
      registry.mount(threads.listingCapabilitiesAtom),
    ];
    const keysOf = (shells: ReadonlyArray<{ environmentId: EnvironmentId; id: ThreadId }>) =>
      shells.map(
        (thread) => `${thread.environmentId === environmentId ? "local" : "remote"}:${thread.id}`,
      );
    const listedRemote = [`remote:${v2ThreadShell.id}`, `remote:${home.id}`, `remote:${probe.id}`];

    expect(keysOf(registry.get(threads.navigationThreadShellsAtom))).toEqual([
      `local:${v2ThreadShell.id}`,
      ...listedRemote,
    ]);
    expect(keysOf(registry.get(threads.visibleThreadShellsAtom))).toEqual([
      `local:${v2ThreadShell.id}`,
      ...listedRemote,
    ]);
    expect(registry.get(threads.threadShellsAtom)).toHaveLength(6);
    expect(
      registry
        .get(threads.threadShellsForProjectRefsAtom([{ environmentId, projectId: home.projectId }]))
        .map((thread) => thread.id),
    ).toEqual([v2ThreadShell.id]);

    // Unrelated config churn keeps every list, and the capability map, as it was.
    const listing = registry.get(threads.listingCapabilitiesAtom);
    const navigation = registry.get(threads.navigationThreadShellsAtom);
    registry.set(serverConfigAtom(environmentId), configWith(true));
    expect(registry.get(threads.listingCapabilitiesAtom)).toBe(listing);
    expect(registry.get(threads.navigationThreadShellsAtom)).toBe(navigation);

    // Switching Squires off brings the threads back as ordinary rows.
    registry.set(serverConfigAtom(environmentId), configWith(false));
    expect(registry.get(threads.listingCapabilitiesAtom).size).toBe(0);
    expect(registry.get(threads.visibleThreadShellsAtom)).toBe(
      registry.get(threads.threadShellsAtom),
    );
    expect(keysOf(registry.get(threads.navigationThreadShellsAtom))).toEqual([
      `local:${v2ThreadShell.id}`,
      `local:${home.id}`,
      `local:${probe.id}`,
      ...listedRemote,
    ]);
    for (const dispose of disposers) dispose();
    registry.dispose();
  });

  it.each([
    { reason: "switched-off", state: { enabled: false } },
    {
      reason: "unsupported",
      state: { enabled: true, unsupportedReason: "Use a compatible client." },
    },
  ])("leaves $reason environments out of navigation until restored", ({ state }) => {
    const { registry, threads, catalogValueAtom } = makeHarness([
      environmentId,
      remoteEnvironmentId,
    ]);
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    const environmentsOf = () =>
      new Set(registry.get(threads.navigationThreadShellsAtom).map((t) => t.environmentId));
    expect(environmentsOf()).toEqual(new Set([environmentId, remoteEnvironmentId]));

    const setRemotePaused = (paused: boolean) => {
      const catalog = registry.get(catalogValueAtom);
      const entries = new Map(catalog.entries);
      entries.set(remoteEnvironmentId, {
        ...entries.get(remoteEnvironmentId)!,
        ...(paused ? state : { enabled: true, unsupportedReason: undefined }),
      });
      registry.set(catalogValueAtom, { ...catalog, entries });
    };
    setRemotePaused(true);
    expect(environmentsOf()).toEqual(new Set([environmentId]));
    setRemotePaused(false);
    expect(environmentsOf()).toEqual(new Set([environmentId, remoteEnvironmentId]));
    dispose();
    registry.dispose();
  });

  it("preserves project memberships on updates and keeps the same thread separate per environment", () => {
    const harness = makeHarness([environmentId, remoteEnvironmentId]);
    const otherThread = {
      ...v2ThreadShell,
      id: ThreadId.make("other-thread"),
      projectId: otherProjectId,
    };
    const snapshot = { ...v2ShellSnapshot, threads: [v2ThreadShell, otherThread] };
    harness.registry.set(harness.snapshotAtom(environmentId), snapshot);
    const membershipAtom = harness.threads.environmentThreadRefsByProjectAtom(environmentId);
    const listAtom = harness.threads.threadShellsForProjectRefsAtom([
      { environmentId: remoteEnvironmentId, projectId: v2ThreadShell.projectId },
      { environmentId, projectId: v2ThreadShell.projectId },
    ]);
    const disposeList = harness.registry.mount(listAtom);
    try {
      const membership = harness.registry.get(membershipAtom);
      const before = harness.registry.get(listAtom);
      expect(before).toHaveLength(2);
      expect(before[0]).not.toBe(before[1]);
      expect(before.map((thread) => thread.environmentId)).toEqual([
        remoteEnvironmentId,
        environmentId,
      ]);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        threads: [v2ThreadShell, { ...otherThread, title: "Changed elsewhere" }],
      });
      expect(harness.registry.get(membershipAtom)).toBe(membership);
      expect(harness.registry.get(listAtom)).toBe(before);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        threads: [{ ...v2ThreadShell, projectId: otherProjectId }, otherThread],
      });
      expect(harness.registry.get(listAtom)).toEqual([before[0]]);
      harness.registry.set(harness.snapshotAtom(remoteEnvironmentId), {
        ...v2ShellSnapshot,
        threads: [],
      });
      expect(harness.registry.get(listAtom)).toEqual([]);
    } finally {
      disposeList();
      harness.registry.dispose();
    }
  });

  it("keeps the quiet shell through streaming ticks and follows every change once the run stops", () => {
    const harness = makeHarness();
    const runId = RunId.make("streaming-run");
    const running: OrchestrationV2ThreadShell = {
      ...v2ThreadShell,
      latestRunId: runId,
      activeRunId: runId,
      status: "running",
      itemCount: 1,
      visibleItemCount: 1,
    };
    const setThread = (thread: OrchestrationV2ThreadShell, sequence: number) =>
      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...v2ShellSnapshot,
        snapshotSequence: sequence,
        threads: [thread],
      });
    const at = (seconds: number) => DateTime.add(v2Now, { seconds });
    setThread(running, 1);
    const ref = { environmentId, threadId: v2ThreadShell.id };
    const quietAtom = harness.threads.quietThreadShellAtom(ref);
    const dispose = harness.registry.mount(quietAtom);
    try {
      const first = harness.registry.get(quietAtom);
      setThread({ ...running, updatedAt: at(1), itemCount: 4, visibleItemCount: 3 }, 2);
      expect(harness.registry.get(quietAtom)).toBe(first);
      expect(harness.registry.get(harness.threads.threadShellAtom(ref))?.itemCount).toBe(4);

      setThread({ ...running, updatedAt: at(2), itemCount: 5, title: "Renamed" }, 3);
      const renamed = harness.registry.get(quietAtom);
      expect(renamed?.title).toBe("Renamed");

      const stopped: OrchestrationV2ThreadShell = {
        ...running,
        activeRunId: null,
        status: "completed",
      };
      setThread({ ...stopped, title: "Renamed", updatedAt: at(3) }, 4);
      const completed = harness.registry.get(quietAtom);
      expect(completed).not.toBe(renamed);
      setThread({ ...stopped, title: "Renamed", updatedAt: at(4) }, 5);
      expect(harness.registry.get(quietAtom)?.updatedAt).toBe(DateTime.formatIso(at(4)));
      expect(harness.registry.get(quietAtom)).not.toBe(completed);
    } finally {
      dispose();
      harness.registry.dispose();
    }
  });
});

describe("runningThreadCount", () => {
  const running = (id: string, patch: Partial<OrchestrationV2ThreadShell> = {}) => ({
    ...v2ThreadShell,
    id: ThreadId.make(id),
    status: "running" as const,
    ...patch,
  });

  it("counts top-level threads with a run in flight", () => {
    expect(
      runningThreadCount([
        running("a"),
        running("b", { status: "starting" }),
        running("c", { status: "idle" }),
        running("d", { status: "completed" }),
      ]),
    ).toBe(2);
  });

  it("prefers the activity run, so a queued follow-up behind a finished run is not busy", () => {
    expect(runningThreadCount([running("a", { activityRunStatus: null })])).toBe(0);
    expect(
      runningThreadCount([running("a", { status: "completed", activityRunStatus: "running" })]),
    ).toBe(1);
  });

  it("skips threads waiting on the user, subagents, Squire threads, and archived ones", () => {
    const { home } = squireThreads();
    expect(
      runningThreadCount([
        running("waiting", {
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request"),
            kind: "permission",
            createdAt: v2Now,
          },
        }),
        running("child", {
          lineage: {
            ...v2ThreadShell.lineage,
            parentThreadId: v2ThreadShell.id,
            relationshipToParent: "subagent",
          },
        }),
        { ...home, status: "running" },
        running("archived", { archivedAt: v2Now }),
      ]),
    ).toBe(0);
  });
});
