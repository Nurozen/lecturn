// @effect-diagnostics preferSchemaOverJson:off globalFetch:off - a raw JSON-RPC client exercises the gate's parsing.
/**
 * The production `/mcp` route set (every registered toolkit, the auth
 * middleware with `SquireMcpGate`, a real `McpSessionRegistry`) served on the
 * test HTTP server. Services behind the tools are stubs: the gate refuses
 * before dispatch, so they only run for calls it lets through. Only the
 * calling-thread lookup and `html_render`'s file store are real enough to
 * succeed. Needs `NodeHttpServer.layerTest`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderInstanceId,
  type SquireId,
  type SquireRole,
  type ThreadId,
} from "@lecturn/contracts";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@lecturn/provider-core/server/mcpSession";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpRouter, HttpServer } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as DeviceService from "../../device/DeviceService.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import * as AppToolInterceptor from "../../mcp/toolkits/app/AppToolInterceptor.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as PullRequestReviewGuideService from "../../pullRequest/PullRequestReviewGuideService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlRepositoryService from "../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as SquireSwitch from "../SquireSwitch.ts";
import * as SquireTools from "../SquireTools.ts";

/** `McpToolAccessTestkit.liveThreadShell` callers run on this instance. */
export const boundMcpProviderInstanceId = ProviderInstanceId.make("codex");

const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  McpToolAccessTestkit.liveThreadsLayer,
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  // No installed browser, so `html_render` publishes without launching one.
  Layer.mock(PreviewBrowser.PreviewBrowser)({ installed: Effect.succeed(Option.none()) }),
);

const layerConfig = (squireEnabled: boolean) =>
  Layer.merge(
    ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-squire-bound-mcp-" }),
    SquireSwitch.layerTest(squireEnabled),
  );

const layerEnvironment = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-squire-bound-mcp")),
    getDescriptor: Effect.die("unused"),
  }),
);

const layerExternalClient = (
  client:
    | { readonly token: string; readonly scope: McpInvocationContext.McpInvocationScope }
    | undefined,
) =>
  client === undefined
    ? Layer.empty
    : Layer.succeed(McpHttpServer.McpClientAuthenticator, {
        authenticate: (request) =>
          Effect.succeed(
            request.headers.authorization === `Bearer ${client.token}` ? client.scope : undefined,
          ),
      });

export interface BoundMcp {
  readonly registry: McpSessionRegistry.McpSessionRegistryShape;
  /** Where `html_render` stores published pages. */
  readonly attachmentsDir: string;
  /** A home thread's credential, as `ProviderSessionManager` issues it. */
  readonly issueSquire: (input: {
    readonly threadId: ThreadId;
    readonly squireId: SquireId;
    readonly role: SquireRole;
  }) => Effect.Effect<McpProviderSessionConfig>;
  /** An ordinary thread's credential. */
  readonly issueNormal: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig>;
  /** Flips the Squires switch, as a settings write would. */
  readonly setSquireEnabled: (on: boolean) => Effect.Effect<void>;
}

/**
 * Serves the gated production `/mcp` on the test server, with the Squire
 * switch as given. `squireTools` stands in for the switch-on `SquireTools`;
 * an external client credential is accepted for `externalClient.token`.
 */
export const serveBoundMcp = (options: {
  readonly squireEnabled: boolean;
  readonly squireTools?: SquireTools.SquireTools["Service"] | undefined;
  readonly externalClient?:
    | { readonly token: string; readonly scope: McpInvocationContext.McpInvocationScope }
    | undefined;
}): Effect.Effect<BoundMcp, never, Scope.Scope | HttpServer.HttpServer> =>
  Effect.gen(function* () {
    // Built once, so tests can read the pages the server stores.
    const config = yield* Layer.build(layerConfig(options.squireEnabled)).pipe(
      Effect.provide(NodeServices.layer),
      Effect.orDie,
    );
    const registry = yield* McpSessionRegistry.__testing
      .make()
      .pipe(Effect.provide(Layer.merge(layerEnvironment, NodeServices.layer)));
    const routes = McpHttpServer.layer.pipe(
      Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
      Layer.provide(AppToolInterceptor.layerNoAppTools),
      Layer.provide(
        options.squireTools === undefined
          ? Layer.empty
          : Layer.succeed(SquireTools.SquireTools, options.squireTools),
      ),
      Layer.provide(layerExternalClient(options.externalClient)),
    );
    yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provide(PreviewAutomationBroker.layer),
      Layer.provide(McpProviderSessions.layer),
      Layer.provide(layerStubServices),
      Layer.provide(Layer.succeedContext(config)),
      Layer.provide(layerEnvironment),
      Layer.provide(NodeServices.layer),
      Layer.build,
      Effect.orDie,
    );
    const issue = (request: McpSessionRegistry.McpCredentialRequest) =>
      registry.issue(request).pipe(Effect.map(({ config }) => config));
    return {
      registry,
      attachmentsDir: Context.get(config, ServerConfig.ServerConfig).attachmentsDir,
      issueSquire: ({ threadId, squireId, role }) =>
        issue({
          threadId,
          providerInstanceId: boundMcpProviderInstanceId,
          squire: { squireId, role },
        }),
      issueNormal: (threadId) =>
        issue({ threadId, providerInstanceId: boundMcpProviderInstanceId }),
      setSquireEnabled: (on) =>
        SubscriptionRef.set(Context.get(config, SquireSwitch.SquireSwitchControl), on),
    } satisfies BoundMcp;
  });

export interface McpReply {
  readonly status: number;
  /** Every JSON-RPC message in the body, JSON or SSE framed. */
  readonly messages: ReadonlyArray<Record<string, unknown>>;
}

/**
 * A bare JSON-RPC client on one MCP session, so tests can send what a real
 * SDK client never would (batches, garbage, resource reads).
 */
export const connectMcp = async (config: McpProviderSessionConfig) => {
  let sessionId: string | null = null;
  let nextId = 0;
  const post = async (body: string): Promise<McpReply> => {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        authorization: config.authorizationHeader,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
      },
      body,
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const text = await response.text();
    const chunks = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice("data: ".length))
      : text.trim().length === 0
        ? []
        : [text];
    return {
      status: response.status,
      messages: chunks.map((chunk) => JSON.parse(chunk) as Record<string, unknown>),
    };
  };
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    const reply = await post(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const answer = reply.messages.find((message) => message.id === id);
    return { status: reply.status, answer };
  };
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "squire-bound-mcp", version: "1" },
  });
  await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return {
    post,
    request,
    listToolNames: async () => {
      const { answer } = await request("tools/list");
      const tools = (answer?.result as { tools?: ReadonlyArray<{ name: string }> } | undefined)
        ?.tools;
      if (tools === undefined) throw new Error(`tools/list failed: ${JSON.stringify(answer)}`);
      return tools.map((tool) => tool.name);
    },
    callTool: (name: string, args: Record<string, unknown> = {}) =>
      request("tools/call", { name, arguments: args }),
  };
};
export type McpTestClient = Awaited<ReturnType<typeof connectMcp>>;
