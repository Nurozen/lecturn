/**
 * memoryDemoRpcHandlers - the `memory.*` RPCs served over the WebSocket group.
 * Thin pass-throughs to `MemoryDemoStore`; client writes and queries are
 * recorded with origin `simulated`. Auth and tracing come from the same
 * per-connection wrappers `ws.ts` uses for every other RPC.
 *
 * @module memoryDemoRpcHandlers
 */
import {
  WS_METHODS,
  type MemoryDenInput,
  type MemoryLandInput,
  type MemoryNodeInput,
  type MemoryPlanInput,
  type MemoryQueryInput,
  type MemoryRemoveDenNodeInput,
  type MemoryRevertInput,
  type MemoryWriteInput,
} from "@lecturn/contracts";
import { Effect } from "effect";
import type { StaveRpcWrappers } from "../stave/staveRpcHandlers.ts";
import { MemoryDemoStore, type MemoryCallSource } from "./MemoryDemoStore.ts";

const TRACE_ATTRIBUTES = { "rpc.aggregate": "memory" } as const;
const SIMULATED: MemoryCallSource = { origin: "simulated" };

export const makeMemoryDemoRpcHandlers = Effect.fn("makeMemoryDemoRpcHandlers")(function* ({
  observeRpcEffect,
  observeRpcStream,
}: StaveRpcWrappers) {
  const store = yield* MemoryDemoStore;
  const W = WS_METHODS;
  return {
    [W.memoryStatus]: () => observeRpcEffect(W.memoryStatus, store.status, TRACE_ATTRIBUTES),
    [W.memoryDen]: (input: MemoryDenInput) =>
      observeRpcEffect(W.memoryDen, store.den(input), TRACE_ATTRIBUTES),
    [W.memoryGraph]: () => observeRpcEffect(W.memoryGraph, store.graph, TRACE_ATTRIBUTES),
    [W.memoryNode]: (input: MemoryNodeInput) =>
      observeRpcEffect(W.memoryNode, store.node(input), TRACE_ATTRIBUTES),
    [W.memoryQuery]: (input: MemoryQueryInput) =>
      observeRpcEffect(W.memoryQuery, store.query(input, SIMULATED), TRACE_ATTRIBUTES),
    [W.memoryWrite]: (input: MemoryWriteInput) =>
      observeRpcEffect(W.memoryWrite, store.write(input, SIMULATED), TRACE_ATTRIBUTES),
    [W.memoryRemoveDenNode]: (input: MemoryRemoveDenNodeInput) =>
      observeRpcEffect(W.memoryRemoveDenNode, store.removeDenNode(input), TRACE_ATTRIBUTES),
    [W.memoryPlan]: (input: MemoryPlanInput) =>
      observeRpcEffect(W.memoryPlan, store.plan(input), TRACE_ATTRIBUTES),
    [W.memoryLand]: (input: MemoryLandInput) =>
      observeRpcEffect(W.memoryLand, store.land(input), TRACE_ATTRIBUTES),
    [W.memoryRevert]: (input: MemoryRevertInput) =>
      observeRpcEffect(W.memoryRevert, store.revert(input), TRACE_ATTRIBUTES),
    [W.memoryReset]: () => observeRpcEffect(W.memoryReset, store.reset, TRACE_ATTRIBUTES),
    [W.memorySubscribe]: () => observeRpcStream(W.memorySubscribe, store.changes, TRACE_ATTRIBUTES),
  };
});
