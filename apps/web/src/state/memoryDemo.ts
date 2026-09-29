import { createMemoryDemoEnvironmentAtoms } from "@lecturn/client-runtime/state/memoryDemo";
import type { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";

/** Memory demo atoms bound to the web connection runtime. Commands:
    `memoryDemoEnvironment.{query,write,removeDenNode,plan,land,revert,reset}`
    via `useAtomCommand`. */
export const memoryDemoEnvironment = createMemoryDemoEnvironmentAtoms(connectionAtomRuntime);

/** True when this environment advertises `capabilities.memoryDemo`. Every Memory
    entry point must check this before rendering or probing the RPCs. */
export function useMemoryDemoAvailable(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.memoryDemo === true
  );
}

/** First connected environment with the memory demo, or null. */
export function useFirstMemoryDemoEnvironmentId(): EnvironmentId | null {
  for (const [environmentId, config] of useServerConfigs())
    if (config.environment.capabilities.memoryDemo === true) return environmentId;
  return null;
}

export function useMemoryStatus(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : memoryDemoEnvironment.status({ environmentId, input: {} }),
  );
}

export function useMemoryDen(environmentId: EnvironmentId | null, projectId: ProjectId | null) {
  return useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : memoryDemoEnvironment.den({ environmentId, input: { projectId } }),
  );
}

export function useMemoryGraph(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : memoryDemoEnvironment.graph({ environmentId, input: {} }),
  );
}

export function useMemoryNode(environmentId: EnvironmentId | null, nodeId: string | null) {
  return useEnvironmentQuery(
    environmentId === null || nodeId === null
      ? null
      : memoryDemoEnvironment.node({ environmentId, input: { nodeId } }),
  );
}
