import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { InteractionUpdate } from "@cursor/sdk";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as TestProviderHost from "@lecturn/provider-testing/TestProviderHost";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import { LECTURN_ORCHESTRATION_INSTRUCTIONS } from "@lecturn/provider-core/server/orchestrationInstructions";
import { makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

const instanceId = ProviderInstanceId.make("cursor");
const modelSelection = { instanceId, model: "composer-2.5" };
const SQUIRE_SKILL = "## Squire\n\nSQUIRE-SKILL-SENTINEL: stay quiet by default.";

type Role = "home" | "probe" | undefined;

const policyFor = (role: Role, cwd: string) =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: role === undefined ? "full-access" : "approval-required",
    interactionMode: "default",
    cwd,
    ...(role === undefined ? {} : { squireIsolation: role }),
  });

/**
 * A Cursor adapter over a fake SDK runner that records every agent it opens
 * and every message it sends, then streams `updates` for each run.
 */
const makeHarness = Effect.fn("makeHarness")(function* (input: {
  readonly threadId: ThreadId;
  readonly workspace: string;
  readonly updates?: ReadonlyArray<InteractionUpdate>;
}) {
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  yield* mcpSessions.set({
    environmentId: EnvironmentId.make("cursor-squire-environment"),
    threadId: input.threadId,
    providerSessionId: "cursor-squire-session",
    providerInstanceId: instanceId,
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer squire-credential",
    browserToolsAvailable: false,
  });
  const opened: Array<CursorAgentSdk.CursorAgentSdkOpenInput> = [];
  const sent: Array<CursorAgentSdk.CursorAgentSdkSendInput<unknown>> = [];
  let agents = 0;
  const adapter = yield* makeCursorAdapterV2({
    instanceId,
    environment: { HOME: input.workspace },
    // A user with Stave memory configured for this cwd.
    resolveStaveMemory: () =>
      Effect.succeed({
        state: "configured",
        config: { command: "/opt/context-marmot", args: ["serve"] },
      }),
  }).pipe(
    Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
      assertComplete: Effect.void,
      open: (openInput) =>
        Effect.sync(() => {
          opened.push(openInput);
          const agentId = openInput.agentId ?? `native-cursor-agent-${++agents}`;
          return {
            agentId,
            listMessages: Effect.succeed([]),
            close: Effect.void,
            send: (sendInput) =>
              Effect.gen(function* () {
                sent.push(sendInput);
                for (const update of input.updates ?? []) {
                  yield* sendInput.onDelta!(update).pipe(Effect.orDie);
                }
                return {
                  agentId,
                  runId: `native-cursor-run-${sent.length}`,
                  wait: Effect.succeed({
                    id: `native-cursor-run-${sent.length}`,
                    requestId: "native-request",
                    status: "finished" as const,
                    model: { id: "composer-2.5" },
                    durationMs: 1,
                  }),
                  cancel: Effect.void,
                };
              }),
          };
        }),
    }),
    Effect.provide(TestProviderHost.layer({ cwd: input.workspace })),
  );
  return { adapter, opened, sent };
});

const turnInput = Effect.fn("turnInput")(function* (input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly squireInstructions?: ReadonlyArray<string>;
  readonly text: string;
}) {
  const now = yield* DateTime.now;
  return {
    threadId: input.threadId,
    providerThread: input.providerThread,
    modelSelection,
    runtimePolicy: input.runtimePolicy,
    runId: RunId.make("cursor-squire-run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("cursor-squire-attempt"),
    rootNodeId: NodeId.make("cursor-squire-root"),
    appThread: {
      id: input.threadId,
      projectId: ProjectId.make("cursor-squire-project"),
      createdBy: "user" as const,
      creationSource: "web" as const,
      title: "Cursor Squire",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: input.runtimePolicy.runtimeMode,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    message: {
      messageId: MessageId.make("cursor-squire-message"),
      createdBy: "user" as const,
      creationSource: "web" as const,
      text: input.text,
      attachments: [],
    },
    ...(input.squireInstructions === undefined
      ? {}
      : { squireInstructions: input.squireInstructions }),
  };
});

const testLayer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer);

describe("Cursor Squire isolation", () => {
  // Cursor has no native fork (`canForkThread: false`), so a probe fork is a
  // fresh session opened with the probe policy: the `create` row below.
  it.effect.each([{ role: "home" as const }, { role: "probe" as const }, { role: undefined }])(
    "opens agents for role $role on start and resume",
    ({ role }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-squire-" });
        const threadId = ThreadId.make(`cursor-squire-${role ?? "normal"}`);
        const runtimePolicy = policyFor(role, workspace);
        const { adapter, opened } = yield* makeHarness({ threadId, workspace });

        const first = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-squire-session-1"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* first.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        // A restart: a new session resumes the stored agent.
        const second = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-squire-session-2"),
          modelSelection,
          runtimePolicy,
        });
        yield* second.resumeThread({ providerThread });

        assert.deepEqual(
          opened.map((open) => open.operation),
          ["create", "resume"],
        );
        for (const { options } of opened) {
          if (role === undefined) {
            assert.isUndefined(options.tools);
            assert.deepEqual(options.local?.settingSources, [
              "project",
              "user",
              "team",
              "mdm",
              "plugins",
            ]);
            assert.deepEqual(Object.keys(options.mcpServers ?? {}).toSorted(), [
              "context-marmot",
              "lecturn",
            ]);
            continue;
          }
          assert.isUndefined(options.local?.settingSources);
          assert.isFalse(options.local?.autoReview);
          assert.equal(options.mode, "agent");
          assert.isUndefined(options.agents);
          assert.isUndefined(options.disallowedTools);
          if (role === "home") {
            assert.deepEqual(options.tools, ["mcp"]);
            assert.deepEqual(options.mcpServers, {
              lecturn: {
                type: "http",
                url: "http://127.0.0.1:43123/mcp",
                headers: { Authorization: "Bearer squire-credential" },
              },
            });
            // A sandboxed run asks for every MCP call, and the SDK refuses.
            assert.isFalse(options.local?.sandboxOptions?.enabled);
          } else {
            assert.deepEqual(options.tools, []);
            assert.isUndefined(options.mcpServers);
            assert.isTrue(options.local?.sandboxOptions?.enabled);
          }
        }
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("delivers the Squire skill, runs Squire tools unasked, and raises no approval", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-squire-" });
      const threadId = ThreadId.make("cursor-squire-contract");
      const runtimePolicy = policyFor("home", workspace);
      const { adapter, sent } = yield* makeHarness({
        threadId,
        workspace,
        updates: [
          ...(["tool-call-started", "tool-call-completed"] as const).map((type) => ({
            type,
            modelCallId: "native-model-call",
            callId: "squire-note",
            toolCall: {
              type: "mcp" as const,
              args: { providerIdentifier: "lecturn", toolName: "squire_note", args: {} },
              ...(type === "tool-call-completed"
                ? {
                    result: {
                      status: "success" as const,
                      value: { content: [{ text: { text: "noted" } }], isError: false },
                    },
                  }
                : {}),
            },
          })),
          // What the SDK returns when a headless run refuses a tool call.
          {
            type: "tool-call-completed",
            modelCallId: "native-model-call",
            callId: "refused-shell",
            toolCall: {
              type: "shell",
              args: { command: "cat /etc/hosts" },
              result: {
                status: "error",
                error: "Local SDK runs cannot request interactive approval for this shell command.",
              },
            },
          },
        ],
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-squire-contract-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        yield* turnInput({
          threadId,
          providerThread,
          runtimePolicy,
          squireInstructions: [SQUIRE_SKILL],
          text: "An event arrived.",
        }),
      );
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );

      const message = sent[0]?.message;
      const text = typeof message === "string" ? message : (message?.text ?? "");
      assert.include(text, "SQUIRE-SKILL-SENTINEL");
      assert.notInclude(text, LECTURN_ORCHESTRATION_INSTRUCTIONS);
      assert.isFalse(events.some((event) => event.type === "runtime_request.updated"));
      const items = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.status !== "running"
          ? [event.turnItem]
          : [],
      );
      const squireTool = items.find(
        (item) => item.type === "dynamic_tool" && item.toolName === "mcp__lecturn__squire_note",
      );
      assert.equal(squireTool?.status, "completed");
      const refused = items.find((item) => item.type === "command_execution");
      assert.equal(refused?.status, "failed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each([
    { session: "home" as const, thread: undefined },
    { session: undefined, thread: "home" as const },
    { session: "home" as const, thread: "probe" as const },
  ])("refuses a $thread thread on a $session session", ({ session, thread }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-squire-" });
      const threadId = ThreadId.make("cursor-squire-mismatch");
      const { adapter, opened } = yield* makeHarness({ threadId, workspace });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-squire-mismatch-session"),
        modelSelection,
        runtimePolicy: policyFor(session, workspace),
      });
      const failure = yield* runtime
        .ensureThread({ threadId, modelSelection, runtimePolicy: policyFor(thread, workspace) })
        .pipe(Effect.flip);
      assert.instanceOf(failure.cause, ProviderAdapter.ProviderAdapterProtocolError);
      assert.deepEqual(opened, []);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
