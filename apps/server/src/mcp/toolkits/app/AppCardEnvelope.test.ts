// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AppsError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AppRegistration,
} from "@lecturn/contracts";
import { MCP_APP_OUTPUT_KEY, readMcpAppToolOutcome } from "@lecturn/shared/mcpApp";
import { compactDynamicToolOutput, mcpAppFromToolItem } from "@lecturn/shared/toolOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema } from "effect/ai";

import * as AppRuntimeState from "../../../apps/AppRuntimeState.ts";
import {
  AppLeaseService,
  AppProjectService,
  AppRegistryService,
  AppToolApprovalService,
  HeadlessToolHost,
  LiveToolClient,
} from "../../../apps/services.ts";
import {
  fixtureAppId as appId,
  fixtureProjectId as projectId,
  fixtureRegistration,
  statusOf,
} from "../../../apps/testing/headlessAppFixture.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as RuntimePolicy from "../../../orchestration-v2/RuntimePolicy.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as AppCardEnvelope from "./AppCardEnvelope.ts";

const threadId = ThreadId.make("thread-envelope");
const resourceUri = "ui://ex/counter-card";
const html = "<!doctype html><title>Counter</title><main>3</main>";

const scope: McpInvocationContext.McpAppInvocationScope = {
  environmentId: EnvironmentId.make("environment-envelope"),
  capabilities: new Set(["orchestration", "app"]),
  issuedAt: 1,
  requestNamespace: "provider-session-1",
  thread: {
    threadId,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
  client: undefined,
  app: { appId, projectId },
};

const registration: AppRegistration = fixtureRegistration("/unused/fixture.log", {
  listArgs: false,
});

const cardTool = new McpSchema.Tool({
  name: "increment",
  inputSchema: { type: "object" },
  _meta: { ui: { resourceUri, visibility: ["model", "app"] } },
});
const plainTool = new McpSchema.Tool({ name: "echo_meta", inputSchema: { type: "object" } });

const okResult = new McpSchema.CallToolResult({
  content: [{ type: "text", text: "count 3" }],
  structuredContent: { count: 3 },
  _meta: { "lecturn/toolSource": { key: `app:${appId}` } },
});

const decodeRead = Schema.decodeUnknownSync(McpSchema.ReadResourceResult);
const encodeResult = Schema.encodeSync(McpSchema.CallToolResult);
const decodeResult = Schema.decodeUnknownSync(McpSchema.CallToolResult);

type HeadlessRead = HeadlessToolHost["Service"]["readResource"];

const document = decodeRead({
  contents: [
    {
      uri: resourceUri,
      mimeType: "text/html;profile=mcp-app",
      text: html,
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: ["https://api.example.test"] } } },
    },
  ],
});

const withEnvelope = <A, E>(
  readResource: HeadlessRead,
  body: (
    wrap: AppCardEnvelope.WrapAppToolResult,
    context: {
      readonly attachmentsDir: string;
      readonly runtime: AppRuntimeState.AppRuntimeState["Service"];
    },
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const services = Layer.mergeAll(
      AppRuntimeState.layer,
      Layer.mock(AppRegistryService)({
        get: () => Effect.succeedSome({ status: statusOf(registration), registration }),
      }),
      Layer.mock(AppProjectService)({}),
      Layer.mock(AppLeaseService)({ current: () => Effect.succeedNone }),
      Layer.mock(HeadlessToolHost)({ readResource }),
      Layer.mock(LiveToolClient)({}),
      Layer.mock(AppToolApprovalService)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      RuntimePolicy.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-app-card-envelope-" }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const context = yield* Layer.build(services);
    const wrap = yield* AppCardEnvelope.make.pipe(Effect.provide(context));
    const { attachmentsDir } = Context.get(context, ServerConfig.ServerConfig);
    return yield* body(wrap, {
      attachmentsDir,
      runtime: Context.get(context, AppRuntimeState.AppRuntimeState),
    });
  }).pipe(Effect.scoped);

const input = (fields: Partial<AppCardEnvelope.AppCardEnvelopeInput> = {}) => ({
  scope,
  appId,
  tier: "headless" as const,
  tool: cardTool,
  request: { name: "increment", arguments: {}, meta: {} },
  result: okResult,
  ...fields,
});

it.effect("captures the card at call time and returns the envelope every adapter records", () =>
  withEnvelope(
    () => Effect.succeed(document),
    (wrap, { attachmentsDir, runtime }) =>
      Effect.gen(function* () {
        const wrapped = yield* wrap(input());
        expect(wrapped.content).toEqual(okResult.content);
        expect(wrapped._meta).toEqual(okResult._meta);
        const envelope = encodeResult(wrapped).structuredContent as Record<string, unknown>;
        const reference = mcpAppFromToolItem({
          toolName: "mcp__lecturn__ex_increment",
          output: envelope,
        });
        expect(reference).toMatchObject({
          server: "lecturn",
          tool: "ex_increment",
          resourceUri,
          prefersBorder: true,
          csp: { connectDomains: ["https://api.example.test"] },
        });
        expect(envelope[MCP_APP_OUTPUT_KEY]).toEqual(reference);
        // Codex's envelope shape: the card is replayed the whole MCP result.
        expect(readMcpAppToolOutcome(envelope)).toEqual({
          result: { content: okResult.content, structuredContent: { count: 3 } },
        });

        const saved = NodeFS.readFileSync(
          NodePath.join(attachmentsDir, `${reference!.attachmentId}.html`),
          "utf8",
        );
        expect(saved).toContain("Content-Security-Policy");
        expect(saved).toContain("<main>3</main>");

        // Building the envelope also publishes the card route for McpAppRequests.
        expect(Option.isSome(yield* Ref.get(runtime.mcpAppRoute))).toBe(true);
      }),
  ),
);

it.effect("carries an image's bytes once, in the result's own content", () =>
  withEnvelope(
    () => Effect.succeed(document),
    (wrap) =>
      Effect.gen(function* () {
        const data = "iVBORw0KGgoA".repeat(20_000);
        const caption = { type: "text", text: "Iso view" };
        const rendered = decodeResult({
          content: [{ type: "image", data, mimeType: "image/png" }, caption],
          structuredContent: { path: "renders/window/view.png" },
        });
        const wrapped = encodeResult(yield* wrap(input({ result: rendered })));
        expect(wrapped.content).toEqual(encodeResult(rendered).content);
        expect(readMcpAppToolOutcome(wrapped.structuredContent)).toEqual({
          result: {
            content: [{ type: "image", mimeType: "image/png" }, caption],
            structuredContent: { path: "renders/window/view.png" },
          },
        });
        expect(JSON.stringify(wrapped).split(data)).toHaveLength(2);
      }),
  ),
);

it.effect("leaves results without a card, failed results and uncapturable cards as they are", () =>
  withEnvelope(
    (_appId, _projectId, uri) =>
      uri === resourceUri
        ? Effect.fail(new AppsError({ code: "unavailable", message: "gone" }))
        : Effect.succeed(document),
    (wrap, { attachmentsDir }) =>
      Effect.gen(function* () {
        expect(yield* wrap(input({ tool: plainTool }))).toBe(okResult);
        const failed = new McpSchema.CallToolResult({
          isError: true,
          content: [{ type: "text", text: "nope" }],
        });
        expect(yield* wrap(input({ result: failed }))).toBe(failed);
        expect(yield* wrap(input())).toBe(okResult);
        const files = NodeFS.existsSync(attachmentsDir) ? NodeFS.readdirSync(attachmentsDir) : [];
        expect(files).toEqual([]);
      }),
  ),
);

it.effect("gives up on a card the app does not serve within 20 seconds", () =>
  withEnvelope(
    () => Effect.never,
    (wrap) =>
      Effect.gen(function* () {
        const fiber = yield* wrap(input()).pipe(Effect.forkChild);
        yield* TestClock.adjust("19 seconds");
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(fiber)).toBe(okResult);
      }),
  ),
);

it.effect("shows a refused call's card as cancelled, with the refusal as the reason", () =>
  withEnvelope(
    () => Effect.succeed(document),
    (wrap) =>
      Effect.gen(function* () {
        const refusal = "The user declined ex_increment (approval declined).";
        const refused = new McpSchema.CallToolResult({
          isError: true,
          content: [{ type: "text", text: refusal }],
        });
        const wrapped = yield* wrap(input({ result: refused, refusal }));
        expect(wrapped.isError).toBe(true);
        const envelope = encodeResult(wrapped).structuredContent;
        expect(compactDynamicToolOutput(encodeResult(wrapped))).toMatchObject({
          isError: true,
          [MCP_APP_OUTPUT_KEY]: { tool: "ex_increment" },
        });
        expect(readMcpAppToolOutcome(envelope)).toEqual({ cancelled: { reason: refusal } });
        // Adapters that keep only the text still yield the same outcome.
        expect(readMcpAppToolOutcome([{ type: "text", text: JSON.stringify(envelope) }])).toEqual({
          cancelled: { reason: refusal },
        });
      }),
  ),
);
