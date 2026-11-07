import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  MessageId,
  NodeId,
  RunAttemptId,
  RunId,
  type OrchestrationV2UserInputQuestion,
  type OrchestrationV2RuntimeRequest,
  ProviderInstanceId,
  ProviderSessionId,
  type RuntimeMode,
  ThreadId,
} from "@lecturn/contracts";
import { GrokSettings } from "@lecturn/provider-grok/settings";
import * as HostProcess from "@lecturn/shared/HostProcess";
import { resolveSelfInvocation } from "@lecturn/shared/nodeRuntime";
import * as EffectAcpErrors from "effect-acp/errors";
import { xAiRateLimitedErrorCode } from "@lecturn/provider-grok/testing";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as TestProviderHost from "@lecturn/provider-testing/TestProviderHost";
import * as ProjectStore from "../ProjectStore.ts";
import { buildInitialGrokProviderSnapshot } from "@lecturn/provider-grok/testing";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as RuntimePolicy from "../RuntimePolicy.ts";
import { acpAppInstructions } from "@lecturn/provider-acp/server/appInstructions";
import * as AcpSessionRuntime from "@lecturn/provider-acp/server/AcpSessionRuntime";
import { acpPermissionDisposition } from "@lecturn/provider-acp/server/clientPolicy";
import { acpCompletedTurnShouldTerminalizeTool } from "@lecturn/provider-acp/server/adapter";
import {
  makeGrokAcpAdapterFlavor,
  makeGrokAdapterV2,
  GROK_PROVIDER,
  GROK_ACP_INITIALIZE_META,
  GROK_SQUIRE_AGENT_PROFILE,
  GROK_SQUIRE_CONFIG_TOML,
  GROK_SQUIRE_DISALLOWED_TOOLS,
  GROK_SQUIRE_UNVERIFIED_VERSION,
  GROK_SQUIRE_VERIFIED_VERSIONS,
  makeGrokSquireHome,
} from "@lecturn/provider-grok/testing";

import { makeAcpReplayRuntime, type AcpReplayTranscript } from "./AcpAdapterV2.testkit.ts";

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const LAUNCH_TEST_GROK_SETTINGS = Schema.decodeSync(GrokSettings)({
  binaryPath: "grok-launch-test",
});

function permissionRequest(
  kind: EffectAcpSchema.ToolKind,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    toolCall: {
      toolCallId: "tool-1",
      title: "Test tool",
      kind,
    },
  };
}

function runtimePolicy(input: {
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}) {
  return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
    ...(input.sandboxPolicy === undefined ? {} : { sandboxPolicy: input.sandboxPolicy }),
  });
}

describe("GrokAdapterV2 capabilities", () => {
  it("preserves Grok's rate-limit stop and distinguishes other prompt failures", () => {
    const flavor = makeGrokAcpAdapterFlavor(
      {
        makeRuntime: () => Effect.never,
      } as unknown as Parameters<typeof makeGrokAcpAdapterFlavor>[0],
      "/home/ada",
    );
    const limit = flavor.promptFailure?.(
      new EffectAcpErrors.AcpRequestError({
        code: xAiRateLimitedErrorCode,
        errorMessage: "Grok usage limit reached. Try again later.",
      }),
    );
    assert.equal(limit?.class, "usage_limit");
    assert.equal(limit?.code, String(xAiRateLimitedErrorCode));
    assert.equal(limit?.message, "Grok usage limit reached. Try again later.");
    assert.equal(
      flavor.promptFailure?.(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Internal error",
        }),
      ).class,
      "provider_error",
    );
    assert.equal(
      flavor.promptFailure?.(new Error("Rate limit mentioned in an ordinary error")).class,
      "provider_error",
    );
  });

  it("names app tools in the form Grok's use_tool takes, not the bare name it rejects", () => {
    const flavor = makeGrokAcpAdapterFlavor(
      {
        makeRuntime: () => Effect.never,
      } as unknown as Parameters<typeof makeGrokAcpAdapterFlavor>[0],
      "/home/ada",
    );

    assert.equal(
      acpAppInstructions({
        instructions: "You can increment a counter and flash the host window.",
        app: {
          appId: "dev.example.embedhost",
          toolPrefix: "ex",
          toolNames: ["ex_counter_increment", "ex_window_flash"],
        },
        toolName: flavor.lecturnMcpToolName,
      }),
      "You can increment a counter and flash the host window.\n\n" +
        "Call this app's tools by these exact names: `lecturn__ex_counter_increment`, `lecturn__ex_window_flash`.",
    );
  });

  it("terminalizes only foreground tools under the actual Grok flavor", () => {
    const flavor = makeGrokAcpAdapterFlavor(
      {
        makeRuntime: () => Effect.never,
      } as unknown as Parameters<typeof makeGrokAcpAdapterFlavor>[0],
      "/home/ada",
    );
    const foreground = {
      toolCallId: "foreground-1",
      title: "Terminal",
      status: "inProgress" as const,
      data: {
        rawInput: { command: "true" },
        rawOutput: { type: "Bash", exit_code: 0 },
      },
    };
    const monitor = {
      toolCallId: "monitor-1",
      title: "Monitor",
      status: "inProgress" as const,
      data: {
        rawInput: { variant: "Monitor", command: "sleep 30" },
        rawOutput: {
          type: "Monitor",
          taskId: "019f44b8-8e98-7c80-a40e-df1e26a5f9e3",
        },
      },
    };
    const subagent = {
      toolCallId: "subagent-1",
      title: "Task",
      status: "inProgress" as const,
      data: {
        rawInput: {
          description: "Inspect interrupt handling",
          prompt: "Review the adapter.",
          subagent_type: "generalPurpose",
        },
      },
    };

    assert.isTrue(acpCompletedTurnShouldTerminalizeTool(foreground, flavor));
    assert.isFalse(acpCompletedTurnShouldTerminalizeTool(monitor, flavor));
    assert.isFalse(acpCompletedTurnShouldTerminalizeTool(subagent, flavor));
  });
});

describe("ACP permission policy", () => {
  it("honors explicit on-request approval over full-access runtime mode", () => {
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({
          runtimeMode: "full-access",
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "readOnly" },
        }),
        permissionRequest("execute"),
      ),
      "ask",
    );
  });

  it("rejects mutating escalation under a non-interactive read-only policy", () => {
    const policy = runtimePolicy({
      runtimeMode: "full-access",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    });
    assert.equal(acpPermissionDisposition(policy, permissionRequest("execute")), "deny");
    assert.equal(acpPermissionDisposition(policy, permissionRequest("edit")), "deny");
    assert.equal(acpPermissionDisposition(policy, permissionRequest("read")), "allow");
  });

  it("auto-approves requests only when the resolved policy permits them", () => {
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({
          runtimeMode: "full-access",
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        }),
        permissionRequest("execute"),
      ),
      "allow",
    );
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({ runtimeMode: "approval-required" }),
        permissionRequest("edit"),
      ),
      "ask",
    );
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({ runtimeMode: "approval-required" }),
        permissionRequest("read"),
      ),
      "allow",
    );
  });
});

describe("Grok permission prompts", () => {
  const disposition = makeGrokAcpAdapterFlavor(
    {
      makeRuntime: () => Effect.never,
    } as unknown as Parameters<typeof makeGrokAcpAdapterFlavor>[0],
    "/home/ada",
  ).permissionDisposition;

  it("leaves Auto prompts to the user unless an explicit policy launched Grok asking", () => {
    assert.equal(
      disposition?.(runtimePolicy({ runtimeMode: "auto" }), permissionRequest("read")),
      "ask",
    );
    const readOnly = runtimePolicy({
      runtimeMode: "auto",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    });
    assert.equal(disposition?.(readOnly, permissionRequest("execute")), "deny");
    assert.equal(
      disposition?.(runtimePolicy({ runtimeMode: "approval-required" }), permissionRequest("edit")),
      "ask",
    );
  });
});

describe("Grok launch permission mode", () => {
  const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
  const layerTest = Layer.mergeAll(
    NodeServices.layer,
    IdAllocator.layer,
    McpProviderSessions.layer,
    layerHost,
  );

  const launchArgs = (runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy) =>
    Effect.gen(function* () {
      const launches: Array<ReadonlyArray<string>> = [];
      const childProcessSpawner = ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") launches.push(command.args);
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "grok-launch-test",
            method: "spawn",
          }),
        );
      });
      const instanceId = ProviderInstanceId.make("grok-launch-test");
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: LAUNCH_TEST_GROK_SETTINGS,
        environment: {},
        hostPlatform: "darwin",
        selfInvocation: yield* resolveSelfInvocation(),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner));
      yield* adapter
        .openSession({
          threadId: ThreadId.make("grok-launch-test"),
          providerSessionId: ProviderSessionId.make("grok-launch-test"),
          modelSelection: { instanceId, model: "grok-build" },
          runtimePolicy,
        })
        .pipe(Effect.scoped, Effect.ignore);
      return launches;
    }).pipe(Effect.provideService(HostProcess.Platform, "darwin"), Effect.provide(layerTest));

  const policy = (
    runtimeMode: RuntimeMode,
    override: Partial<ProviderAdapter.ProviderAdapterV2RuntimePolicy> = {},
  ) =>
    ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode,
      interactionMode: "default",
      cwd: process.cwd(),
      ...override,
    });

  it.effect.each(
    (
      [
        ["approval-required", ["--permission-mode", "default", "agent", "stdio"]],
        ["auto", ["--permission-mode", "auto", "agent", "stdio"]],
        ["full-access", ["agent", "--always-approve", "stdio"]],
      ] as const
    ).map(([runtimeMode, args]) => [runtimeMode, args.join(" "), args] as const),
  )("launches %s threads with %s", ([runtimeMode, , args]) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* launchArgs(policy(runtimeMode)), [args]);
    }),
  );

  it.effect("launches a thread stored as Auto-accept edits asking", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(LAUNCH_TEST_GROK_SETTINGS);
      const instanceId = ProviderInstanceId.make("grok-launch-test");
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("grok-launch-test");
      const modelSelection = { instanceId, model: "grok-build" } as const;
      const resolved = yield* Effect.gen(function* () {
        const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
        return yield* runtimePolicy.resolve({
          thread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("grok-launch-test"),
            title: "Grok launch test",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
            branch: null,
            worktreePath: process.cwd(),
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          modelSelection,
        });
      }).pipe(
        Effect.provide(
          RuntimePolicy.layerFromProjectStore.pipe(
            Layer.provide(
              Layer.mock(ProjectStore.ProjectStoreV2)({
                get: () => Effect.die("the thread has a worktree"),
              }),
            ),
            Layer.provide(
              Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                getInstance: () =>
                  Effect.succeed({
                    snapshot: { getSnapshot: Effect.succeed(snapshot) },
                  } as ProviderInstance),
              }),
            ),
          ),
        ),
      );
      assert.equal(resolved.runtimeMode, "approval-required");
      assert.deepEqual(yield* launchArgs(resolved), [
        ["--permission-mode", "default", "agent", "stdio"],
      ]);
    }),
  );

  it.effect("launches asking when an explicit approval or sandbox policy governs the thread", () =>
    Effect.gen(function* () {
      const asking = [["--permission-mode", "default", "agent", "stdio"]];
      assert.deepEqual(
        yield* launchArgs(
          policy("full-access", {
            approvalPolicy: "never",
            sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          }),
        ),
        asking,
      );
      assert.deepEqual(
        yield* launchArgs(policy("full-access", { approvalPolicy: "on-request" })),
        asking,
      );
    }),
  );
});

describe("Grok native questions", () => {
  const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
  const layerTest = Layer.mergeAll(
    NodeServices.layer,
    IdAllocator.layer,
    McpProviderSessions.layer,
    layerHost,
  );

  it.live("keeps x.ai multi-select questions live and returns all selected answers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "grok-multi-select-" });
      const questionText = "Which changes should be included?";
      const transcript: AcpReplayTranscript = {
        provider: GROK_PROVIDER,
        protocol: "acp.ndjson-jsonrpc",
        version: "1",
        scenario: "grok-multi-select",
        entries: [
          {
            type: "expect_outbound",
            label: "initialize",
            frame: { kind: "request", method: "initialize", params: "<any>" },
          },
          {
            type: "emit_inbound",
            label: "initialized",
            frame: {
              kind: "response",
              method: "initialize",
              result: {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
                authMethods: [{ id: "replay", name: "Replay" }],
              },
            },
          },
          {
            type: "expect_outbound",
            label: "session.new",
            frame: { kind: "request", method: "session/new", params: "<any>" },
          },
          {
            type: "emit_inbound",
            label: "session.created",
            frame: {
              kind: "response",
              method: "session/new",
              result: {
                sessionId: "grok-multi-select-session",
                models: {
                  currentModelId: "grok-build",
                  availableModels: [{ modelId: "grok-build", name: "Grok Build" }],
                },
              },
            },
          },
          {
            type: "expect_outbound",
            label: "prompt",
            frame: { kind: "request", method: "session/prompt", params: "<any>" },
          },
          {
            type: "emit_inbound",
            label: "question",
            frame: {
              kind: "request",
              method: "_x.ai/ask_user_question",
              params: {
                method: "x.ai/ask_user_question",
                params: {
                  sessionId: "grok-multi-select-session",
                  toolCallId: "grok-question",
                  mode: "default",
                  questions: [
                    {
                      id: "changes",
                      question: questionText,
                      multiSelect: true,
                      options: [
                        { label: "Tests", description: "Cover behavior" },
                        { label: "Docs", description: "Explain usage" },
                      ],
                    },
                  ],
                },
              },
            },
          },
          {
            type: "expect_outbound",
            label: "selected answers",
            frame: {
              kind: "response",
              method: "_x.ai/ask_user_question",
              result: { outcome: "accepted", answers: { [questionText]: ["Tests", "Docs"] } },
            },
          },
          {
            type: "emit_inbound",
            label: "complete",
            frame: {
              kind: "response",
              method: "session/prompt",
              result: { stopReason: "end_turn" },
            },
          },
        ],
      };
      const statusPath = path.join(workspace, "status.json");
      const scriptPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("grok-multi-select");
      const threadId = ThreadId.make("grok-multi-select-thread");
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: LAUNCH_TEST_GROK_SETTINGS,
        environment: {},
        hostPlatform: "darwin",
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath,
          childProcessSpawner,
          fileSystem: fs,
          initializeMeta: GROK_ACP_INITIALIZE_META,
        }),
      });
      const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "grok-build" };
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("grok-multi-select-session"),
        modelSelection,
        runtimePolicy: policy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const question = yield* Deferred.make<OrchestrationV2UserInputQuestion>();
      const request = yield* Deferred.make<OrchestrationV2RuntimeRequest>();
      const terminal = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => {
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "user_input_request" &&
            event.turnItem.questions[0]
          )
            return Deferred.succeed(question, event.turnItem.questions[0]);
          if (event.type === "runtime_request.updated")
            return Deferred.succeed(request, event.runtimeRequest);
          if (event.type === "turn.terminal") return Deferred.succeed(terminal, undefined);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      const now = yield* DateTime.now;
      yield* runtime.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("grok-multi-select-project"),
          title: "Grok multi-select",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: workspace,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("grok-multi-select-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("grok-multi-select-attempt"),
        rootNodeId: NodeId.make("grok-multi-select-root"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("grok-multi-select-message"),
          text: "Ask which changes to include.",
          attachments: [],
        },
        modelSelection,
        runtimePolicy: policy,
      });
      assert.deepEqual(yield* Deferred.await(question), {
        id: "changes",
        header: "Question",
        question: questionText,
        multiSelect: true,
        options: [
          { label: "Tests", description: "Cover behavior" },
          { label: "Docs", description: "Explain usage" },
        ],
      });
      const pending = yield* Deferred.await(request);
      assert.equal(pending.kind, "user_input");
      assert.equal(pending.responseCapability.type, "live");
      yield* runtime.respondToRuntimeRequest({
        requestId: pending.id,
        answers: { changes: ["Tests", "Docs"] },
      });
      yield* Deferred.await(terminal);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});

describe("Grok Squire isolation", () => {
  const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
  const layerTest = Layer.mergeAll(
    NodeServices.layer,
    IdAllocator.layer,
    McpProviderSessions.layer,
    layerHost,
  );

  // A user Grok home carrying everything a Squire must not reach.
  const makeHomes = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-grok-squire-" });
    const userHome = path.join(root, "user");
    const userGrokHome = path.join(userHome, ".grok");
    yield* fs.makeDirectory(path.join(userGrokHome, "skills", "sentinel"), { recursive: true });
    yield* fs.writeFileString(path.join(userGrokHome, "auth.json"), "{}");
    yield* fs.writeFileString(path.join(userGrokHome, "AGENTS.md"), "SENTINEL-MEMORY-LEAK");
    yield* fs.writeFileString(
      path.join(userGrokHome, "config.toml"),
      '[mcp_servers.sentinel]\ncommand = "sentinel"\n',
    );
    yield* fs.writeFileString(path.join(userGrokHome, "skills", "sentinel", "SKILL.md"), "x");
    return { fs, path, root, userHome, userGrokHome, stateDir: path.join(root, "state") };
  });

  const squireHomeFor = (
    homes: Effect.Success<typeof makeHomes>,
    instanceId: ProviderInstanceId,
    managedPolicyPaths: ReadonlyArray<string> = [],
    cliVersion: string | null = GROK_SQUIRE_VERIFIED_VERSIONS[0] ?? null,
  ) =>
    makeGrokSquireHome({
      fileSystem: homes.fs,
      path: homes.path,
      stateDir: homes.stateDir,
      instanceId,
      homeDirectory: homes.userHome,
      managedPolicyPaths,
      cliVersion: () => Effect.succeed(cliVersion),
    });

  const recordLaunches = (input: {
    readonly homes: Effect.Success<typeof makeHomes>;
    readonly squireIsolation?: "home" | "probe";
    readonly initialNativeThreadId?: string;
    readonly withSquireHome?: boolean;
  }) =>
    Effect.gen(function* () {
      const launches: Array<{
        readonly args: ReadonlyArray<string>;
        readonly env: Record<string, string | undefined>;
      }> = [];
      const childProcessSpawner = ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") {
          launches.push({ args: command.args, env: { ...command.options.env } });
        }
        return Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "grok-squire", method: "spawn" }),
        );
      });
      const instanceId = ProviderInstanceId.make("grok-squire-test");
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: LAUNCH_TEST_GROK_SETTINGS,
        environment: { PATH: "/usr/bin", GROK_CONFIG: '{"subagents":{"enabled":true}}' },
        hostPlatform: "darwin",
        selfInvocation: yield* resolveSelfInvocation(),
        ...(input.withSquireHome === false
          ? {}
          : { squireHome: squireHomeFor(input.homes, instanceId) }),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner));
      const exit = yield* adapter
        .openSession({
          threadId: ThreadId.make("grok-squire-test"),
          providerSessionId: ProviderSessionId.make("grok-squire-test"),
          modelSelection: { instanceId, model: "grok-build" },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: process.cwd(),
            ...(input.squireIsolation === undefined
              ? {}
              : { squireIsolation: input.squireIsolation }),
          }),
          ...(input.initialNativeThreadId === undefined
            ? {}
            : { initialNativeThreadId: input.initialNativeThreadId }),
        })
        .pipe(Effect.scoped, Effect.exit);
      return { launches, exit };
    }).pipe(Effect.provideService(HostProcess.Platform, "darwin"));

  it.effect.each(
    (["home", "probe"] as const).flatMap((squireIsolation) =>
      (["start", "resume"] as const).map((open) => [squireIsolation, open] as const),
    ),
  )("launches a %s on %s in its own Grok home with no native tools", ([squireIsolation, open]) =>
    Effect.gen(function* () {
      const homes = yield* makeHomes;
      const { launches } = yield* recordLaunches({
        homes,
        squireIsolation,
        ...(open === "resume" ? { initialNativeThreadId: "persisted-squire" } : {}),
      });
      const squireRoot = homes.path.join(
        homes.stateDir,
        "providers",
        "grok",
        "grok-squire-test",
        "squire",
      );
      const grokHome = homes.path.join(squireRoot, "grok-home");
      const profile = homes.path.join(grokHome, "lecturn-squire.md");
      assert.isAbove(launches.length, 0);
      for (const launch of launches) {
        assert.deepEqual(launch.args, [
          "--permission-mode",
          "default",
          "agent",
          "--no-leader",
          "--agent-profile",
          profile,
          "stdio",
        ]);
        assert.equal(launch.env.GROK_HOME, grokHome);
        assert.equal(launch.env.HOME, homes.path.join(squireRoot, "home"));
        assert.equal(launch.env.GROK_AUTH_PATH, homes.path.join(homes.userGrokHome, "auth.json"));
        assert.isUndefined(launch.env.GROK_CONFIG);
      }
      assert.equal(yield* homes.fs.readFileString(profile), GROK_SQUIRE_AGENT_PROFILE);
      assert.include(GROK_SQUIRE_AGENT_PROFILE, "\ntools: search_tool, use_tool\n");
      for (const tool of ["run_terminal_command", "read_file", "write", "spawn_subagent"]) {
        assert.include(GROK_SQUIRE_DISALLOWED_TOOLS, tool);
      }
      assert.equal(
        yield* homes.fs.readFileString(homes.path.join(grokHome, "config.toml")),
        GROK_SQUIRE_CONFIG_TOML,
      );
      // The user's MCP servers, skills, and AGENTS.md stay in the user's home.
      assert.sameMembers(yield* homes.fs.readDirectory(grokHome), [
        "config.toml",
        "lecturn-squire.md",
      ]);
      assert.deepEqual(yield* homes.fs.readDirectory(homes.path.join(squireRoot, "home")), []);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("launches ordinary threads in the user's Grok home as before", () =>
    Effect.gen(function* () {
      const homes = yield* makeHomes;
      const { launches } = yield* recordLaunches({ homes });
      assert.deepEqual(
        launches.map((launch) => launch.args),
        [["--permission-mode", "default", "agent", "stdio"]],
      );
      assert.isUndefined(launches[0]?.env.GROK_HOME);
      assert.isUndefined(launches[0]?.env.GROK_AUTH_PATH);
      assert.equal(launches[0]?.env.GROK_CONFIG, '{"subagents":{"enabled":true}}');
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("never launches a Squire on an instance without a Squire home", () =>
    Effect.gen(function* () {
      const homes = yield* makeHomes;
      const { launches, exit } = yield* recordLaunches({
        homes,
        squireIsolation: "home",
        withSquireHome: false,
      });
      assert.isTrue(exit._tag === "Failure");
      assert.deepEqual(launches, []);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("reports a missing sign-in or an organization policy as a Squire gap", () =>
    Effect.gen(function* () {
      const homes = yield* makeHomes;
      const instanceId = ProviderInstanceId.make("grok-squire-readiness");
      const ready = squireHomeFor(homes, instanceId);
      assert.isNull(yield* ready.readiness({}));
      yield* homes.fs.remove(homes.path.join(homes.userGrokHome, "auth.json"));
      assert.include(yield* ready.readiness({}), "Run `grok login`");
      assert.isNull(yield* ready.readiness({ XAI_API_KEY: "key" }));
      const policyPath = homes.path.join(homes.root, "requirements.toml");
      yield* homes.fs.writeFileString(policyPath, "");
      assert.include(
        yield* squireHomeFor(homes, instanceId, [policyPath]).readiness({ XAI_API_KEY: "key" }),
        "organization policy",
      );
      const refused = yield* ready.prepare({}).pipe(Effect.flip);
      assert.include(refused.message, "Run `grok login`");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("refuses a Squire on a Grok version whose native tools were not checked", () =>
    Effect.gen(function* () {
      const homes = yield* makeHomes;
      const instanceId = ProviderInstanceId.make("grok-squire-version");
      for (const version of ["1.0.71", "2.0.0", null]) {
        const home = squireHomeFor(homes, instanceId, [], version);
        assert.equal(yield* home.readiness({}), GROK_SQUIRE_UNVERIFIED_VERSION, String(version));
        const refused = yield* home.prepare({}).pipe(Effect.flip);
        assert.include(refused.message, GROK_SQUIRE_UNVERIFIED_VERSION);
      }
      assert.isNull(yield* squireHomeFor(homes, instanceId).readiness({}));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "approves a home's Squire tool and declines the rest without asking, even launched Auto",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const requestLog = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-grok-squire-contract-" }),
          "requests.jsonl",
        );
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const instanceId = ProviderInstanceId.make("grok-squire-contract");
        const threadId = ThreadId.make("grok-squire-contract");
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("environment-grok-squire-contract"),
          threadId,
          providerSessionId: "mcp-session-grok-squire-contract",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer squire-token",
          browserToolsAvailable: false,
          capabilities: new Set(["squire"]),
        });
        const adapter = yield* makeGrokAdapterV2({
          instanceId,
          settings: LAUNCH_TEST_GROK_SETTINGS,
          environment: {},
          hostPlatform: "darwin",
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            Effect.gen(function* () {
              const context = yield* Layer.build(
                AcpSessionRuntime.layer({
                  ...input,
                  spawn: {
                    command: process.execPath,
                    args: [mockAgentPath],
                    cwd: process.cwd(),
                    env: {
                      LECTURN_ACP_SESSION_LIFECYCLE: "1",
                      LECTURN_ACP_REQUEST_LOG_PATH: requestLog,
                      LECTURN_ACP_EMIT_TOOL_CALLS: "1",
                      // Grok's `use_tool` titles a Lecturn call by its qualified name.
                      LECTURN_ACP_PERMISSION_TOOL_CALLS:
                        "other|lecturn__squire_note,other|sentinel__sentinel_probe,execute|`cat ~/.ssh/id_rsa`,edit|Write notes.md,read|Read /etc/hosts",
                    },
                  },
                  authMethodId: "test",
                }),
              );
              return yield* AcpSessionRuntime.AcpSessionRuntime.pipe(Effect.provide(context));
            }),
        });
        // Grok's own Auto mode leaves every prompt to the user; a Squire's must not.
        const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto",
          interactionMode: "default",
          cwd: process.cwd(),
          squireIsolation: "home",
        });
        const modelSelection = { instanceId, model: "grok-build" };
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("grok-squire-contract"),
          modelSelection,
          runtimePolicy: policy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: policy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("grok-squire-contract"),
            title: "Grok Squire",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: process.cwd(),
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("grok-squire-contract-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("grok-squire-contract-attempt"),
          rootNodeId: NodeId.make("grok-squire-contract-root"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("grok-squire-contract-message"),
            text: "Note the event.",
            attachments: [],
          },
          modelSelection,
          runtimePolicy: policy,
          squireInstructions: ["You are this project's Squire."],
        });
        const events = Array.from(
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        assert.isFalse(events.some((event) => event.type === "runtime_request.updated"));
        const received = (yield* fs.readFileString(requestLog))
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => decodeJsonLine(line));
        const prompt = received.find(
          (message) => Reflect.get(Object(message), "method") === "session/prompt",
        );
        assert.include(JSON.stringify(prompt), "You are this project's Squire.");
        const chosen = received.flatMap((message) => {
          const optionId: unknown = Reflect.get(
            Object(Reflect.get(Object(Reflect.get(Object(message), "result")), "outcome")),
            "optionId",
          );
          return typeof optionId === "string" ? [optionId] : [];
        });
        assert.deepEqual(chosen, [
          "allow-once",
          "reject-once",
          "reject-once",
          "reject-once",
          "reject-once",
        ]);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
