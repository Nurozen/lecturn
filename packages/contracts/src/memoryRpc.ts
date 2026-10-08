import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as M from "./memory.ts";
import {
  EnvironmentAuthorizationError,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "./auth.ts";

const error = Schema.Union([M.MemoryDemoError, EnvironmentAuthorizationError]);

/** Memory demo RPCs. Only served usefully when the environment advertises
    `capabilities.memoryDemo`; otherwise every method fails `disabled`. */
export const MEMORY_WS_METHODS = {
  memoryStatus: "memory.status",
  memoryDen: "memory.den",
  memoryGraph: "memory.graph",
  memoryNode: "memory.node",
  memoryQuery: "memory.query",
  memoryWrite: "memory.write",
  memoryRemoveDenNode: "memory.removeDenNode",
  memoryPlan: "memory.plan",
  memoryLand: "memory.land",
  memoryRevert: "memory.revert",
  memoryReset: "memory.reset",
  memorySubscribe: "memory.subscribe",
} as const;
const W = MEMORY_WS_METHODS;

export const MemoryRpcs = [
  Rpc.make(W.memoryStatus, { payload: {}, success: M.MemoryStatus, error }),
  Rpc.make(W.memoryDen, { payload: M.MemoryDenInput, success: M.MemoryDen, error }),
  Rpc.make(W.memoryGraph, { payload: {}, success: M.MemoryGraph, error }),
  Rpc.make(W.memoryNode, { payload: M.MemoryNodeInput, success: M.MemoryNodeDetail, error }),
  Rpc.make(W.memoryQuery, { payload: M.MemoryQueryInput, success: M.MemoryQueryResult, error }),
  /** Client-originated writes are recorded with origin `simulated`. */
  Rpc.make(W.memoryWrite, { payload: M.MemoryWriteInput, success: M.MemoryDenNode, error }),
  Rpc.make(W.memoryRemoveDenNode, {
    payload: M.MemoryRemoveDenNodeInput,
    success: Schema.Void,
    error,
  }),
  Rpc.make(W.memoryPlan, { payload: M.MemoryPlanInput, success: M.ContributionPlan, error }),
  Rpc.make(W.memoryLand, { payload: M.MemoryLandInput, success: M.MemoryReceipt, error }),
  Rpc.make(W.memoryRevert, { payload: M.MemoryRevertInput, success: M.MemoryReceipt, error }),
  /** Restores the seeded den and warren. */
  Rpc.make(W.memoryReset, { payload: {}, success: Schema.Void, error }),
  Rpc.make(W.memorySubscribe, { payload: {}, success: M.MemoryChange, error, stream: true }),
] as const;

export const MEMORY_RPC_SCOPES = {
  [W.memoryStatus]: AuthOrchestrationReadScope,
  [W.memoryDen]: AuthOrchestrationReadScope,
  [W.memoryGraph]: AuthOrchestrationReadScope,
  [W.memoryNode]: AuthOrchestrationReadScope,
  [W.memoryQuery]: AuthOrchestrationReadScope,
  [W.memoryWrite]: AuthOrchestrationOperateScope,
  [W.memoryRemoveDenNode]: AuthOrchestrationOperateScope,
  [W.memoryPlan]: AuthOrchestrationOperateScope,
  [W.memoryLand]: AuthOrchestrationOperateScope,
  [W.memoryRevert]: AuthOrchestrationOperateScope,
  [W.memoryReset]: AuthOrchestrationOperateScope,
  [W.memorySubscribe]: AuthOrchestrationReadScope,
} as const;
