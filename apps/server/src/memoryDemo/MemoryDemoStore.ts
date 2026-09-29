/**
 * MemoryDemoStore - the single server-lifetime store behind the hack-day
 * memory demo (`LECTURN_MEMORY_DEMO`). One instance is shared by the `/ws`
 * memory.* RPCs and the `/mcp` memory_query / memory_write tools, so an agent
 * write shows up live in every client through `changes`.
 *
 * Every method fails `MemoryDemoError{code:"disabled"}` when the server runs
 * without the flag. `layerStub` is that behavior unconditionally; `layer`
 * reads `ServerConfig.memoryDemoEnabled` and builds the in-memory store only
 * when it is on. The synthetic warren is generated on first use, never at
 * startup.
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
  type ProjectId,
  type ThreadId,
} from "@lecturn/contracts";
import { Clock, Context, Effect, Layer, Option, PubSub, Ref, Semaphore, Stream } from "effect";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  buildGraph,
  denView,
  ensureDen,
  indexBaseWarren,
  initialState,
  landingScore,
  landPlan,
  nodeDetail,
  planDen,
  queryMemory,
  removeDenNode,
  revertReceipt,
  WarrenView,
  writeDenNode,
  isMemoryDemoError,
  type DemoState,
} from "./demoState.ts";
import type { IndexedDoc } from "./lexicalScore.ts";
import { spikeFixture } from "./spikeFixture.ts";
import { buildWarren, layoutWarren, slugify, type Warren, type WarrenLayout } from "./warren.ts";

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

export interface MemoryDemoStoreOptions {
  /** Project title used to name the project's den; null when unknown. */
  readonly projectTitle?: (projectId: ProjectId) => Effect.Effect<string | null>;
}

const unwrap = <A>(result: A | MemoryDemoError): Effect.Effect<A, MemoryDemoError> =>
  isMemoryDemoError(result) ? Effect.fail(result) : Effect.succeed(result);

type Step<A> = readonly [A, DemoState, MemoryChange | null];

/** The in-memory store. Dens seed on first access; the warren builds on first use. */
export const make = Effect.fn("MemoryDemoStore.make")(function* (
  options: MemoryDemoStoreOptions = {},
) {
  const state = yield* Ref.make(initialState());
  const changes = yield* PubSub.sliding<MemoryChange>({ capacity: 256 });
  // Serializes mutate-then-publish so subscribers see revisions in order.
  const mutex = yield* Semaphore.make(1);

  let warrenCache: Warren | undefined;
  let baseIndexCache: IndexedDoc[] | undefined;
  let layoutCache: WarrenLayout | undefined;
  const warren = () => (warrenCache ??= buildWarren(spikeFixture()));
  const baseIndex = () => (baseIndexCache ??= indexBaseWarren(warren()));
  const layout = () => (layoutCache ??= layoutWarren(warren()));

  const denName = (projectId: ProjectId) =>
    (options.projectTitle ? options.projectTitle(projectId) : Effect.succeed(null)).pipe(
      Effect.map((title) => `den/${(title && slugify(title, 40)) || projectId.slice(0, 8)}`),
    );

  const ensure = (projectId: ProjectId) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(state)).dens.has(projectId)) return;
      const name = yield* denName(projectId);
      const nowMs = yield* Clock.currentTimeMillis;
      yield* Ref.update(state, (current) =>
        ensureDen(current, spikeFixture(), projectId, name, nowMs),
      );
    });

  /** Runs a pure transition atomically and publishes its change, if any. */
  const mutate = <A>(step: (current: DemoState, nowMs: number) => Step<A> | MemoryDemoError) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const outcome = yield* Ref.modify(
          state,
          (current): readonly [Step<A> | MemoryDemoError, DemoState] => {
            const result = step(current, nowMs);
            return isMemoryDemoError(result) ? [result, current] : [result, result[1]];
          },
        );
        const [value, , change] = yield* unwrap(outcome);
        if (change) yield* PubSub.publish(changes, change);
        return value;
      }),
    );

  const view = Effect.map(Ref.get(state), (current) => new WarrenView(warren(), current));

  const shape: MemoryDemoStoreShape = {
    status: Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const lastReceipt = current.lastReceiptId
        ? (current.receipts.get(current.lastReceiptId)?.receipt ?? null)
        : null;
      return {
        pending: [...current.dens.values()].map((den) => ({
          projectId: den.projectId,
          count: den.nodes.length,
        })),
        warrenNodes: new WarrenView(warren(), current).count(),
        lastReceipt,
      };
    }),
    den: (input) =>
      ensure(input.projectId).pipe(
        Effect.andThen(Ref.get(state)),
        Effect.map((current) => denView(current, input.projectId)),
      ),
    graph: Effect.map(view, (current) => buildGraph(current, layout())),
    node: (input) =>
      Effect.flatMap(view, (current) => unwrap(nodeDetail(current, spikeFixture(), input.nodeId))),
    query: (input) =>
      Effect.gen(function* () {
        if (input.projectId !== undefined) yield* ensure(input.projectId);
        return yield* mutate((current, nowMs) =>
          queryMemory(current, new WarrenView(warren(), current), baseIndex(), input, nowMs),
        );
      }),
    write: (input, source) =>
      Effect.gen(function* () {
        yield* ensure(input.projectId);
        return yield* mutate((current, nowMs) =>
          writeDenNode(
            current,
            new WarrenView(warren(), current),
            input,
            { origin: source.origin, threadId: source.threadId ?? null },
            nowMs,
          ),
        );
      }),
    removeDenNode: (input) =>
      mutate((current) => {
        const result = removeDenNode(current, input.projectId, input.nodeId);
        return isMemoryDemoError(result) ? result : ([undefined, result[0], result[1]] as const);
      }),
    plan: (input) =>
      Effect.gen(function* () {
        yield* ensure(input.projectId);
        return yield* mutate((current) => {
          const [plan, next] = planDen(current, new WarrenView(warren(), current), input.projectId);
          return [plan, next, null] as const;
        });
      }),
    land: (input) =>
      mutate((current, nowMs) =>
        landPlan(
          current,
          new WarrenView(warren(), current),
          (territoryId) => landingScore(warren(), territoryId),
          input,
          nowMs,
        ),
      ),
    revert: (input) => mutate((current) => revertReceipt(current, input.receiptId)),
    reset: mutate((current) => {
      const revision = current.revision + 1;
      return [
        undefined,
        { ...initialState(), revision },
        { revision, kind: "reset", projectId: null, nodeIds: [] },
      ] as const;
    }),
    changes: Stream.fromPubSub(changes),
  };
  return shape;
});

/**
 * The real store, gated on `memoryDemoEnabled`: with the flag off this is
 * `stub` and nothing is generated. Den names use the project title when the
 * projection query service is available.
 */
export const layer = Layer.effect(
  MemoryDemoStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (config.memoryDemoEnabled !== true) return stub;
    const projections = yield* Effect.serviceOption(ProjectionSnapshotQuery);
    return yield* make({
      projectTitle: (projectId) =>
        Option.match(projections, {
          onNone: () => Effect.succeed(null),
          onSome: (query) =>
            query.getProjectShellById(projectId).pipe(
              Effect.map((shell) => (Option.isSome(shell) ? shell.value.title : null)),
              Effect.orElseSucceed(() => null),
            ),
        }),
    });
  }),
);
