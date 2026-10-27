import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@lecturn/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Adapters read it to keep developer instructions truthful: when the user
   * withholds agent browser access, the prompt must not advertise `preview_*`
   * tools that every call would reject.
   */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * Lecturn: set on a connected app's threads. Lecturn's MCP server gates the
   * app's tools itself, so adapters keep the provider's own approval prompt off
   * them. `toolNames` are the prefixed names cached when the credential
   * was issued; a fresh registration may not have listed any yet.
   */
  readonly app?: {
    readonly appId: string;
    readonly toolPrefix: string;
    readonly toolNames: ReadonlyArray<string>;
  };
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config:
    | { readonly agentDeviceEnvironment?: McpProviderSessionConfig["agentDeviceEnvironment"] }
    | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
