// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  GithubCopilotSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@lecturn/contracts";
import { resolveSelfInvocation } from "@lecturn/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as ServerConfig from "../../config.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import * as AcpSessionRuntimeModule from "../../provider/acp/AcpSessionRuntime.ts";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "@lecturn/provider-core/server/ProviderAdapter";
import {
  COPILOT_CANCELLED_STREAM_GRACE,
  withCopilotCancelledStreamDiscard,
} from "../../provider/acp/CopilotAcpSupport.ts";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../builtInProviderAdapterDrivers.ts";
import {
  COPILOT_PROVIDER,
  CopilotProviderCapabilitiesV2,
  makeCopilotAcpAdapterFlavor,
  makeCopilotAdapterV2,
  type CopilotAdapterV2Options,
} from "./CopilotAdapterV2.ts";

const MODE_URL = "https://agentclientprotocol.com/protocol/session-modes";
const COPILOT_HOME = "/synthetic/copilot-home";
const DEFAULT_SETTINGS = Schema.decodeSync(GithubCopilotSettings)({});

const unused = <A>(): A => undefined as unknown as A;

const flavorOptions = (
  overrides: Partial<CopilotAdapterV2Options> = {},
): CopilotAdapterV2Options => ({
  instanceId: ProviderInstanceId.make("githubCopilot"),
  settings: DEFAULT_SETTINGS,
  environment: { COPILOT_HOME },
  childProcessSpawner: unused(),
  crypto: unused(),
  selfInvocation: unused(),
  fileSystem: unused(),
  path: NodePath as unknown as Path.Path,
  idAllocator: unused(),
  serverConfig: unused(),
  ...overrides,
});

/** A runtime that records the session configuration writes Copilot receives. */
function configurationRuntime(input: { readonly allowAll: string; readonly mode: string }) {
  const writes: Array<string> = [];
  let allowAll = input.allowAll;
  let mode = input.mode;
  const configOptions = () =>
    [
      {
        type: "select",
        id: "mode",
        name: "Mode",
        category: "mode",
        currentValue: mode,
        options: ["agent", "plan", "autopilot"].map((fragment) => ({
          value: `${MODE_URL}#${fragment}`,
          name: fragment,
        })),
      },
      {
        type: "select",
        id: "allow_all",
        name: "Allow all",
        category: "permissions",
        currentValue: allowAll,
        options: [
          { value: "on", name: "On" },
          { value: "off", name: "Off" },
        ],
      },
    ] as unknown as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  const runtime = {
    getConfigOptions: Effect.sync(configOptions),
    getModeState: Effect.sync(() => ({
      currentModeId: mode,
      availableModes: ["agent", "plan", "autopilot"].map((fragment) => ({
        id: `${MODE_URL}#${fragment}`,
        name: fragment,
      })),
    })),
    setMode: (modeId: string) =>
      Effect.sync(() => {
        writes.push(`mode=${modeId.slice(modeId.lastIndexOf("#"))}`);
        mode = modeId;
        return {};
      }),
    setConfigOption: (configId: string, value: string | boolean) =>
      Effect.sync(() => {
        writes.push(`${configId}=${String(value)}`);
        if (configId === "allow_all") allowAll = String(value);
        return { configOptions: configOptions() };
      }),
    setSessionModel: (modelId: string) =>
      Effect.sync(() => {
        writes.push(`model=${modelId}`);
        return {};
      }),
  };
  return {
    writes,
    runtime: runtime as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"],
  };
}

const policy = (runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode) =>
  ({ runtimeMode, interactionMode, cwd: "/synthetic/project" }) as const;

describe("CopilotAdapterV2 flavor", () => {
  const flavor = makeCopilotAcpAdapterFlavor(flavorOptions());

  it("is registered as a built-in orchestration adapter", () => {
    assert.isTrue(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(COPILOT_PROVIDER));
    assert.strictEqual(flavor.driver, COPILOT_PROVIDER);
    // Copilot has no ACP session fork: forks use portable handoffs.
    assert.isFalse(CopilotProviderCapabilitiesV2.threads.canForkThread);
  });

  it.effect("switches to #plan for plan turns and back to #agent, never #autopilot", () =>
    Effect.gen(function* () {
      const { runtime, writes } = configurationRuntime({
        allowAll: "off",
        mode: `${MODE_URL}#agent`,
      });
      yield* flavor.configureSessionForPolicy!({
        runtime,
        runtimePolicy: policy("approval-required", "plan"),
      });
      yield* flavor.configureSessionForPolicy!({
        runtime,
        runtimePolicy: policy("approval-required", "default"),
      });
      assert.deepStrictEqual(writes, [
        "allow_all=off",
        "mode=#plan",
        "allow_all=off",
        "mode=#agent",
      ]);
      assert.notInclude(writes.join(","), "#autopilot");
    }),
  );

  it.effect("turns allow_all on only for full access", () =>
    Effect.gen(function* () {
      const { runtime, writes } = configurationRuntime({
        allowAll: "on",
        mode: `${MODE_URL}#agent`,
      });
      yield* flavor.configureSessionForPolicy!({
        runtime,
        runtimePolicy: policy("full-access", "default"),
      });
      yield* flavor.configureSessionForPolicy!({
        runtime,
        runtimePolicy: policy("auto-accept-edits", "default"),
      });
      assert.deepStrictEqual(
        writes.filter((write) => write.startsWith("allow_all")),
        ["allow_all=on", "allow_all=off"],
      );
    }),
  );

  it.effect("sends the selected model, auto included, with session/set_model", () =>
    Effect.gen(function* () {
      const { runtime, writes } = configurationRuntime({
        allowAll: "off",
        mode: `${MODE_URL}#agent`,
      });
      const applied = yield* flavor.applyModelSelection!({
        runtime,
        startResult: {
          initializeResult: { protocolVersion: 1 },
        } as unknown as AcpSessionRuntime.AcpSessionRuntimeStartResult,
        modelSelection: { instanceId: ProviderInstanceId.make("githubCopilot"), model: "auto" },
      });
      assert.strictEqual(applied, "auto");
      assert.deepStrictEqual(writes, ["model=auto"]);
    }),
  );

  it("renders a plan.md write as a plan step and surfaces it as the proposed plan", () => {
    const planPath = `${COPILOT_HOME}/session-state/session-1/plan.md`;
    const write = {
      toolCallId: "plan-patch-1",
      kind: "edit",
      title: "apply_patch",
      status: "pending" as const,
      data: {
        rawInput: `*** Begin Patch\n*** Add File: ${planPath}\n+# Plan\n+1. Do it\n*** End Patch`,
      },
    };
    const normalized = flavor.normalizeToolCall!(write);
    assert.strictEqual(normalized.kind, "think");
    assert.strictEqual(normalized.title, "Update plan");
    assert.strictEqual(flavor.extractProposedPlanMarkdown!(normalized), "# Plan\n1. Do it");

    const projectEdit = {
      ...write,
      data: {
        rawInput: `*** Begin Patch\n*** Add File: /synthetic/project/a.ts\n+x\n*** End Patch`,
      },
    };
    assert.strictEqual(flavor.normalizeToolCall!(projectEdit).kind, "edit");
    assert.isUndefined(flavor.extractProposedPlanMarkdown!(projectEdit));
  });

  it("reads an updated plan.md back once the write completes", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lecturn-copilot-plan-"));
    try {
      const planPath = NodePath.join(home, "session-state", "session-2", "plan.md");
      NodeFS.mkdirSync(NodePath.dirname(planPath), { recursive: true });
      NodeFS.writeFileSync(planPath, "# Revised plan\n", "utf8");
      const homeFlavor = makeCopilotAcpAdapterFlavor(
        flavorOptions({ environment: { COPILOT_HOME: home } }),
      );
      const update = {
        toolCallId: "plan-patch-2",
        kind: "edit",
        status: "completed" as const,
        data: {
          rawInput: `*** Begin Patch\n*** Update File: ${planPath}\n-old\n+new\n*** End Patch`,
        },
      };
      const normalized = homeFlavor.normalizeToolCall!(update);
      assert.strictEqual(homeFlavor.extractProposedPlanMarkdown!(normalized), "# Revised plan");
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});

/** A runtime whose prompt and session updates the test drives by hand. */
function streamingRuntime() {
  let deliver: ((notification: EffectAcpSchema.SessionNotification) => Effect.Effect<void>) | null =
    null;
  const responses: Array<Deferred.Deferred<EffectAcpSchema.PromptResponse>> = [];
  const runtime = {
    handleSessionUpdate: (
      handler: (n: EffectAcpSchema.SessionNotification) => Effect.Effect<void>,
    ) =>
      Effect.sync(() => {
        deliver = handler;
      }),
    prompt: () =>
      Effect.gen(function* () {
        const response = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
        responses.push(response);
        return yield* Deferred.await(response);
      }),
  } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
  const send = (update: Record<string, unknown>) =>
    deliver!({ sessionId: "s", update } as unknown as EffectAcpSchema.SessionNotification);
  const chunk = (text: string) =>
    send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  return { runtime, send, chunk, responses };
}

describe("withCopilotCancelledStreamDiscard", () => {
  it.effect("drops the reply Copilot keeps streaming after a cancel", () =>
    Effect.gen(function* () {
      const source = streamingRuntime();
      const runtime = yield* withCopilotCancelledStreamDiscard(source.runtime);
      const seen: Array<string> = [];
      yield* runtime.handleSessionUpdate((notification) =>
        Effect.sync(() => {
          const update = notification.update as {
            sessionUpdate: string;
            content?: { text?: string };
          };
          seen.push(update.content?.text ?? update.sessionUpdate);
        }),
      );

      const first = yield* runtime.prompt({ prompt: [] }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* source.chunk("1");
      yield* Deferred.succeed(source.responses[0]!, { stopReason: "cancelled" });
      yield* Fiber.await(first);
      // The cancelled reply's tail, before and after the next prompt starts.
      yield* source.chunk("2");
      yield* source.chunk("3");
      const second = yield* runtime.prompt({ prompt: [] }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* source.chunk("4");
      yield* source.send({ sessionUpdate: "usage_update", used: 10_000, size: 128_000 });
      yield* source.chunk("next");
      yield* Deferred.succeed(source.responses[1]!, { stopReason: "end_turn" });
      yield* Fiber.await(second);

      assert.deepStrictEqual(seen, ["1", "usage_update", "next"]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops discarding a short grace after the next prompt without usage_update", () =>
    Effect.gen(function* () {
      const source = streamingRuntime();
      const runtime = yield* withCopilotCancelledStreamDiscard(source.runtime);
      const seen: Array<string> = [];
      yield* runtime.handleSessionUpdate((notification) =>
        Effect.sync(() => {
          seen.push((notification.update as { content?: { text?: string } }).content?.text ?? "");
        }),
      );
      const first = yield* runtime.prompt({ prompt: [] }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(source.responses[0]!, { stopReason: "cancelled" });
      yield* Fiber.await(first);
      yield* runtime.prompt({ prompt: [] }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* source.chunk("tail");
      yield* TestClock.adjust(COPILOT_CANCELLED_STREAM_GRACE);
      yield* source.chunk("reply");
      assert.deepStrictEqual(seen, ["reply"]);
    }).pipe(Effect.scoped),
  );
});

const integrationLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-copilot-v2-adapter-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

/** Runs one plan turn against the mock agent's Copilot profile. */
const runCopilotPlanTurn = (input: { readonly planMarkdown: string | null }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const copilotHome = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "lecturn-copilot-v2-home-",
    });
    const requestLog = path.join(copilotHome, "requests.ndjson");
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const instanceId = ProviderInstanceId.make("githubCopilot");
    const threadId = ThreadId.make(`thread-copilot-plan-${input.planMarkdown === null}`);
    const adapter = makeCopilotAdapterV2({
      instanceId,
      settings: DEFAULT_SETTINGS,
      environment: { COPILOT_HOME: copilotHome },
      childProcessSpawner,
      crypto: yield* Crypto.Crypto,
      selfInvocation: yield* resolveSelfInvocation(),
      fileSystem,
      path,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
      makeRuntime: ({ runtimePolicy: _policy, processEnvironment: _env, ...runtimeInput }) =>
        Effect.gen(function* () {
          const context = yield* Layer.build(
            AcpSessionRuntimeModule.layer({
              ...runtimeInput,
              cancelBehavior: "wait-for-prompt",
              authMethodId: "copilot-login",
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: runtimeInput.cwd,
                env: {
                  LECTURN_ACP_COPILOT: "1",
                  LECTURN_ACP_REQUEST_LOG_PATH: requestLog,
                  COPILOT_HOME: copilotHome,
                  ...(input.planMarkdown === null
                    ? {}
                    : { LECTURN_ACP_COPILOT_PLAN_MARKDOWN: input.planMarkdown }),
                },
              },
            }).pipe(
              Layer.provide(
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
              ),
            ),
          );
          const runtime = yield* Effect.service(AcpSessionRuntimeModule.AcpSessionRuntime).pipe(
            Effect.provide(context),
          );
          return yield* withCopilotCancelledStreamDiscard(runtime);
        }),
    });
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "approval-required",
      interactionMode: "plan",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "auto" } as const;
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(
        `session-copilot-plan-${input.planMarkdown === null}`,
      ),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    yield* session.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make(`project:${threadId}`),
        title: "Copilot plan",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        branch: null,
        worktreePath: null,
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
      runId: RunId.make(`run:${threadId}`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt:${threadId}`),
      rootNodeId: NodeId.make(`node:${threadId}`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message:${threadId}`),
        text: "Plan the change.",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    } as ProviderAdapterV2TurnInput);
    const events = yield* session.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    const requests = (yield* fileSystem.readFileString(requestLog))
      .split("\n")
      .filter((line) => line.length > 0);
    return { events: [...events], requests };
  });

describe("CopilotAdapterV2 against the mock Copilot agent", () => {
  it.live(
    "surfaces the plan.md Copilot writes in plan mode as a plan step, not a file change",
    () =>
      Effect.gen(function* () {
        const { events, requests } = yield* runCopilotPlanTurn({
          planMarkdown: "# Plan\n1. Do it",
        });
        const plans = events.flatMap((event) =>
          event.type === "plan.updated" && event.plan.kind === "proposed_plan" ? [event.plan] : [],
        );
        assert.strictEqual(plans.at(-1)?.markdown, "# Plan\n1. Do it");
        const items = events.flatMap((event) =>
          event.type === "turn_item.updated" ? [event.turnItem] : [],
        );
        assert.isFalse(items.some((item) => item.type === "file_change"));
        assert.isTrue(
          requests.some((line) => line.includes("set_config_option") && line.includes("#plan")),
        );
        assert.isFalse(requests.some((line) => line.includes("#autopilot")));
      }).pipe(Effect.provide(integrationLayer), Effect.scoped),
  );

  it.live("proposes the final assistant message when no plan.md was written", () =>
    Effect.gen(function* () {
      const { events } = yield* runCopilotPlanTurn({ planMarkdown: null });
      const plans = events.flatMap((event) =>
        event.type === "plan.updated" && event.plan.kind === "proposed_plan" ? [event.plan] : [],
      );
      assert.strictEqual(plans.at(-1)?.markdown, "Plan: answer inline.");
    }).pipe(Effect.provide(integrationLayer), Effect.scoped),
  );
});
