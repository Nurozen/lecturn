// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  GithubCopilotSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@lecturn/contracts";

import { ServerConfig } from "../../config.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";

const decodeSettings = Schema.decodeSync(GithubCopilotSettings);

/** Single-quotes a value for the generated `/bin/sh` wrapper. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const PROVIDER = ProviderDriverKind.make("githubCopilot");
const INSTANCE = ProviderInstanceId.make("githubCopilot");
const MODE_URL = "https://agentclientprotocol.com/protocol/session-modes";

interface LoggedMessage {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: { readonly outcome?: { readonly optionId?: string } };
}

/** A fake `copilot` that runs the mock ACP agent in its Copilot profile and logs requests. */
const makeMockCopilot = (extraEnv: Record<string, string> = {}) =>
  Effect.promise(async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-acp-mock-"));
    const requestLogPath = NodePath.join(dir, "requests.ndjson");
    const binaryPath = NodePath.join(dir, "copilot");
    const env = {
      LECTURN_ACP_COPILOT: "1",
      LECTURN_ACP_REQUEST_LOG_PATH: requestLogPath,
      ...extraEnv,
    };
    const exports = Object.entries(env)
      .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
      .join("\n");
    await NodeFSP.writeFile(
      binaryPath,
      `#!/bin/sh\n${exports}\nexec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)} "$@"\n`,
    );
    await NodeFSP.chmod(binaryPath, 0o755);
    const readRequests = Effect.promise(async () =>
      (await NodeFSP.readFile(requestLogPath, "utf8"))
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => decodeJsonLine(line) as LoggedMessage),
    );
    return { binaryPath, readRequests };
  });

const configWrites = (requests: ReadonlyArray<LoggedMessage>, configId: string) =>
  requests
    .filter(
      (entry) =>
        entry.method === "session/set_config_option" && entry.params?.configId === configId,
    )
    .map((entry) => entry.params?.value);

const permissionOptionIds = (requests: ReadonlyArray<LoggedMessage>) =>
  requests.flatMap((entry) =>
    entry.method === undefined && entry.result?.outcome?.optionId
      ? [entry.result.outcome.optionId]
      : [],
  );

const makeAdapter = (binaryPath: string, environment?: NodeJS.ProcessEnv) =>
  makeCopilotAdapter(
    decodeSettings({ enabled: true, binaryPath }),
    environment ? { environment } : undefined,
  ).pipe(Effect.orDie);

/** Runs one plan-mode turn against a temp COPILOT_HOME and returns the adapter's events. */
const runPlanTurn = (threadId: ThreadId, extraEnv: Record<string, string>) =>
  Effect.gen(function* () {
    const copilotHome = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-home-")),
    );
    const mock = yield* makeMockCopilot(extraEnv);
    const adapter = yield* makeAdapter(mock.binaryPath, {
      ...process.env,
      COPILOT_HOME: copilotHome,
    });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => events.push(event)),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession({
      threadId,
      provider: PROVIDER,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({ threadId, input: "plan it", interactionMode: "plan" });
    yield* adapter.stopSession(threadId);
    yield* Fiber.interrupt(fiber);
    return events;
  });

const proposedPlans = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) =>
    event.type === "turn.proposed.completed" ? [event.payload.planMarkdown] : [],
  );

const layer = it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-copilot-adapter-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("CopilotAdapter", (it) => {
  it.effect("switches to #plan for plan turns and back to #agent, never #autopilot", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockCopilot();
      const adapter = yield* makeAdapter(mock.binaryPath);
      const threadId = ThreadId.make("copilot-plan-mode");

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "plan it", interactionMode: "plan" });
      yield* adapter.sendTurn({ threadId, input: "build it", interactionMode: "default" });

      const modes = configWrites(yield* mock.readRequests, "mode");
      assert.deepStrictEqual(modes, [`${MODE_URL}#plan`, `${MODE_URL}#agent`]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces the plan.md Copilot writes in plan mode and hides the write", () =>
    Effect.gen(function* () {
      const events = yield* runPlanTurn(ThreadId.make("copilot-plan-file"), {
        LECTURN_ACP_COPILOT_PLAN_MARKDOWN: "# Plan\n\n1. Do the thing",
      });

      assert.deepStrictEqual(proposedPlans(events), ["# Plan\n\n1. Do the thing"]);
      assert.isFalse(
        events.some((event) => String(event.itemId ?? "").startsWith("plan-patch")),
        "the plan.md write is not a project file change",
      );
      const types = events.map((event) => event.type);
      assert.isBelow(types.indexOf("turn.proposed.completed"), types.indexOf("turn.completed"));
    }),
  );

  it.effect("falls back to the final assistant message when no plan.md was written", () =>
    Effect.gen(function* () {
      const events = yield* runPlanTurn(ThreadId.make("copilot-plan-text"), {});
      assert.deepStrictEqual(proposedPlans(events), ["Plan: answer inline."]);
    }),
  );

  it.effect("full access turns allow_all on and auto-approves permission requests", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockCopilot({ LECTURN_ACP_EMIT_TOOL_CALLS: "1" });
      const adapter = yield* makeAdapter(mock.binaryPath);
      const threadId = ThreadId.make("copilot-full-access");
      const events: ProviderRuntimeEvent[] = [];
      const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "run the tool" });

      const requests = yield* mock.readRequests;
      assert.deepStrictEqual(configWrites(requests, "allow_all"), ["on"]);
      assert.deepStrictEqual(permissionOptionIds(requests), ["allow_always"]);
      assert.isFalse(events.some((event) => event.type === "request.opened"));
      yield* Fiber.interrupt(fiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("supervised mode surfaces the approval and answers with the chosen option", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockCopilot({ LECTURN_ACP_EMIT_TOOL_CALLS: "1" });
      const adapter = yield* makeAdapter(mock.binaryPath);
      const threadId = ThreadId.make("copilot-supervised");
      const opened: ProviderRuntimeEvent[] = [];
      const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Effect.sync(() => opened.push(event)).pipe(
              Effect.andThen(
                adapter.respondToRequest(
                  threadId,
                  ApprovalRequestId.make(String(event.requestId)),
                  "accept",
                ),
              ),
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "run the tool" });

      const requests = yield* mock.readRequests;
      assert.lengthOf(opened, 1);
      assert.deepStrictEqual(permissionOptionIds(requests), ["allow_once"]);
      assert.deepStrictEqual(configWrites(requests, "allow_all"), []);
      yield* Fiber.interrupt(fiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes with session/load and keeps the resume cursor", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockCopilot();
      const adapter = yield* makeAdapter(mock.binaryPath);
      const threadId = ThreadId.make("copilot-resume");

      const session = yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "copilot-session-42" },
      });

      const requests = yield* mock.readRequests;
      const load = requests.find((entry) => entry.method === "session/load");
      assert.strictEqual(load?.params?.sessionId, "copilot-session-42");
      assert.isFalse(requests.some((entry) => entry.method === "session/new"));
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "copilot-session-42",
      });
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("sends auto and concrete models, skipping only an unchanged one", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockCopilot();
      const adapter = yield* makeAdapter(mock.binaryPath);
      const threadId = ThreadId.make("copilot-model");

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: INSTANCE, model: "auto" },
      });
      yield* adapter.sendTurn({ threadId, input: "first" });
      yield* adapter.sendTurn({
        threadId,
        input: "second",
        modelSelection: { instanceId: INSTANCE, model: "gpt-5-mini" },
      });
      yield* adapter.sendTurn({ threadId, input: "third" });
      yield* adapter.sendTurn({
        threadId,
        input: "fourth",
        modelSelection: { instanceId: INSTANCE, model: "auto" },
      });

      const setModels = (yield* mock.readRequests).filter(
        (entry) => entry.method === "session/set_model",
      );
      assert.deepStrictEqual(
        setModels.map((entry) => entry.params?.modelId),
        ["auto", "gpt-5-mini", "auto"],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("drops the reply Copilot keeps streaming after a cancel", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockCopilot({ LECTURN_ACP_COPILOT_STREAM_AFTER_CANCEL: "1" });
      const adapter = yield* makeAdapter(mock.binaryPath);
      const threadId = ThreadId.make("copilot-stream-after-cancel");
      const events: ProviderRuntimeEvent[] = [];
      const firstDelta = yield* Deferred.make<void>();
      const turnsCompleted = yield* Deferred.make<void>();
      const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "content.delta") yield* Deferred.succeed(firstDelta, undefined);
          if (events.filter((entry) => entry.type === "turn.completed").length === 2) {
            yield* Deferred.succeed(turnsCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const cancelledTurn = yield* adapter
        .sendTurn({ threadId, input: "count to 300" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstDelta);
      yield* adapter.interruptTurn(threadId);
      const cancelled = yield* Fiber.join(cancelledTurn);
      const followUp = yield* adapter.sendTurn({ threadId, input: "Reply with just: ok" });
      yield* Deferred.await(turnsCompleted);

      const assistantText = (turnId: string) =>
        events
          .flatMap((event) =>
            event.type === "content.delta" &&
            event.turnId === turnId &&
            event.payload.streamKind === "assistant_text"
              ? [event.payload.delta]
              : [],
          )
          .join("");
      const cancelledCompletedAt = events.findIndex(
        (event) => event.type === "turn.completed" && event.turnId === cancelled.turnId,
      );
      const cancelledCompletion = events[cancelledCompletedAt];
      assert.isTrue(
        cancelledCompletion?.type === "turn.completed" &&
          cancelledCompletion.payload.state === "cancelled",
      );
      assert.isFalse(
        events.slice(cancelledCompletedAt + 1).some((event) => event.turnId === cancelled.turnId),
        "nothing lands on the cancelled turn after it completed",
      );
      assert.strictEqual(assistantText(followUp.turnId), "hello from mock");
      yield* Fiber.interrupt(fiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails a signed-out start with the copilot login instruction", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockCopilot({ LECTURN_ACP_COPILOT_LOGGED_OUT: "1" });
      const adapter = yield* makeAdapter(mock.binaryPath);

      const error = yield* adapter
        .startSession({
          threadId: ThreadId.make("copilot-signed-out"),
          provider: PROVIDER,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "ProviderAdapterRequestError");
      assert.include(error.message, "Run `copilot login`");
    }),
  );
});
