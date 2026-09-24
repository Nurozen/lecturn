import { WS_METHODS, type EnvironmentId, type ThreadNoteListInput } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** A single canonical query is shared by the panel and every transcript highlight. */
export function threadNoteListKey(environmentId: EnvironmentId, input: ThreadNoteListInput = {}) {
  return {
    environmentId,
    input: input.projectId === undefined ? {} : { projectId: input.projectId },
  };
}
export function createThreadNoteEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const refreshSignal = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`thread-notes:refresh:${environmentId}`)),
  );
  const query = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:thread-notes:list",
    tag: WS_METHODS.threadNotesList,
    staleTimeMs: 15_000,
    refreshTrigger: ({ environmentId }) => refreshSignal(environmentId),
  });
  const list: typeof query = ({ environmentId, input }) =>
    query(threadNoteListKey(environmentId, input));
  const scheduler = createAtomCommandScheduler();
  const options = {
    scheduler,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }: { environmentId: string; input: { id: string } }) =>
        JSON.stringify([environmentId, input.id]),
    },
    onSuccess: (
      { environmentId }: { environmentId: EnvironmentId },
      registry: AtomRegistry.AtomRegistry,
    ) => Effect.sync(() => registry.update(refreshSignal(environmentId), (value) => value + 1)),
  } as const;
  return {
    list,
    refreshSignal,
    create: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "thread-notes:mutate",
      tag: WS_METHODS.threadNotesCreate,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "thread-notes:mutate",
      tag: WS_METHODS.threadNotesUpdate,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "thread-notes:mutate",
      tag: WS_METHODS.threadNotesDelete,
    }),
  };
}
