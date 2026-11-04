// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2Notification,
  OrchestrationV2NotificationSource,
  type OrchestrationV2StoredEvent,
  ProjectId,
  SquireId,
  ThreadId,
} from "@lecturn/contracts";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@lecturn/provider-core/server/mcpSession";
import { checkpointWorkspace } from "@lecturn/provider-testing/replayWorkspace";
import * as TestProviderHost from "@lecturn/provider-testing/TestProviderHost";
import * as HostProcess from "@lecturn/shared/HostProcess";
import { htmlRenderFromToolItem } from "@lecturn/shared/toolOutput";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import {
  ASK_USER_QUESTION_ID,
  makeScriptedAdapterV2,
} from "../orchestration-v2/Adapters/ScriptedAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SquireFakeScripts from "./SquireFakeScripts.ts";
import { boundMcpProviderInstanceId, serveBoundMcp } from "./testkit/boundMcp.ts";

const encodeSource = Schema.encodeSync(OrchestrationV2NotificationSource);
const decodeSource = Schema.decodeUnknownSync(OrchestrationV2NotificationSource);
// Bound `/mcp` credentials name this instance, so the fake runs on it too.
const instanceId = boundMcpProviderInstanceId;
const lead = ThreadId.make("thread:squire-lead");
const release = ThreadId.make("thread:squire-release");

interface RecordedCall {
  readonly threadId: string | null;
  readonly name: string;
  readonly arguments: unknown;
}

/** A Streamable HTTP MCP stand-in that records which thread's session made each call. */
function makeFakeMcp() {
  const calls: Array<RecordedCall> = [];
  const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    const authorization = new Headers(init?.headers).get("authorization");
    const message = JSON.parse(String(init?.body)) as {
      readonly id?: number;
      readonly method: string;
      readonly params?: { readonly name?: string; readonly arguments?: unknown };
    };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: {} }
        : (calls.push({
            threadId: authorization?.replace("Bearer ", "") ?? null,
            name: message.params?.name ?? "",
            arguments: message.params?.arguments,
          }),
          { content: [{ type: "text", text: "ok" }] });
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  };
  return { fetch, calls };
}

const fakeMcpConfig = (threadId: ThreadId): McpProviderSessionConfig => ({
  environmentId: EnvironmentId.make("environment:squire-fake"),
  threadId,
  providerSessionId: `mcp-session:${threadId}`,
  providerInstanceId: instanceId,
  endpoint: "http://127.0.0.1:9/mcp",
  authorizationHeader: `Bearer ${threadId}`,
  browserToolsAvailable: false,
});

/** One scripted instance for every thread; `fetch` absent means real HTTP to each config's endpoint. */
function layerFake(input: {
  readonly configs: ReadonlyArray<McpProviderSessionConfig>;
  readonly fetch?: ReturnType<typeof makeFakeMcp>["fetch"];
}) {
  const fakes = SquireFakeScripts.layer;
  const registry = ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      for (const config of input.configs) yield* sessions.set(config);
      // Only the registry tells the Squires' scripts apart.
      return [
        yield* makeScriptedAdapterV2({
          instanceId,
          environment: {},
          ...(input.fetch === undefined ? {} : { fetchImplementation: input.fetch }),
        }),
      ];
    }).pipe(Effect.provide(Layer.fresh(McpProviderSessions.layer))),
  ).pipe(
    Layer.provide(Layer.mergeAll(IdAllocator.layer, TestProviderHost.layer(), fakes)),
    Layer.provide(NodeServices.layer),
  );
  return ProviderReplayHarness.layerWithRegistry({ name: "squire-fake" }, registry, {
    runEffectWorker: false,
  }).pipe(Layer.provideMerge(fakes));
}

const squireDelivery = (eventKinds: ReadonlyArray<string>): OrchestrationV2Notification => ({
  source: {
    kind: "squire",
    squireId: SquireId.make("squire:lead"),
    eventCount: eventKinds.length,
    eventKinds,
  },
  outcome: "updated",
  summary: `${eventKinds.length} events`,
});

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:squire-fake"),
      title: threadId,
      modelSelection: { instanceId, model: "scripted" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: yield* checkpointWorkspace(`squire-fake-${threadId.split("-").at(-1)}`),
      createdBy: "system",
      creationSource: "server",
    });
  });

const send = (
  threadId: ThreadId,
  id: string,
  input: { readonly text: string; readonly notification?: OrchestrationV2Notification },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${id}`),
      threadId,
      messageId: MessageId.make(`message:${id}`),
      text: input.text,
      attachments: [],
      // A delivery is a queued server message with a notification, as SquireDelivery sends it.
      ...(input.notification === undefined
        ? {
            createdBy: "user" as const,
            creationSource: "web" as const,
            dispatchMode: { type: "start_immediately" as const },
          }
        : {
            createdBy: "agent" as const,
            creationSource: "server" as const,
            dispatchMode: { type: "queue_after_active" as const },
            notification: input.notification,
          }),
    });
    yield* worker.drain();
  });

const persisted = (predicate: (stored: OrchestrationV2StoredEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const found = yield* orchestrator.streamStoredEvents.pipe(
      Stream.filter(predicate),
      Stream.runHead,
    );
    return Option.getOrThrow(found).event;
  });

const turnEnded = (threadId: ThreadId, ordinal: number) =>
  persisted(
    (stored) =>
      stored.event.threadId === threadId &&
      stored.event.type === "provider-turn.updated" &&
      stored.event.payload.ordinal === ordinal &&
      ["completed", "interrupted", "failed"].includes(stored.event.payload.status),
  ).pipe(
    Effect.map((event) => (event.type === "provider-turn.updated" ? event.payload.status : "")),
  );

const assistantTexts = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.text);
  });

describe("SquireFakeScripts", () => {
  it.live("runs each Squire thread's own script by event kind on one adapter instance", () => {
    const fake = makeFakeMcp();
    return Effect.gen(function* () {
      const fakes = yield* SquireFakeScripts.SquireFakeScripts;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* fakes.set(lead, {
        onboarding: [
          { toolCall: { name: "squire_propose_squire", arguments: { name: "Release" } } },
          { assistantText: "Lead onboarded." },
        ],
        "user-message": [
          {
            askUser: { question: "Which project?", options: ["billing", "observatory"] },
            saveAs: "pick",
          },
          { toolCall: { name: "squire_publish_showcase", arguments: { project: "${pick}" } } },
        ],
        "*": [{ assistantText: "Lead stays quiet." }],
      });
      yield* fakes.set(release, {
        "*": [{ assistantText: "Release holding." }, { hold: true }],
      });
      yield* createThread(lead);
      yield* createThread(release);

      // A delivery of onboarding plus another kind picks the first kind that has a script.
      yield* send(lead, "lead-1", {
        text: "Squire events",
        notification: squireDelivery(["onboarding", "pr-failed"]),
      });
      // A registered thread's script wins over a fenced block.
      yield* send(release, "release-1", {
        text: '```scripted\n[{"assistantText":"From the fence."}]\n```',
        notification: squireDelivery(["waiting-on-user"]),
      });
      assert.equal(yield* turnEnded(lead, 1), "completed");
      assert.deepEqual(yield* assistantTexts(lead), ["Lead onboarded."]);

      // Release's run stays open on its hold while the Lead keeps working.
      yield* persisted(
        (stored) =>
          stored.event.threadId === release &&
          stored.event.type === "message.updated" &&
          stored.event.payload.text === "Release holding.",
      );
      const releaseTurn = (yield* orchestrator.getThreadProjection(release)).providerTurns.at(-1);
      assert.equal(releaseTurn?.status, "running");

      // A typed message is `user-message`: it asks, and the answer feeds the next call.
      yield* send(lead, "lead-2", { text: "Show me the showcase." });
      const question = yield* persisted(
        (stored) =>
          stored.event.threadId === lead &&
          stored.event.type === "turn-item.updated" &&
          stored.event.payload.type === "user_input_request",
      );
      if (question.type !== "turn-item.updated" || question.payload.type !== "user_input_request") {
        return assert.fail("no question row");
      }
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("answer"),
        threadId: lead,
        requestId: question.payload.requestId,
        answers: { [ASK_USER_QUESTION_ID]: "observatory" },
      });
      yield* worker.drain();
      assert.equal(yield* turnEnded(lead, 2), "completed");

      assert.deepEqual(fake.calls, [
        { threadId: lead, name: "squire_propose_squire", arguments: { name: "Release" } },
        { threadId: lead, name: "squire_publish_showcase", arguments: { project: "observatory" } },
      ]);
      assert.equal(
        (yield* orchestrator.getThreadProjection(release)).providerTurns.at(-1)?.status,
        "running",
      );

      // Stopping the held run ends it; the hold never reaches a later step.
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("interrupt"),
        threadId: release,
        runId: (yield* orchestrator.getThreadProjection(release)).runs.at(-1)!.id,
      });
      yield* worker.drain();
      assert.equal(yield* turnEnded(release, 1), "interrupted");
      assert.deepEqual(yield* assistantTexts(release), ["Release holding."]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerFake({ configs: [fakeMcpConfig(lead), fakeMcpConfig(release)], fetch: fake.fetch }),
      ),
    );
  });

  it.live("sends each Squire's scripted tool calls through the gated /mcp with its own role", () =>
    Effect.gen(function* () {
      const bound = yield* serveBoundMcp({ squireEnabled: true });
      const configs = [
        yield* bound.issueSquire({
          threadId: lead,
          squireId: SquireId.make("squire:lead"),
          role: "lead",
        }),
        yield* bound.issueSquire({
          threadId: release,
          squireId: SquireId.make("squire:release"),
          role: "squire",
        }),
      ];
      const htmlRender = {
        toolCall: {
          name: "html_render",
          arguments: { html: "<p>hi</p>", title: "Hi", height: 200 },
        },
      };
      // A local path the ordinary tool would inline; a Squire's page is refused for it.
      const localPage = {
        toolCall: {
          name: "html_render",
          arguments: { html: '<img src="/srv/secret.png">', title: "Leak", height: 200 },
        },
        onError: "continue",
      } as const;
      yield* Effect.gen(function* () {
        const fakes = yield* SquireFakeScripts.SquireFakeScripts;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* fakes.set(lead, {
          "*": [
            htmlRender,
            localPage,
            { toolCall: { name: "lecturn_thread_send", arguments: {} } },
          ],
        });
        yield* fakes.set(release, {
          "*": [htmlRender, localPage, { assistantText: "Rendered locked." }],
        });
        yield* createThread(lead);
        yield* createThread(release);
        yield* send(lead, "gated-lead", { text: "Go." });
        yield* send(release, "gated-release", { text: "Go." });
        // The gate refuses with a JSON-RPC error, which ends a strict step's turn as failed.
        assert.equal(yield* turnEnded(lead, 1), "failed");
        assert.equal(yield* turnEnded(release, 1), "completed");
        assert.deepEqual(yield* assistantTexts(release), ["Rendered locked."]);
        const tools = (threadId: ThreadId) =>
          orchestrator
            .getThreadProjection(threadId)
            .pipe(
              Effect.map((projection) =>
                projection.turnItems.flatMap((item) =>
                  item.type === "dynamic_tool" ? [item] : [],
                ),
              ),
            );
        // Both roles render, locked; neither may send.
        const leadTools = yield* tools(lead);
        assert.deepEqual(
          leadTools.map((item) => [item.toolName, item.status]),
          [
            ["lecturn.html_render", "completed"],
            ["lecturn.html_render", "failed"],
            ["lecturn.lecturn_thread_send", "failed"],
          ],
        );
        const releaseTools = yield* tools(release);
        assert.deepEqual(
          releaseTools.map((item) => [item.toolName, item.status]),
          [
            ["lecturn.html_render", "completed"],
            ["lecturn.html_render", "failed"],
          ],
        );
        for (const [published, refused] of [leadTools, releaseTools]) {
          // The page is stored as the locked wrapper, with the page only as data in it.
          const reference = htmlRenderFromToolItem(published!)!;
          const stored = NodeFS.readFileSync(
            NodePath.join(bound.attachmentsDir, `${reference.attachmentId}.html`),
            "utf8",
          );
          assert.include(stored, "frame-src 'none'");
          assert.notInclude(stored, "<p>hi</p>");
          assert.include(
            JSON.stringify(refused!.output),
            "a Squire's page cannot load: /srv/secret.png",
          );
        }
      }).pipe(Effect.provide(layerFake({ configs })));
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("exists only with the Squire switch and test providers both on", () =>
    Effect.gen(function* () {
      const present = (squireEnabled: boolean, testProviders: string | undefined) =>
        Effect.serviceOption(SquireFakeScripts.SquireFakeScripts).pipe(
          Effect.map(Option.isSome),
          Effect.provide(
            SquireFakeScripts.layerServer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.effect(
                    ServerConfig.ServerConfig,
                    Effect.map(ServerConfig.ServerConfig, (config) => ({
                      ...config,
                      squireEnabled,
                    })),
                  ).pipe(
                    Layer.provide(
                      ServerConfig.layerTest(process.cwd(), { prefix: "squire-fake-gate" }),
                    ),
                  ),
                  Layer.succeed(
                    HostProcess.Environment,
                    testProviders === undefined ? {} : { LECTURN_TEST_PROVIDERS: testProviders },
                  ),
                ),
              ),
            ),
          ),
        );
      assert.isTrue(yield* present(true, "1"));
      assert.isFalse(yield* present(true, undefined));
      assert.isFalse(yield* present(false, "1"));
      assert.isFalse(yield* present(true, "0"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("derives the event kinds from the delivery, else a typed message", () => {
    const base = {
      messageId: MessageId.make("message:kinds"),
      text: "hi",
      attachments: [],
      creationSource: "server" as const,
    };
    assert.deepEqual(
      SquireFakeScripts.squireFakeEventKinds({
        ...base,
        createdBy: "agent",
        notification: squireDelivery(["onboarding"]),
      }),
      ["onboarding"],
    );
    assert.deepEqual(SquireFakeScripts.squireFakeEventKinds({ ...base, createdBy: "user" }), [
      "user-message",
    ]);
    assert.deepEqual(SquireFakeScripts.squireFakeEventKinds({ ...base, createdBy: "agent" }), []);

    const scripts = { onboarding: [{ assistantText: "o" }], "*": [{ assistantText: "any" }] };
    assert.deepEqual(SquireFakeScripts.pickSquireFakeScript(scripts, ["pr-failed", "onboarding"]), [
      { assistantText: "o" },
    ]);
    assert.deepEqual(SquireFakeScripts.pickSquireFakeScript(scripts, ["user-message"]), [
      { assistantText: "any" },
    ]);
    assert.isUndefined(SquireFakeScripts.pickSquireFakeScript({}, ["user-message"]));
  });

  it("keeps a delivery's event kinds through the wire encoding", () => {
    const source = squireDelivery(["onboarding", "pr-failed"]).source;
    const encoded = encodeSource(source);
    assert.deepEqual(encoded, {
      kind: "background_task",
      work: "squire",
      squireId: "squire:lead",
      eventCount: 2,
      eventKinds: ["onboarding", "pr-failed"],
    });
    assert.deepEqual(decodeSource(encoded), source);
  });
});
