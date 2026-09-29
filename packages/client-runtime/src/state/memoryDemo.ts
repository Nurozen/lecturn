import { WS_METHODS, type EnvironmentId, type ProjectId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Folded `memory.subscribe` state. `revision` moves on every change, `warren`
    only on land/revert/reset, `projects` holds each den's last change revision. */
export interface MemoryDemoRevisions {
  readonly revision: number;
  readonly warren: number;
  readonly projects: ReadonlyMap<ProjectId, number>;
}
const INITIAL_REVISIONS: MemoryDemoRevisions = { revision: 0, warren: 0, projects: new Map() };

/**
 * Memory demo atoms for one app runtime. Queries take `{ environmentId, input }`
 * and refetch when `memory.subscribe` reports a relevant change or when this
 * client's own command succeeds. The graph refetches only when the warren moves.
 */
export function createMemoryDemoEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const changes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "memory:changes",
    tag: WS_METHODS.memorySubscribe,
    transform: (stream) =>
      stream.pipe(
        Stream.scan(INITIAL_REVISIONS, (previous, change): MemoryDemoRevisions => {
          const warrenMoved = change.kind !== "den-write" && change.kind !== "den-remove";
          const projects = new Map(previous.projects);
          if (change.projectId !== null) projects.set(change.projectId, change.revision);
          return {
            revision: change.revision,
            warren: warrenMoved ? change.revision : previous.warren,
            projects,
          };
        }),
      ),
  });
  const revisions = (get: Atom.AtomContext, environmentId: EnvironmentId) =>
    Option.getOrElse(
      AsyncResult.value(get(changes({ environmentId, input: {} }))),
      () => INITIAL_REVISIONS,
    );
  // Bumped by this client's successful commands so the caller never waits on the stream.
  const localDen = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`memory:local-den:${environmentId}`)),
  );
  const localWarren = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`memory:local-warren:${environmentId}`)),
  );
  const anyRefresh = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) =>
        `${revisions(get, environmentId).revision}:${get(localDen(environmentId))}:${get(localWarren(environmentId))}`,
    ),
  );
  const warrenRefresh = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) => `${revisions(get, environmentId).warren}:${get(localWarren(environmentId))}`,
    ),
  );
  const denRefresh = Atom.family((key: string) =>
    Atom.make((get) => {
      const [environmentId, projectId] = JSON.parse(key) as [EnvironmentId, ProjectId];
      const current = revisions(get, environmentId);
      return `${current.projects.get(projectId) ?? 0}:${current.warren}:${get(localDen(environmentId))}:${get(localWarren(environmentId))}`;
    }),
  );
  const bump =
    (...families: ReadonlyArray<(environmentId: EnvironmentId) => Atom.Writable<number>>) =>
    ({ environmentId }: { environmentId: EnvironmentId }, registry: AtomRegistry.AtomRegistry) =>
      Effect.sync(() => {
        for (const family of families) registry.update(family(environmentId), (n) => n + 1);
      });
  const serial = {
    scheduler: createAtomCommandScheduler(),
    concurrency: {
      mode: "serial",
      key: ({ environmentId }: { environmentId: EnvironmentId }) => environmentId,
    },
  } as const;

  return {
    changes,
    /** Pending den counts, warren size, last receipt. Input `{}`. */
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "memory:status",
      tag: WS_METHODS.memoryStatus,
      staleTimeMs: 15_000,
      refreshTrigger: ({ environmentId }) => anyRefresh(environmentId),
    }),
    /** One project's den. Input `{ projectId }`. */
    den: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "memory:den",
      tag: WS_METHODS.memoryDen,
      staleTimeMs: 15_000,
      refreshTrigger: ({ environmentId, input }) =>
        denRefresh(JSON.stringify([environmentId, input.projectId])),
    }),
    /** Map payload (~80 KB); refetched only when the warren moves. Input `{}`. */
    graph: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "memory:graph",
      tag: WS_METHODS.memoryGraph,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => warrenRefresh(environmentId),
    }),
    /** Node sheet detail. Input `{ nodeId }`. */
    node: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "memory:node",
      tag: WS_METHODS.memoryNode,
      staleTimeMs: 0,
      refreshTrigger: ({ environmentId }) => anyRefresh(environmentId),
    }),
    /** Lexical recall (recorded as simulated). Not cached. */
    query: createEnvironmentRpcCommand(runtime, {
      label: "memory:query",
      tag: WS_METHODS.memoryQuery,
    }),
    write: createEnvironmentRpcCommand(runtime, {
      ...serial,
      label: "memory:write",
      tag: WS_METHODS.memoryWrite,
      onSuccess: bump(localDen),
    }),
    removeDenNode: createEnvironmentRpcCommand(runtime, {
      ...serial,
      label: "memory:remove-den-node",
      tag: WS_METHODS.memoryRemoveDenNode,
      onSuccess: bump(localDen),
    }),
    /** Builds a Gate plan; does not mutate the store. */
    plan: createEnvironmentRpcCommand(runtime, {
      ...serial,
      label: "memory:plan",
      tag: WS_METHODS.memoryPlan,
    }),
    land: createEnvironmentRpcCommand(runtime, {
      ...serial,
      label: "memory:land",
      tag: WS_METHODS.memoryLand,
      onSuccess: bump(localWarren),
    }),
    revert: createEnvironmentRpcCommand(runtime, {
      ...serial,
      label: "memory:revert",
      tag: WS_METHODS.memoryRevert,
      onSuccess: bump(localWarren),
    }),
    reset: createEnvironmentRpcCommand(runtime, {
      ...serial,
      label: "memory:reset",
      tag: WS_METHODS.memoryReset,
      onSuccess: bump(localWarren),
    }),
  };
}
