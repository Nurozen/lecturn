import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AppId,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { assertFullAccess, readCaller, readThread, resolveProjectId } from "./threadAccess.ts";

const appId = AppId.make("dev.rocketwright.app");
const appProject = ProjectId.make("project:app");
const otherProject = ProjectId.make("project:other");
const appThread = ThreadId.make("thread:app");
const appSibling = ThreadId.make("thread:app-sibling");
const otherThread = ThreadId.make("thread:other");

const inProject = (threadId: ThreadId, projectId: ProjectId): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(threadId),
  projectId,
});

const shells = new Map([
  [appThread, inProject(appThread, appProject)],
  [appSibling, inProject(appSibling, appProject)],
  [otherThread, inProject(otherThread, otherProject)],
]);

const projectShell = (id: ProjectId, bound: boolean) =>
  ({
    id,
    title: id,
    workspaceRoot: `/work/${id}`,
    defaultModelSelection: null,
    scripts: [],
    ...(bound ? { appBinding: { appId, workspaceRoot: `/work/${id}` } } : {}),
  }) as unknown as OrchestrationProjectShell;

const threadsLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
  getThreadRecords: (threadId) =>
    Effect.succeed(idleThreadProjection(shells.get(threadId) ?? liveThreadShell(threadId))),
  getProjectThreadRecords: ({ threadId }) =>
    Effect.succeed(
      idleThreadProjection(shells.get(threadId) ?? liveThreadShell(threadId)),
    ) as never,
  listProjectThreads: ({ projectId }) =>
    Effect.succeed([...shells.values()].filter((shell) => shell.projectId === projectId)),
});

const projectsLayer = Layer.mock(ProjectService.ProjectService)({
  getShell: (projectId) => Effect.succeedSome(projectShell(projectId, projectId === appProject)),
});

const threadScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "worktree"]),
  issuedAt: 0,
});

const appCaller: McpInvocationContext.McpInvocationScope = {
  ...threadScope(appThread),
  capabilities: new Set(["orchestration", "worktree", "app"]),
  app: { appId, projectId: appProject },
};
const plainCaller = threadScope(otherThread);

const outcome = <A, R>(effect: Effect.Effect<A, OrchestratorMcpFailure, R>) =>
  effect.pipe(
    Effect.as("ok"),
    Effect.catchTags({ OrchestratorMcpFailure: (failure) => Effect.succeed(failure.code) }),
  );

const asCaller = (scope: McpInvocationContext.McpInvocationScope) =>
  Effect.provide(
    Layer.mergeAll(threadsLayer, Layer.succeed(McpInvocationContext.McpInvocationContext, scope)),
  );

describe("thread access for a connected app's thread", () => {
  it.effect("reads threads of its own project only", () =>
    Effect.gen(function* () {
      expect(yield* outcome(readThread(appSibling)).pipe(asCaller(appCaller))).toBe("ok");
      expect(yield* outcome(readThread()).pipe(asCaller(appCaller))).toBe("ok");
      expect(yield* outcome(readThread(otherThread)).pipe(asCaller(appCaller))).toBe(
        "capability_denied",
      );
      expect(yield* outcome(readThread(appSibling)).pipe(asCaller(plainCaller))).toBe("ok");
    }),
  );

  it.effect("resolves no project but its own", () =>
    Effect.gen(function* () {
      const resolve = (projectId: ProjectId | undefined) =>
        readCaller().pipe(Effect.flatMap((context) => resolveProjectId(context, projectId)));
      expect(yield* resolve(undefined).pipe(asCaller(appCaller))).toBe(appProject);
      expect(yield* resolve(appProject).pipe(asCaller(appCaller))).toBe(appProject);
      expect(yield* outcome(resolve(otherProject)).pipe(asCaller(appCaller))).toBe(
        "capability_denied",
      );
      expect(yield* resolve(appProject).pipe(asCaller(plainCaller))).toBe(appProject);
    }),
  );

  it.effect("never changes projects or environment settings, even in full access", () =>
    Effect.gen(function* () {
      const check = readCaller().pipe(Effect.flatMap((context) => assertFullAccess(context, "")));
      expect(yield* outcome(check).pipe(asCaller(appCaller))).toBe("capability_denied");
      expect(yield* outcome(check).pipe(asCaller(plainCaller))).toBe("ok");
    }),
  );
});

const probe = {
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const ProbeToolkit = Toolkit.make(
  Tool.make("writes_threads", { ...probe, parameters: Schema.Struct({ threadId: ThreadId }) }),
);
const probeServer = McpHttpServer.toolkitRegistration(
  ProbeToolkit,
  McpToolAccess.toLayer(ProbeToolkit, {
    writes_threads: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      () => Effect.succeed({ ran: "ok" }),
    ),
  }),
).pipe(Layer.provideMerge(McpServer.McpServer.layer), Layer.provideMerge(threadsLayer));

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([Schema.Struct({ ran: Schema.String }), Schema.Struct({ code: Schema.String })]),
  ),
);

const callWrite = (scope: McpInvocationContext.McpInvocationScope, threadId: ThreadId) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) =>
      server.callTool({ name: "writes_threads", arguments: { threadId } }),
    ),
    Effect.flatMap(({ content }) =>
      decodeOutcome(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.map((result) => ("code" in result ? result.code : result.ran)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

describe("thread writes from a connected app's thread", () => {
  it.effect("reach threads of the app's own project only", () =>
    Effect.gen(function* () {
      expect(yield* callWrite(appCaller, appSibling)).toBe("ok");
      expect(yield* callWrite(appCaller, otherThread)).toBe("capability_denied");
      expect(yield* callWrite(plainCaller, appSibling)).toBe("ok");
    }).pipe(Effect.provide(probeServer)),
  );
});

const orchestratorLayer = OrchestratorMcpService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      threadsLayer,
      projectsLayer,
      NodeServices.layer,
      ServerSettings.layerTest(),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({
        list: () => Effect.succeed({ tasks: [] }) as never,
      }),
    ),
  ),
);

describe("orchestrator tools for a connected app's thread", () => {
  it.effect("refuse other projects and name the app in thread summaries", () =>
    Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;

      const own = yield* service.listThreads(appCaller, {});
      expect(own.projectId).toBe(appProject);
      expect(own.appId).toBe(appId);
      expect(own.threads.map((thread) => thread.threadId)).toEqual([appThread, appSibling]);
      expect(yield* outcome(service.listThreads(appCaller, { projectId: otherProject }))).toBe(
        "capability_denied",
      );

      // An ordinary thread still lists every project; only app projects carry an appId.
      const fromOther = yield* service.listThreads(plainCaller, { projectId: appProject });
      expect(fromOther.appId).toBe(appId);
      const plain = yield* service.listThreads(plainCaller, {});
      expect("appId" in plain).toBe(false);

      expect(yield* outcome(service.readThread(appCaller, { threadId: otherThread }))).toBe(
        "capability_denied",
      );
      expect(
        yield* outcome(service.sendToThread(appCaller, { threadId: otherThread, message: "hi" })),
      ).toBe("capability_denied");
      expect(
        yield* outcome(service.listScheduledTasks(appCaller, { projectId: otherProject })),
      ).toBe("capability_denied");
      expect(yield* outcome(service.listScheduledTasks(appCaller, {}))).toBe("ok");
    }).pipe(Effect.provide(orchestratorLayer)),
  );
});

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>) =>
  readThread(bareId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);
