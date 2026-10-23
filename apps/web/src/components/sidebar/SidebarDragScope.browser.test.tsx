import type { DndContextProps, DragEndEvent } from "@dnd-kit/core";
import type { SortableContextProps } from "@dnd-kit/sortable";
import { scopeThreadRef, scopedThreadKey } from "@lecturn/client-runtime/environment";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@lecturn/contracts";
import { act, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Cause } from "effect";
import type { SidebarLists } from "./sidebarDragScope.logic";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SidebarDragBoundary, SidebarDragScope, ScopedSortableThreadRow } from "./SidebarDragScope";
import { sidebarMarkerId } from "../Sidebar.logic";
import { makeThreadFixture } from "../../test-fixtures";

const state = vi.hoisted(() => ({
  configs: new Map<string, { environment: { capabilities: Record<string, boolean> } }>(),
  accounts: new Map<string, string>(),
  known: { needsSignIn: [] as string[] },
  readOnly: new Set<string>(),
  grantListeners: new Set<() => void>(),
  grantVersion: 0,
  setNodeRef: vi.fn(),
  useSortable: vi.fn(),
  // Latest props of the (mocked) dnd-kit providers, read the way the
  // react-test-renderer suite read `findByType(...).props`.
  dnd: null as unknown as DndContextProps,
  sortable: null as unknown as SortableContextProps,
}));
vi.mock(import("../../state/server"), async (original) => ({
  ...(await original()),
  environmentServerConfigsAtom: "configs" as never,
}));
vi.mock(import("../../cloud/connectAccounts"), async (original) => ({
  ...(await original()),
  accountByEnvironmentIdAtom: "accounts" as never,
}));
vi.mock(import("../../cloud/knownAccounts"), async (original) => ({
  ...(await original()),
  knownConnectAccountsAtom: "known" as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const useGrants = () =>
    useSyncExternalStore(
      (listener) => {
        state.grantListeners.add(listener);
        return () => state.grantListeners.delete(listener);
      },
      () => state.grantVersion,
    );
  return {
    ...(await original()),
    readEnvironmentScope: ((environmentId: string) => !state.readOnly.has(environmentId)) as never,
    useEnvironmentScope: ((environmentId: string) => {
      useGrants();
      return !state.readOnly.has(environmentId);
    }) as never,
    useEnvironmentsWithScope: ((environments: ReadonlyArray<{ environmentId: string }>) => {
      useGrants();
      return new Set(
        environments
          .map(({ environmentId }) => environmentId)
          .filter((environmentId) => !state.readOnly.has(environmentId)),
      );
    }) as never,
  };
});
function changeGrants(change: () => void) {
  change();
  state.grantVersion += 1;
  for (const listener of state.grantListeners) listener();
}
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: keyof typeof state) => state[atom]) as never,
}));
vi.mock(import("../ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: vi.fn() } as never,
  stackedThreadToast: vi.fn() as never,
}));
vi.mock(import("@dnd-kit/core"), async (original) => ({
  ...(await original()),
  DndContext: ((props: DndContextProps & { children: ReactNode }) => {
    state.dnd = props;
    return <>{props.children}</>;
  }) as never,
}));
vi.mock(import("@dnd-kit/sortable"), async (original) => ({
  ...(await original()),
  SortableContext: ((props: SortableContextProps & { children: ReactNode }) => {
    state.sortable = props;
    return <>{props.children}</>;
  }) as never,
  useSortable: ((args: unknown) => {
    state.useSortable(args);
    return { setNodeRef: state.setNodeRef, transform: null, transition: undefined };
  }) as never,
}));

type Actions = ComponentProps<typeof SidebarDragScope>["actions"];
const success = AsyncResult.success({ sequence: 1 });
const unpin = vi.fn<Actions["unpinThread"]>(async () => success);
const reorder = vi.fn<Actions["reorderActiveThread"]>(async () => success);
const actions = {
  pinThread: vi.fn(async () => success),
  unpinThread: unpin,
  unsettleThread: vi.fn(async () => success),
  unsnoozeThread: vi.fn(async () => success),
  reorderActiveThread: reorder,
  reorderPinnedThread: vi.fn(async () => success),
  archiveThread: vi.fn<Actions["archiveThread"]>(),
  unarchiveThread: vi.fn<Actions["unarchiveThread"]>(),
  deleteThread: vi.fn<Actions["deleteThread"]>(),
  confirmAndDeleteThread: vi.fn<Actions["confirmAndDeleteThread"]>(),
  settleThread: vi.fn<Actions["settleThread"]>(),
  snoozeThread: vi.fn<Actions["snoozeThread"]>(),
  confirmAndUnpinThread: vi.fn<Actions["confirmAndUnpinThread"]>(),
  setThreadAutoSettle: vi.fn<Actions["setThreadAutoSettle"]>(),
  markThreadUnread: vi.fn<Actions["markThreadUnread"]>(),
} satisfies Actions;
const key = (row: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(row.environmentId, row.id));
function thread(id: string, environmentId: string, pinned = false): EnvironmentThreadShell {
  return makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make(environmentId),
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    createdAt: "2026-03-09T10:00:00Z",
    updatedAt: "2026-03-09T10:00:00Z",
    pinnedAt: pinned ? "2026-03-09T10:00:00Z" : null,
  });
}
let mounted: { root: Root; container: HTMLDivElement } | null = null;
async function render(element: ReactElement) {
  if (!mounted) {
    const container = document.createElement("div");
    document.body.append(container);
    mounted = { root: createRoot(container), container };
  }
  const { root } = mounted;
  await act(async () => root.render(element));
}
async function unmount() {
  const current = mounted;
  mounted = null;
  if (!current) return;
  await act(async () => current.root.unmount());
  current.container.remove();
}
const dndContext = () =>
  state.dnd as Required<DndContextProps> & {
    sensors: Array<{
      options: { onAttach(sensor: unknown): void; onFinish(cancelled: boolean): void };
    }>;
  };
const projectedText = () => mounted!.container.querySelector("div")!.textContent;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.accounts.clear();
  state.known.needsSignIn = [];
  state.readOnly.clear();
  state.grantListeners.clear();
  state.configs.clear();
  for (const id of ["source", "target"])
    state.configs.set(id, {
      environment: {
        capabilities: {
          threadPinning: true,
          threadPinReorder: true,
          threadActiveReorder: true,
          threadSettlement: true,
        },
      },
    });
});
afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
});

function scope(
  lists: SidebarLists,
  children?: ComponentProps<typeof SidebarDragScope>["children"],
) {
  const rows = Object.values(lists).flat();
  return (
    <SidebarDragScope
      reservedKeys={{
        pinned: new Map(rows.map((row) => [key(row), row.pinOrderKey ?? null])),
        active: new Map(rows.map((row) => [key(row), row.activeOrderKey ?? null])),
      }}
      actions={actions}
      lists={lists}
      enabled
      snoozedExpanded
      settledExpanded
      settledLimit={10}
      routeThreadKey={null}
      onSettle={async () => success}
    >
      {children ?? ((projected) => <div>{projected.active.map((row) => row.title).join(",")}</div>)}
    </SidebarDragScope>
  );
}
async function drop(
  afterUnpin?: (source: EnvironmentThreadShell, target: EnvironmentThreadShell) => void,
) {
  const source = thread("move", "source", true);
  const target = thread("destination", "target");
  if (afterUnpin)
    unpin.mockImplementationOnce(async () => {
      afterUnpin(source, target);
      return success;
    });
  await render(scope({ pinned: [source], active: [target], snoozed: [], settled: [] }));
  const end: (event: DragEndEvent) => void = dndContext().onDragEnd;
  await act(async () =>
    end({ active: { id: key(source) }, over: { id: key(target) } } as DragEndEvent),
  );
}

it.each(["capability", "access", "operate scope"])(
  "moves next to a destination that lacks %s without ever writing to its environment",
  async (reason) => {
    if (reason === "capability")
      state.configs.get("target")!.environment.capabilities.threadPinReorder = false;
    else if (reason === "operate scope") state.readOnly.add("target");
    else {
      state.accounts.set("target", "expired");
      state.known.needsSignIn = ["expired"];
    }
    await drop();
    const moved = scopeThreadRef(EnvironmentId.make("source"), ThreadId.make("move"));
    expect(unpin.mock.calls.map(([ref]) => ref)).toEqual([moved]);
    expect(reorder.mock.calls.map(([ref]) => ref)).toEqual([moved]);
    const writes = Object.values(actions).flatMap((action) =>
      (action as { mock: { calls: unknown[][] } }).mock.calls.map(([ref]) => ref),
    );
    expect(writes).not.toContainEqual(
      expect.objectContaining({ environmentId: EnvironmentId.make("target") }),
    );
  },
);

it("never picks up or writes a row whose connection cannot operate threads", async () => {
  state.readOnly.add("source");
  await render(
    scope({ pinned: [], active: [thread("move", "source")], snoozed: [], settled: [] }, () => (
      <ScopedSortableThreadRow thread={thread("move", "source")}>
        {() => null}
      </ScopedSortableThreadRow>
    )),
  );
  expect(state.useSortable).toHaveBeenLastCalledWith(
    expect.objectContaining({ disabled: expect.objectContaining({ draggable: true }) }),
  );
  await drop();
  const writes = Object.values(actions).flatMap(
    (action) => (action as { mock: { calls: unknown[][] } }).mock.calls,
  );
  expect(writes).toEqual([]);
});

it("enables pickup once the connection's operate grant loads", async () => {
  state.readOnly.add("source");
  const row = thread("move", "source");
  await render(
    scope({ pinned: [], active: [row], snoozed: [], settled: [] }, () => (
      <ScopedSortableThreadRow thread={row}>{() => null}</ScopedSortableThreadRow>
    )),
  );
  expect(state.useSortable).toHaveBeenLastCalledWith(
    expect.objectContaining({ disabled: expect.objectContaining({ draggable: true }) }),
  );
  await act(async () => changeGrants(() => state.readOnly.delete("source")));
  expect(state.useSortable).toHaveBeenLastCalledWith(
    expect.objectContaining({ disabled: expect.objectContaining({ draggable: false }) }),
  );
});

it("unpins and materializes each destination member using its own environment", async () => {
  await drop();
  expect(unpin).toHaveBeenCalledWith(
    scopeThreadRef(EnvironmentId.make("source"), ThreadId.make("move")),
  );
  expect(reorder.mock.calls.map(([ref]) => ref)).toEqual([
    scopeThreadRef(EnvironmentId.make("target"), ThreadId.make("destination")),
    scopeThreadRef(EnvironmentId.make("source"), ThreadId.make("move")),
  ]);
});

it("rejects another account's row even when its thread id matches a local row", async () => {
  const source = thread("move", "source", true);
  const local = thread("destination", "source");
  const foreign = thread("destination", "target");
  await render(scope({ pinned: [source], active: [local], snoozed: [], settled: [] }));
  await act(async () => {
    dndContext().onDragEnd({
      active: { id: key(source) },
      over: { id: key(foreign) },
    } as never);
  });
  expect(unpin).not.toHaveBeenCalled();
  expect(reorder).not.toHaveBeenCalled();
  expect(actions.reorderPinnedThread).not.toHaveBeenCalled();
});

it.each(["active", "pinned"] as const)(
  "moves the only thread into empty %s within its owning scope",
  async (destination) => {
    const source = thread("move", "source", destination === "active");
    await render(
      scope({
        pinned: destination === "active" ? [source] : [],
        active: destination === "pinned" ? [source] : [],
        snoozed: [],
        settled: [],
      }),
    );
    await act(async () => {
      dndContext().onDragEnd({
        active: { id: key(source) },
        over: {
          id: sidebarMarkerId(destination === "active" ? "active-placeholder" : "pinned-header"),
        },
      } as never);
    });
    const ref = scopeThreadRef(source.environmentId, source.id);
    if (destination === "active") {
      expect(unpin).toHaveBeenCalledWith(ref);
      expect(reorder).toHaveBeenCalledWith(ref, expect.any(String));
      expect(actions.pinThread).not.toHaveBeenCalled();
    } else {
      expect(actions.pinThread).toHaveBeenCalledWith(ref, { orderKey: expect.any(String) });
      expect(unpin).not.toHaveBeenCalled();
      expect(reorder).not.toHaveBeenCalled();
    }
  },
);

it("cancels the attached pointer sensor when its account/project scope unmounts", async () => {
  await render(scope({ pinned: [], active: [thread("move", "source")], snoozed: [], settled: [] }));
  const sensor = { cancel: vi.fn() };
  dndContext().sensors[0]!.options.onAttach(sensor);
  await unmount();
  expect(sensor.cancel).toHaveBeenCalledOnce();
});

class GeometryNode {
  parentElement: GeometryNode | null = null;
  offsetWidth = 260;
  style = { paddingBottom: "" };
  constructor(
    public top: number,
    public height: number,
    readonly scale: number,
  ) {}
  getBoundingClientRect() {
    const top = this.top * this.scale;
    const height = (this.height + (Number.parseFloat(this.style.paddingBottom) || 0)) * this.scale;
    return {
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 260 * this.scale,
      width: 260 * this.scale,
    };
  }
  contains(node: GeometryNode): boolean {
    return node === this || (node.parentElement !== null && this.contains(node.parentElement));
  }
  querySelector(selector: string) {
    if (selector === "[data-sidebar-drag-label]" || selector === ".sidebar-drag-boundary-label")
      return new GeometryNode(this.top + 4, 16, this.scale);
    if (selector === "[data-sidebar-drag-placeholder]")
      return new GeometryNode(this.top, 36, this.scale);
    return null;
  }
}

it.each([false, true])(
  "reserves owning flow space and restores it on release (nested shelves: %s)",
  async (nested) => {
    const scale = 1.5;
    const source = thread("move", "source", true);
    const target = thread("destination", "source");
    const root = new GeometryNode(100, 0, scale);
    const conversations = new GeometryNode(100, 0, scale);
    conversations.parentElement = root;
    const shelf = new GeometryNode(0, 0, scale);
    shelf.parentElement = root;
    const shelfList = new GeometryNode(0, 0, scale);
    shelfList.parentElement = shelf;
    const entries = [
      ["sidebar-pinned-header", 0],
      [key(source), 78],
      ["sidebar-pinned-divider", 0],
      ["sidebar-active-placeholder", 0],
      [key(target), 78],
      ["sidebar-settled-header", 32],
      ["sidebar-settled-placeholder", 0],
    ] as const;
    let top = 100;
    const nodes = new Map(
      entries.map(([id, height]) => {
        const node = new GeometryNode(top, height, scale);
        node.parentElement = nested
          ? id === "sidebar-settled-placeholder"
            ? shelfList
            : id === "sidebar-settled-header"
              ? root
              : conversations
          : root;
        top += height + 1;
        return [id, node];
      }),
    );
    shelf.top = top - 1;
    shelfList.top = shelf.top;
    // Hierarchy's common ancestor also contains a following child project.
    root.height = top - 100 + (nested ? 100 : 0);
    const paddingNode = nested ? shelf : root;
    paddingNode.style.paddingBottom = "4px";
    const restingBottom = paddingNode.getBoundingClientRect().bottom;
    vi.stubGlobal("PointerEvent", vi.fn());
    vi.stubGlobal("getComputedStyle", (node: GeometryNode) => ({
      rowGap: "1px",
      paddingBottom: node.style.paddingBottom,
    }));
    const body = () => (
      <>
        <SidebarDragBoundary marker="pinned-header" label="Pinned" />
        <ScopedSortableThreadRow thread={source}>
          {(bag) => <li ref={bag?.setNodeRef} data-geometry-key={key(source)} />}
        </ScopedSortableThreadRow>
        <SidebarDragBoundary marker="pinned-divider" label="Active" />
        <SidebarDragBoundary marker="active-placeholder" label="Active" />
        <ScopedSortableThreadRow thread={target}>
          {(bag) => <li ref={bag?.setNodeRef} data-geometry-key={key(target)} />}
        </ScopedSortableThreadRow>
        <SidebarDragBoundary marker="settled-header" label="Settled" />
        <SidebarDragBoundary marker="settled-placeholder" label="Settled" />
      </>
    );
    await render(scope({ pinned: [source], active: [target], snoozed: [], settled: [] }, body));
    // Stand-in for react-test-renderer's createNodeMock: registered rows and
    // markers report the fixture geometry and hierarchy instead of real layout.
    for (const element of mounted!.container.querySelectorAll<HTMLElement>(
      "[data-testid], [data-geometry-key]",
    )) {
      const node = nodes.get(element.dataset.testid ?? element.dataset.geometryKey ?? "");
      if (!node) continue;
      Object.defineProperties(element, {
        parentElement: { configurable: true, get: () => node.parentElement },
        offsetWidth: { configurable: true, get: () => node.offsetWidth },
        getBoundingClientRect: { configurable: true, value: () => node.getBoundingClientRect() },
        querySelector: {
          configurable: true,
          value: (selector: string) => node.querySelector(selector),
        },
      });
    }
    expect(paddingNode.style.paddingBottom).toBe("4px");
    for (const reason of ["cancel", "end", "unmount"]) {
      await act(async () => {
        dndContext().onDragStart({ active: { id: key(source) }, activatorEvent: {} } as never);
      });
      expect(paddingNode.getBoundingClientRect().bottom).toBeGreaterThan(restingBottom);
      if (nested) expect(root.style.paddingBottom).toBe("");
      const context = dndContext();
      const sortable = state.sortable as Required<SortableContextProps>;
      const ids = sortable.items as string[];
      const rects = [...nodes.values()].map((node) => node.getBoundingClientRect());
      const activeIndex = ids.indexOf(key(source));
      const hintIndex = ids.indexOf(sidebarMarkerId("settled-placeholder"));
      const transform = sortable.strategy({
        rects: rects as never,
        activeIndex,
        overIndex: ids.indexOf(key(target)),
        index: hintIndex,
        activeNodeRect: rects[activeIndex] as never,
      })!;
      const hintTop = rects[hintIndex]!.top + transform.y;
      const hintBottom = hintTop + 36 * scale;
      const ownedBottom = paddingNode.getBoundingClientRect().bottom;
      expect(hintBottom).toBeLessThanOrEqual(ownedBottom);
      const pointerCoordinates = { x: 130 * scale, y: (hintTop + hintBottom) / 2 };
      const collisionRect = {
        ...rects[activeIndex]!,
        top: pointerCoordinates.y - 39 * scale,
        bottom: pointerCoordinates.y + 39 * scale,
      };
      const collisionArgs = {
        active: { id: key(source) },
        collisionRect,
        pointerCoordinates,
        droppableRects: new Map(ids.map((id, index) => [id, rects[index]])),
        droppableContainers: ids.map((id) => ({ id, node: { current: null } })),
      };
      expect(context.collisionDetection(collisionArgs as never)[0]?.id).toBe(
        sidebarMarkerId("settled-placeholder"),
      );
      // The next project shares the hierarchy ancestor; it is still outside
      // this scope even while the hint has opened extra room above it.
      expect(
        context.collisionDetection({
          ...collisionArgs,
          pointerCoordinates: { x: 130 * scale, y: ownedBottom + 1 },
        } as never),
      ).toEqual([]);
      await act(async () =>
        context.onDragEnd({ active: { id: key(source) }, over: null } as never),
      );
      expect(unpin).not.toHaveBeenCalled();
      expect(reorder).not.toHaveBeenCalled();
      const finish = context.sensors[0]!.options.onFinish;
      const sensor = { cancel: () => finish(true) };
      context.sensors[0]!.options.onAttach(sensor);
      if (reason === "unmount") await unmount();
      else await act(async () => (reason === "cancel" ? sensor.cancel() : finish(true)));
      expect(paddingNode.style.paddingBottom).toBe("4px");
      expect(paddingNode.getBoundingClientRect().bottom).toBe(restingBottom);
    }
  },
);

it.each(["failure", "interruption"])(
  "releases the optimistic order after a partial lifecycle acknowledgement and %s",
  async (reason) => {
    const result = AsyncResult.failure(
      reason === "failure" ? Cause.die(new Error("reorder rejected")) : Cause.interrupt(),
    );
    let finish!: (value: Awaited<ReturnType<Actions["reorderActiveThread"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<Actions["reorderActiveThread"]>>>((resolve) => {
      finish = resolve;
    });
    reorder.mockReturnValueOnce(pending);
    await drop((source, target) => {
      mounted!.root.render(
        scope({
          pinned: [],
          active: [{ ...source, pinnedAt: null }, target],
          snoozed: [],
          settled: [],
        }),
      );
    });
    expect(unpin).toHaveBeenCalledOnce();
    expect(projectedText()).toBe("destination,move");
    await act(async () => finish(result));
    expect(reorder).toHaveBeenCalledOnce();
    expect(projectedText()).toBe("move,destination");
  },
);
