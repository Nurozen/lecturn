import {
  AppId,
  EnvironmentId,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  ThreadId,
  RunId,
  type ScopedThreadRef,
} from "@lecturn/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { v2Projection, v2Now } from "./orchestrationV2TestFixtures.ts";
import { EMPTY_THREAD_HISTORY_META } from "./threadHistoryMerge.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import type { EnvironmentThreadState } from "./threads.ts";

const ref: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-detail"),
  threadId: ThreadId.make(v2Projection.thread.id),
};

function threadState(
  partial: Pick<EnvironmentThreadState, "data" | "status" | "error"> &
    Partial<Pick<EnvironmentThreadState, "history">>,
): EnvironmentThreadState {
  return { ...partial, history: partial.history ?? EMPTY_THREAD_HISTORY_META };
}

it("draws an app approval below the call it holds and keeps the rows stable meanwhile", () => {
  const runId = RunId.make("app-run");
  const item = (id: string, ordinal: number) => ({
    id: TurnItemId.make(id),
    threadId: v2Projection.thread.id,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "running" as const,
    title: null,
    startedAt: v2Now,
    completedAt: null,
    updatedAt: v2Now,
  });
  const requestId = RuntimeRequestId.make("app-approval");
  const turnItems: OrchestrationV2ThreadProjection["turnItems"] = [
    {
      ...item("approval", 1),
      status: "waiting",
      type: "approval_request",
      requestId,
      requestKind: "permission",
    },
    {
      ...item("held-call", 2),
      type: "dynamic_tool",
      toolName: "lecturn.rw_engine_simulate",
      toolSource: { key: "app:rocketwright", name: "RocketWright", kind: "integration" },
      input: {},
    },
  ];
  const projection: OrchestrationV2ThreadProjection = {
    ...v2Projection,
    turnItems,
    visibleTurnItems: turnItems.map((turnItem, position) => ({
      position,
      visibility: "local",
      sourceThreadId: v2Projection.thread.id,
      sourceItemId: turnItem.id,
      item: turnItem,
    })),
    runtimeRequests: [
      {
        id: requestId,
        nodeId: NodeId.make("approval-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "permission",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
        createdAt: v2Now,
        resolvedAt: null,
        connectedAppTool: {
          appId: AppId.make("io.rocketwright"),
          appName: "RocketWright",
          toolName: "rw_engine_simulate",
          reason: null,
          source: "app",
        },
      },
    ],
  };
  const live = (data: OrchestrationV2ThreadProjection) =>
    AsyncResult.success(
      threadState({ data: Option.some(data), status: "live", error: Option.none() }),
    );
  const source = Atom.make(live(projection));
  const details = createEnvironmentThreadDetailAtoms(() => source);
  const registry = AtomRegistry.make();
  const dispose = registry.mount(details.visibleTurnItemsAtom(ref));

  const placed = registry.get(details.visibleTurnItemsAtom(ref));
  expect(placed.map((row) => row.sourceItemId)).toEqual(["held-call", "approval"]);
  expect(placed[0]).toBe(projection.visibleTurnItems[1]);

  registry.set(source, live({ ...projection, runs: [] }));
  expect(registry.get(details.visibleTurnItemsAtom(ref))).toBe(placed);
  dispose();
  registry.dispose();
});
