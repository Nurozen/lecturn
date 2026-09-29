/**
 * MemoryDemoStore - the single server-lifetime store behind the hack-day
 * memory demo (`LECTURN_MEMORY_DEMO`). One instance is shared by the `/ws`
 * memory.* RPCs and the `/mcp` memory_query / memory_write tools, so an agent
 * write shows up live in every client through `changes`.
 *
 * Every method fails `MemoryDemoError{code:"disabled"}` when the server runs
 * without the flag. `layerStub` is that behavior unconditionally; the real
 * in-memory `layer` lives in this module as well.
 *
 * @module MemoryDemoStore
 */
import {
  MemoryDemoError,
  type ContributionPlan,
  type MemoryChange,
  type MemoryDen,
  type MemoryDenInput,
  type MemoryGraph,
  type MemoryLandInput,
  type MemoryDenNode,
  type MemoryNodeDetail,
  type MemoryNodeInput,
  type MemoryPlanInput,
  type MemoryQueryInput,
  type MemoryQueryResult,
  type MemoryReceipt,
  type MemoryRemoveDenNodeInput,
  type MemoryRevertInput,
  type MemoryStatus,
  type MemoryWriteInput,
  type ThreadId,
} from "@lecturn/contracts";
import { Context, Effect, Layer, Stream } from "effect";

/** Who issued a query or write. RPC callers pass `simulated`; MCP tools pass
    `agent` plus the calling thread. Recorded on den nodes and recent queries. */
export interface MemoryCallSource {
  readonly origin: "agent" | "simulated";
  readonly threadId?: ThreadId | undefined;
}

export interface MemoryDemoStoreShape {
  /** memory.status: pending den counts, warren size, last receipt. */
  readonly status: Effect.Effect<MemoryStatus, MemoryDemoError>;
  /** memory.den: one project's den; empty (not an error) for projects without one. */
  readonly den: (input: MemoryDenInput) => Effect.Effect<MemoryDen, MemoryDemoError>;
  /** memory.graph: the capped map payload. */
  readonly graph: Effect.Effect<MemoryGraph, MemoryDemoError>;
  /** memory.node: warren or den node detail; fails `not-found`. */
  readonly node: (input: MemoryNodeInput) => Effect.Effect<MemoryNodeDetail, MemoryDemoError>;
  /** memory.query / memory_query: lexical recall, recorded as a recent query when `projectId` is set. */
  readonly query: (
    input: MemoryQueryInput,
    source: MemoryCallSource,
  ) => Effect.Effect<MemoryQueryResult, MemoryDemoError>;
  /** memory.write / memory_write: append a den node with heuristic judgments; publishes `den-write`. */
  readonly write: (
    input: MemoryWriteInput,
    source: MemoryCallSource,
  ) => Effect.Effect<MemoryDenNode, MemoryDemoError>;
  /** memory.removeDenNode: publishes `den-remove`; fails `not-found`. */
  readonly removeDenNode: (input: MemoryRemoveDenNodeInput) => Effect.Effect<void, MemoryDemoError>;
  /** memory.plan: tier the den into Gate cards at the current den revision. */
  readonly plan: (input: MemoryPlanInput) => Effect.Effect<ContributionPlan, MemoryDemoError>;
  /** memory.land: apply verdicts; fails `stale-plan` if the den moved since the plan. Publishes `land`. */
  readonly land: (input: MemoryLandInput) => Effect.Effect<MemoryReceipt, MemoryDemoError>;
  /** memory.revert: undo a receipt, returning landed nodes to the den. Publishes `revert`. */
  readonly revert: (input: MemoryRevertInput) => Effect.Effect<MemoryReceipt, MemoryDemoError>;
  /** memory.reset: reseed den and warren. Publishes `reset`. */
  readonly reset: Effect.Effect<void, MemoryDemoError>;
  /** memory.subscribe: every mutation after subscription, in revision order. */
  readonly changes: Stream.Stream<MemoryChange>;
}

export class MemoryDemoStore extends Context.Service<MemoryDemoStore, MemoryDemoStoreShape>()(
  "lecturn/memoryDemo/MemoryDemoStore",
) {}

const disabled = Effect.fail(
  new MemoryDemoError({
    code: "disabled",
    message: "The memory demo is not enabled on this server.",
  }),
);

/** Store for servers without the demo: every call fails `disabled`. */
export const stub: MemoryDemoStoreShape = {
  status: disabled,
  den: () => disabled,
  graph: disabled,
  node: () => disabled,
  query: () => disabled,
  write: () => disabled,
  removeDenNode: () => disabled,
  plan: () => disabled,
  land: () => disabled,
  revert: () => disabled,
  reset: disabled,
  changes: Stream.empty,
};

export const layerStub = Layer.succeed(MemoryDemoStore, stub);
