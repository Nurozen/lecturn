import { WS_METHODS } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** Observation is server-owned; clients poll the durable view only while mounted. */
export function createPullRequestWatchEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-request-watch:list",
    tag: WS_METHODS.pullRequestWatchList,
    staleTimeMs: 15_000,
    refreshIntervalMs: 20_000,
    idleTtlMs: 5_000,
  });
  const scheduler = createAtomCommandScheduler();
  const options = {
    scheduler,
    concurrency: {
      mode: "serial",
      key: ({ environmentId }: { environmentId: string }) => environmentId,
    },
    onSuccess: (
      { environmentId }: { environmentId: Parameters<typeof list>[0]["environmentId"] },
      registry: AtomRegistry.AtomRegistry,
    ) => Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
  } as const;
  return {
    list,
    track: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "pull-request-watch:track",
      tag: WS_METHODS.pullRequestWatchTrack,
    }),
    command: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "pull-request-watch:command",
      tag: WS_METHODS.pullRequestWatchCommand,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "pull-request-watch:configure",
      tag: WS_METHODS.pullRequestWatchConfigure,
    }),
  };
}
