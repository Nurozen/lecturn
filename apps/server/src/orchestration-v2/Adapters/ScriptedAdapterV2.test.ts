// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@lecturn/contracts";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@lecturn/provider-testing/replayWorkspace";
import * as TestProviderHost from "@lecturn/provider-testing/TestProviderHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import { makeScriptedAdapterV2, waitForFile } from "./ScriptedAdapterV2.ts";
import { scriptFromFile, scriptFromMessage, substitute } from "./scriptedScript.ts";

const instanceId = ProviderInstanceId.make("scripted");
const modelSelection = { instanceId, model: "scripted" };
const threadId = ThreadId.make("thread:scripted");

interface ToolResult {
  readonly content: ReadonlyArray<unknown>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

interface RecordedCall {
  readonly name: string;
  readonly arguments: unknown;
  readonly sessionId: string | null;
  readonly authorization: string | null;
}

/** An in-memory Streamable HTTP MCP endpoint, answering tools/call from `tools`. */
function makeFakeMcp(tools: Record<string, (args: Record<string, unknown>) => ToolResult>) {
  const calls: Array<RecordedCall> = [];
  const methods: Array<string> = [];
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", ...headers },
    });
  const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (init?.method === "DELETE") {
      methods.push("DELETE");
      return new Response(null, { status: 200 });
    }
    const message = JSON.parse(String(init?.body)) as {
      readonly id?: number;
      readonly method: string;
      readonly params?: { readonly name?: string; readonly arguments?: Record<string, unknown> };
    };
    methods.push(message.method);
    if (message.method === "initialize") {
      return json(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: {} },
        },
        { "mcp-session-id": "fake-session" },
      );
    }
    if (message.id === undefined) return new Response(null, { status: 202 });
    const name = message.params?.name ?? "";
    const args = message.params?.arguments ?? {};
    calls.push({
      name,
      arguments: args,
      sessionId: headers.get("mcp-session-id"),
      authorization: headers.get("authorization"),
    });
    const tool = tools[name];
    const reply =
      tool === undefined
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown ${name}` } }
        : { jsonrpc: "2.0", id: message.id, result: tool(args) };
    // Lecturn's endpoint may answer with either framing.
    return calls.length % 2 === 0
      ? new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      : json(reply);
  };
  return { fetch, calls, methods };
}

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });

function layerScripted(input: {
  readonly fake: ReturnType<typeof makeFakeMcp>;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const registry = ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set({
        environmentId: EnvironmentId.make("environment:scripted"),
        threadId,
        providerSessionId: "mcp-session:scripted",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:9/mcp",
        authorizationHeader: "Bearer scripted-test",
        browserToolsAvailable: false,
      });
      return [
        yield* makeScriptedAdapterV2({
          instanceId,
          environment: input.environment ?? {},
          fetchImplementation: input.fake.fetch,
        }),
      ];
      // The harness runs without MCP wiring and clears the shared slot, so the
      // adapter reads this thread's MCP configuration from its own store.
    }).pipe(Effect.provide(Layer.fresh(McpProviderSessions.layer))),
  ).pipe(
    Layer.provide(Layer.mergeAll(IdAllocator.layer, TestProviderHost.layer())),
    Layer.provide(NodeServices.layer),
  );
  return ProviderReplayHarness.layerWithRegistry({ name: "scripted-adapter" }, registry, {
    runEffectWorker: false,
  });
}

const isTerminal = (stored: OrchestrationV2StoredEvent) =>
  stored.event.type === "provider-turn.updated" &&
  ["completed", "interrupted", "failed", "cancelled"].includes(stored.event.payload.status);

/** The first persisted event matching `predicate`; the stream replays from genesis, so no race. */
const persisted = (predicate: (stored: OrchestrationV2StoredEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const found = yield* orchestrator.streamStoredEvents.pipe(
      Stream.filter(predicate),
      Stream.runHead,
    );
    return Option.getOrThrow(found).event;
  });

const persistedAssistantText = (value: string) =>
  persisted(
    (stored) =>
      stored.event.type === "message.updated" &&
      stored.event.payload.role === "assistant" &&
      stored.event.payload.text === value,
  );

const startTurn = (message: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const cwd = yield* checkpointWorkspace("scripted-adapter");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:scripted"),
      title: "Scripted",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send"),
      threadId,
      messageId: MessageId.make("message:scripted"),
      text: message,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
  });

const fenced = (steps: ReadonlyArray<unknown>) =>
  `Run this.\n\n\`\`\`scripted\n${JSON.stringify(steps, null, 2)}\n\`\`\`\n`;

const projection = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.getThreadProjection(threadId);
});

const interruptActiveRun = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const run = (yield* projection).runs.at(-1)!;
  yield* orchestrator.dispatch({
    type: "run.interrupt",
    commandId: CommandId.make("interrupt"),
    threadId,
    runId: run.id,
  });
  yield* worker.drain();
});

const toolRows = Effect.gen(function* () {
  return (yield* projection).turnItems.flatMap((item) =>
    item.type === "dynamic_tool"
      ? [{ toolName: item.toolName, status: item.status, input: item.input }]
      : [],
  );
});

const assistantTexts = Effect.gen(function* () {
  return (yield* projection).messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text);
});

/** The failure message of the turn's error row, once it is persisted (it follows the terminal). */
const persistedFailureMessage = Effect.gen(function* () {
  const event = yield* persisted(
    (stored) => stored.event.type === "turn-item.updated" && stored.event.payload.type === "error",
  );
  return event.type === "turn-item.updated" && event.payload.type === "error"
    ? event.payload.failure.message
    : "";
});

describe("ScriptedAdapterV2", () => {
  it.live("runs a fenced script with real MCP calls, saved results and a poll", () => {
    let statusCalls = 0;
    const fake = makeFakeMcp({
      ex_simulate: (args) => ({
        content: [{ type: "text", text: "queued" }],
        structuredContent: { job_id: "job-7", samples: args.samples },
      }),
      ex_job_status: () =>
        text(JSON.stringify({ state: ++statusCalls < 3 ? "running" : "complete" })),
      ex_report: () => text("ok"),
    });
    return Effect.gen(function* () {
      yield* startTurn(
        fenced([
          { toolCall: { name: "ex_simulate", arguments: { samples: 500 } }, saveAs: "sim" },
          {
            poll: {
              toolCall: { name: "ex_job_status", arguments: { job_id: "${sim.job_id}" } },
              until: { path: "state", equals: "complete" },
              intervalMs: 0,
            },
            saveAs: "status",
          },
          {
            toolCall: {
              name: "ex_report",
              arguments: { samples: "${sim.samples}", summary: "${sim.job_id} is ${status.state}" },
            },
          },
          { assistantText: "Simulation finished." },
        ]),
      );
      const terminal = yield* persisted(isTerminal);
      assert.equal(
        terminal.type === "provider-turn.updated" && terminal.payload.status,
        "completed",
      );

      assert.deepEqual(
        fake.calls.map((call) => [call.name, call.arguments]),
        [
          ["ex_simulate", { samples: 500 }],
          ["ex_job_status", { job_id: "job-7" }],
          ["ex_job_status", { job_id: "job-7" }],
          ["ex_job_status", { job_id: "job-7" }],
          ["ex_report", { samples: 500, summary: "job-7 is complete" }],
        ],
      );
      assert.isTrue(
        fake.calls.every(
          (call) =>
            call.sessionId === "fake-session" && call.authorization === "Bearer scripted-test",
        ),
      );
      assert.deepEqual(fake.methods.slice(0, 2), ["initialize", "notifications/initialized"]);
      assert.equal(fake.methods.at(-1), "DELETE");
      assert.deepEqual(
        (yield* toolRows).map((row) => [row.toolName, row.status]),
        [
          ["lecturn.ex_simulate", "completed"],
          ["lecturn.ex_job_status", "completed"],
          ["lecturn.ex_job_status", "completed"],
          ["lecturn.ex_job_status", "completed"],
          ["lecturn.ex_report", "completed"],
        ],
      );
      assert.deepEqual(yield* assistantTexts, ["Simulation finished."]);
    }).pipe(Effect.scoped, Effect.provide(layerScripted({ fake })));
  });

  it.live("falls back to the scripts file keyed by turn index", () => {
    const fake = makeFakeMcp({});
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scripted-" });
      const file = `${directory}/scripts.json`;
      yield* fileSystem.writeFileString(
        file,
        JSON.stringify({ "1": [{ assistantText: "From the scripts file." }] }),
      );
      yield* Effect.gen(function* () {
        yield* startTurn("No fenced block here.");
        const terminal = yield* persisted(isTerminal);
        assert.equal(
          terminal.type === "provider-turn.updated" && terminal.payload.status,
          "completed",
        );
        assert.deepEqual(yield* assistantTexts, ["From the scripts file."]);
        // A turn with no tool calls never opens an MCP session.
        assert.deepEqual(fake.methods, []);
      }).pipe(
        Effect.provide(
          layerScripted({ fake, environment: { LECTURN_SCRIPTED_PROVIDER_SCRIPTS: file } }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  });

  it.live("fails the turn when an expected approval is refused", () => {
    const fake = makeFakeMcp({
      ex_counter_increment: () => text(JSON.stringify({ count: 1 })),
      ex_window_flash: () => ({ ...text("approval declined"), isError: true }),
    });
    return Effect.gen(function* () {
      yield* startTurn(
        fenced([
          { expectApproval: true },
          { toolCall: { name: "ex_counter_increment" } },
          { expectApproval: true },
          { toolCall: { name: "ex_window_flash" } },
          { assistantText: "Never reached." },
        ]),
      );
      const terminal = yield* persisted(isTerminal);
      assert.equal(terminal.type === "provider-turn.updated" && terminal.payload.status, "failed");
      assert.deepEqual(
        (yield* toolRows).map((row) => [row.toolName, row.status]),
        [
          ["lecturn.ex_counter_increment", "completed"],
          ["lecturn.ex_window_flash", "failed"],
        ],
      );
      const message = yield* persistedFailureMessage;
      assert.include(message, "expected ex_window_flash to be approved, got: approval declined");
      assert.deepEqual(yield* assistantTexts, []);
    }).pipe(Effect.scoped, Effect.provide(layerScripted({ fake })));
  });

  it.live("records a refused call without expectApproval and keeps going", () => {
    const fake = makeFakeMcp({
      ex_window_flash: () => ({ ...text("Embed Host is closed"), isError: true }),
    });
    return Effect.gen(function* () {
      yield* startTurn(
        fenced([
          { toolCall: { name: "ex_window_flash" } },
          { assistantText: "The host is closed." },
        ]),
      );
      const terminal = yield* persisted(isTerminal);
      assert.equal(
        terminal.type === "provider-turn.updated" && terminal.payload.status,
        "completed",
      );
      assert.deepEqual(
        (yield* toolRows).map((row) => row.status),
        ["failed"],
      );
      assert.deepEqual(yield* assistantTexts, ["The host is closed."]);
    }).pipe(Effect.scoped, Effect.provide(layerScripted({ fake })));
  });

  it.live("fails a poll that never reaches its value", () => {
    const fake = makeFakeMcp({ ex_job_status: () => text(JSON.stringify({ state: "running" })) });
    return Effect.gen(function* () {
      yield* startTurn(
        fenced([
          {
            poll: {
              toolCall: { name: "ex_job_status" },
              until: { path: "state", equals: "complete" },
              maxTries: 2,
              intervalMs: 0,
            },
          },
        ]),
      );
      const terminal = yield* persisted(isTerminal);
      assert.equal(terminal.type === "provider-turn.updated" && terminal.payload.status, "failed");
      assert.equal(fake.calls.length, 2);
      const message = yield* persistedFailureMessage;
      assert.include(message, 'poll ex_job_status: state did not equal "complete" after 2 tries');
    }).pipe(Effect.scoped, Effect.provide(layerScripted({ fake })));
  });

  it.live("keeps a hold: true turn running until it is interrupted", () => {
    const fake = makeFakeMcp({});
    return Effect.gen(function* () {
      yield* startTurn(
        fenced([{ assistantText: "Working." }, { hold: true }, { assistantText: "Never." }]),
      );
      yield* persistedAssistantText("Working.");
      assert.equal((yield* projection).providerTurns.at(-1)?.status, "running");
      yield* interruptActiveRun;
      const terminal = yield* persisted(isTerminal);
      assert.equal(
        terminal.type === "provider-turn.updated" && terminal.payload.status,
        "interrupted",
      );
      assert.deepEqual(yield* assistantTexts, ["Working."]);
    }).pipe(Effect.scoped, Effect.provide(layerScripted({ fake })));
  });

  it.live("releases a hold: { until } turn when the file appears and completes it normally", () => {
    const fake = makeFakeMcp({});
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scripted-hold-" });
      const release = `${directory}/release`;
      yield* Effect.gen(function* () {
        yield* startTurn(
          fenced([
            { assistantText: "Holding." },
            { hold: { until: release } },
            { assistantText: "Released." },
          ]),
        );
        yield* persistedAssistantText("Holding.");
        assert.equal((yield* projection).providerTurns.at(-1)?.status, "running");
        yield* fileSystem.writeFileString(release, "");
        const terminal = yield* persisted(isTerminal);
        assert.equal(
          terminal.type === "provider-turn.updated" && terminal.payload.status,
          "completed",
        );
        assert.deepEqual(yield* assistantTexts, ["Holding.", "Released."]);
      }).pipe(Effect.provide(layerScripted({ fake })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  });
});

describe("waitForFile", () => {
  const layerFiles = (input: {
    readonly exists: Effect.Effect<boolean>;
    readonly watchStarted: Deferred.Deferred<void>;
    readonly watchClosed: Ref.Ref<boolean>;
  }) =>
    Layer.mergeAll(
      FileSystem.layerNoop({
        exists: () => input.exists,
        watch: () =>
          Stream.fromEffect(Deferred.succeed(input.watchStarted, undefined)).pipe(
            Stream.flatMap(() => Stream.never),
            Stream.ensuring(Ref.set(input.watchClosed, true)),
          ),
      }),
      Path.layer,
    );

  it.effect("finds the file through the stat fallback when no watch event arrives", () =>
    Effect.gen(function* () {
      const checks = yield* Ref.make(0);
      const watchStarted = yield* Deferred.make<void>();
      const watchClosed = yield* Ref.make(false);
      const exists = Ref.updateAndGet(checks, (count) => count + 1).pipe(
        Effect.map((count) => count >= 3),
      );
      const wait = yield* waitForFile("/tmp/scripted/release").pipe(
        Effect.provide(layerFiles({ exists, watchStarted, watchClosed })),
        Effect.forkScoped,
      );
      yield* Deferred.await(watchStarted);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(wait);
      assert.isTrue(yield* Ref.get(watchClosed));
    }).pipe(Effect.scoped),
  );

  it.effect("stops watching when the wait is interrupted", () =>
    Effect.gen(function* () {
      const watchStarted = yield* Deferred.make<void>();
      const watchClosed = yield* Ref.make(false);
      const wait = yield* waitForFile("/tmp/scripted/release").pipe(
        Effect.provide(layerFiles({ exists: Effect.succeed(false), watchStarted, watchClosed })),
        Effect.forkScoped,
      );
      yield* Deferred.await(watchStarted);
      yield* Fiber.interrupt(wait);
      assert.isTrue(yield* Ref.get(watchClosed));
    }).pipe(Effect.scoped),
  );
});

describe("scripted script grammar", () => {
  it("reads only a fenced scripted block from the message", () => {
    assert.isUndefined(scriptFromMessage("```json\n[]\n```"));
    assert.deepEqual(scriptFromMessage('Go:\n```scripted\n[{"assistantText":"hi"}]\n```'), [
      { assistantText: "hi" },
    ]);
    assert.throws(
      () => scriptFromMessage('```scripted\n[{"hold":"later"}]\n```'),
      /invalid scripted block/u,
    );
  });

  it("reads the user's own block when handed-off history carries earlier ones", () => {
    const history = 'Context handoff:\nuser: Count.\n```scripted\n[{"assistantText":"old"}]\n```';
    assert.deepEqual(
      scriptFromMessage(
        `${history}\n\nUser message:\nAgain.\n\`\`\`scripted\n[{"assistantText":"new"}]\n\`\`\``,
      ),
      [{ assistantText: "new" }],
    );
  });

  it("picks a scripts-file entry by 1-based turn index in either file form", () => {
    const steps = [{ assistantText: "second" }];
    assert.deepEqual(scriptFromFile(JSON.stringify([[], steps]), 2), steps);
    assert.deepEqual(scriptFromFile(JSON.stringify({ "2": steps }), 2), steps);
    assert.isUndefined(scriptFromFile(JSON.stringify({ "2": steps }), 3));
  });

  it("refuses a placeholder that names no saved result or a missing path", () => {
    const saved = new Map<string, unknown>([["sim", { job_id: "job-7", runs: [{ id: 1 }] }]]);
    assert.deepEqual(substitute({ id: "${sim.runs.0.id}", label: "run ${sim.runs.0}" }, saved), {
      id: 1,
      label: 'run {"id":1}',
    });
    assert.throws(() => substitute("${job.id}", saved), /names no saved result/u);
    assert.throws(() => substitute("${sim.missing}", saved), /path missing is not in/u);
  });
});
