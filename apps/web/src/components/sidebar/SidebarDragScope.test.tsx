import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { scopeThreadRef, scopedThreadKey } from "@lecturn/client-runtime/environment";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@lecturn/contracts";
import type { ComponentProps, ReactNode } from "react";
import { Cause } from "effect";
import type { SidebarLists } from "./sidebarDragScope.logic";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SidebarDragScope } from "./SidebarDragScope";

const state = vi.hoisted(() => ({
  configs: new Map<string, { environment: { capabilities: Record<string, boolean> } }>(),
  accounts: new Map<string, string>(),
  known: { needsSignIn: [] as string[] },
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../../cloud/connectAccounts", () => ({ accountByEnvironmentIdAtom: "accounts" }));
vi.mock("../../cloud/knownAccounts", () => ({ knownConnectAccountsAtom: "known" }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: keyof typeof state) => state[atom],
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() }, stackedThreadToast: vi.fn() }));
vi.mock("@dnd-kit/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dnd-kit/core")>()),
  DndContext: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@dnd-kit/sortable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dnd-kit/sortable")>()),
  SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
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
} satisfies Actions;
const key = (row: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(row.environmentId, row.id));
function thread(id: string, environmentId: string, pinned = false): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make(environmentId),
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    createdAt: "2026-03-09T10:00:00Z",
    updatedAt: "2026-03-09T10:00:00Z",
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    pinnedAt: pinned ? "2026-03-09T10:00:00Z" : null,
  };
}
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.accounts.clear();
  state.known.needsSignIn = [];
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
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

function scope(lists: SidebarLists) {
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
      {(projected) => <div>{projected.active.map((row) => row.title).join(",")}</div>}
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
  await act(async () => {
    renderer = create(scope({ pinned: [source], active: [target], snoozed: [], settled: [] }));
  });
  const end: (event: DragEndEvent) => void = renderer.root.findByType(DndContext).props.onDragEnd;
  await act(async () =>
    end({ active: { id: key(source) }, over: { id: key(target) } } as DragEndEvent),
  );
}

it.each(["capability", "access"])(
  "rejects the whole Active drop before unpinning when a destination lacks %s",
  async (reason) => {
    if (reason === "capability")
      state.configs.get("target")!.environment.capabilities.threadPinReorder = false;
    else {
      state.accounts.set("target", "expired");
      state.known.needsSignIn = ["expired"];
    }
    await drop();
    expect(unpin).not.toHaveBeenCalled();
    expect(reorder).not.toHaveBeenCalled();
  },
);

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
      renderer.update(
        scope({
          pinned: [],
          active: [{ ...source, pinnedAt: null }, target],
          snoozed: [],
          settled: [],
        }),
      );
    });
    expect(unpin).toHaveBeenCalledOnce();
    expect(renderer.root.findByType("div").children).toEqual(["destination,move"]);
    await act(async () => finish(result));
    expect(reorder).toHaveBeenCalledOnce();
    expect(renderer.root.findByType("div").children).toEqual(["move,destination"]);
  },
);
