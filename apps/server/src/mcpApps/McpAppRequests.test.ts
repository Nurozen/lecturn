import {
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  type McpAppRequestError,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@lecturn/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { mcpAppToolCallableByApp } from "@lecturn/shared/mcpApp";

import * as AppRuntimeState from "../apps/AppRuntimeState.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SquireActions from "../squire/SquireActions.ts";
import * as SquireMcpAppRoute from "../squire/SquireMcpAppRoute.ts";
import * as SquireRepository from "../squire/SquireRepository.ts";
import * as McpAppModelContext from "./McpAppModelContext.ts";
import * as McpAppRequests from "./McpAppRequests.ts";

const threadId = ThreadId.make("thread-app");
const itemId = TurnItemId.make("item-app");
const providerThreadId = ProviderThreadId.make("provider-thread-app");
const providerSessionId = ProviderSessionId.make("provider-session-app");
const forkId = ThreadId.make("thread-fork");
const unrelatedId = ThreadId.make("thread-unrelated");
const deepForkId = (depth: number) => ThreadId.make(`thread-deep-${depth}`);
const deepParent = (id: ThreadId): ThreadId | null => {
  const match = /^thread-deep-(\d+)$/.exec(id);
  if (match === null) return null;
  const depth = Number(match[1]);
  return depth === 1 ? threadId : deepForkId(depth - 1);
};

const appItem = (
  output: unknown,
  overrides: Partial<{ toolName: string; providerThreadId: ProviderThreadId | null }> = {},
): OrchestrationV2TurnItem => ({
  id: itemId,
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
  type: "dynamic_tool",
  toolName: "weather.get_weather",
  input: {},
  output,
  ...overrides,
});

const app = {
  attachmentId: "thread-app-00000000-0000-0000-0000-000000000000-html",
  server: "weather",
  tool: "get_weather",
  resourceUri: "ui://weather/dashboard",
};

const storedContext = new Map<string, string>();

function makeLayer(input: {
  readonly item: OrchestrationV2TurnItem | null;
  readonly mcpApps?: ProviderAdapter.ProviderAdapterV2McpApps;
  readonly live?: boolean;
  /** Builds the Squire layer's showcase route over these stand-ins. */
  readonly squire?: {
    readonly card: Partial<SquireRepository.SquireCardRow> | null;
    readonly acted: Array<string>;
  };
}) {
  const squire = input.squire;
  const runtimeState =
    squire === undefined
      ? AppRuntimeState.layer
      : SquireMcpAppRoute.layer.pipe(
          Layer.provideMerge(AppRuntimeState.layer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(SquireRepository.SquireRepository)({
                getCard: (id) =>
                  Effect.succeed(
                    squire.card === null
                      ? Option.none()
                      : Option.some({
                          id,
                          owner_squire_id: "squire-release",
                          ...squire.card,
                        } as SquireRepository.SquireCardRow),
                  ),
                getSquire: () =>
                  Effect.succeed(Option.some({ lifecycle: "ready" } as SquireRepository.SquireRow)),
              }),
              Layer.mock(SquireActions.SquireActions)({
                act: (request) =>
                  Effect.sync(() => {
                    squire.acted.push(`${request.action}:${request.cardIds.join(",")}`);
                    return {
                      results: request.cardIds.map((cardId) => ({
                        cardId,
                        status: "dismissed" as const,
                        error: null,
                      })),
                    };
                  }),
              }),
            ),
          ),
        );
  return McpAppRequests.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        runtimeState,
        Layer.mock(McpAppModelContext.McpAppModelContext)({
          set: (entry) =>
            Effect.sync(() => {
              const key = `${entry.threadId}/${entry.itemId}`;
              if (entry.text.trim() === "") storedContext.delete(key);
              else storedContext.set(key, entry.text);
            }),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getTurnItem: () => Effect.succeed(input.item),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (id: ThreadId) =>
            Effect.succeed({
              thread: {
                lineage:
                  deepParent(id) !== null
                    ? {
                        parentThreadId: deepParent(id),
                        relationshipToParent: "fork",
                        rootThreadId: threadId,
                      }
                    : id === forkId
                      ? {
                          parentThreadId: threadId,
                          relationshipToParent: "fork",
                          rootThreadId: threadId,
                        }
                      : { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
              },
              providerThreads: [
                { id: providerThreadId, providerSessionId } as OrchestrationV2ProviderThread,
              ],
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeed(
              input.live === false
                ? Option.none()
                : Option.some(
                    (input.mcpApps === undefined
                      ? {}
                      : {
                          mcpApps: input.mcpApps,
                        }) as ProviderAdapter.ProviderAdapterV2SessionRuntime,
                  ),
            ),
        }),
      ),
    ),
  );
}

const reason = <A, R>(effect: Effect.Effect<A, McpAppRequestError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("McpAppRequests", () => {
  const calls: Array<{ server: string; tool: string }> = [];
  const mcpApps: ProviderAdapter.ProviderAdapterV2McpApps = {
    listTools: () =>
      Effect.succeed([
        { name: "refresh", annotations: { readOnlyHint: true } },
        { name: "model_only", _meta: { ui: { visibility: ["model"] } } },
      ]),
    callTool: (input) =>
      Effect.sync(() => {
        calls.push({ server: input.server, tool: input.tool });
        return { content: [{ type: "text", text: "ok" }] };
      }),
    readResource: () => Effect.succeed({ contents: [] }),
  };

  it.effect("calls tools on the app's own server and reports their read-only hint", () =>
    Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const result = yield* requests.callTool({
        threadId,
        itemId,
        name: "refresh",
        arguments: {},
      });
      assert.deepEqual(result, { content: [{ type: "text", text: "ok" }] });
      assert.deepEqual(calls.at(-1), { server: "weather", tool: "refresh" });
      assert.deepEqual(yield* requests.toolInfo({ threadId, itemId, name: "refresh" }), {
        callable: true,
        readOnly: true,
        tool: { name: "refresh", annotations: { readOnlyHint: true } },
      });
    }).pipe(Effect.provide(makeLayer({ item: appItem({ lecturnMcpApp: app }), mcpApps }))),
  );

  it.effect("refuses tools hidden from apps or missing from the server", () =>
    Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const before = calls.length;
      for (const name of ["model_only", "unknown"]) {
        assert.equal(
          yield* reason(requests.callTool({ threadId, itemId, name, arguments: {} })),
          "tool-not-callable",
        );
      }
      assert.equal(calls.length, before);
    }).pipe(Effect.provide(makeLayer({ item: appItem({ lecturnMcpApp: app }), mcpApps }))),
  );

  it.effect("keeps each app's latest model context, without a live session", () =>
    Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const own = { threadId, itemId, conversationThreadId: threadId };
      yield* requests.updateModelContext({
        ...own,
        content: [{ type: "text", text: "  indented value  " }],
      });
      assert.equal(storedContext.get(`${threadId}/${itemId}`), "  indented value  ");
      yield* requests.updateModelContext({
        ...own,
        content: [{ type: "text", text: "Filtered to overdue" }],
        structuredContent: { filter: "overdue" },
      });
      assert.equal(
        storedContext.get(`${threadId}/${itemId}`),
        'Filtered to overdue\n{"filter":"overdue"}',
      );
      assert.equal(
        yield* reason(
          requests.updateModelContext({ ...own, content: [{ type: "image", data: "x" }] }),
        ),
        "unsupported-content",
      );
      assert.equal(
        yield* reason(
          requests.updateModelContext({
            ...own,
            content: [{ type: "text", text: "表".repeat(6000) }],
          }),
        ),
        "request-failed",
      );
      yield* requests.updateModelContext(own);
      assert.isFalse(storedContext.has(`${threadId}/${itemId}`));
    }).pipe(Effect.provide(makeLayer({ item: appItem({ lecturnMcpApp: app }), live: false }))),
  );

  it.effect("stores a fork's model context under the fork, and refuses unrelated threads", () =>
    Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const content = [{ type: "text", text: "Seen from the fork" }];
      yield* requests.updateModelContext({
        threadId,
        itemId,
        conversationThreadId: forkId,
        content,
      });
      assert.equal(storedContext.get(`${forkId}/${itemId}`), "Seen from the fork");
      assert.isFalse(storedContext.has(`${threadId}/${itemId}`));
      assert.equal(
        yield* reason(
          requests.updateModelContext({
            threadId,
            itemId,
            conversationThreadId: unrelatedId,
            content,
          }),
        ),
        "not-an-app",
      );
      yield* requests.updateModelContext({
        threadId,
        itemId,
        conversationThreadId: deepForkId(70),
        content,
      });
      assert.isTrue(storedContext.has(`${deepForkId(70)}/${itemId}`));
    }).pipe(Effect.provide(makeLayer({ item: appItem({ lecturnMcpApp: app }), live: false }))),
  );

  it.effect("reports why a request cannot run", () =>
    Effect.gen(function* () {
      const run = (layer: ReturnType<typeof makeLayer>) =>
        Effect.gen(function* () {
          const requests = yield* McpAppRequests.McpAppRequests;
          return yield* reason(requests.readResource({ threadId, itemId, uri: "ui://weather/x" }));
        }).pipe(Effect.provide(layer));
      assert.equal(
        yield* run(makeLayer({ item: appItem({ result: "plain" }), mcpApps })),
        "not-an-app",
      );
      assert.equal(
        yield* run(makeLayer({ item: appItem({ lecturnMcpApp: app }), mcpApps, live: false })),
        "session-stopped",
      );
      assert.equal(
        yield* run(makeLayer({ item: appItem({ lecturnMcpApp: app }) })),
        "provider-unsupported",
      );
    }),
  );

  // AppMcpAppRoute.test.ts covers the route itself; here AppsLayer is not up.
  it.effect("keeps connected-app cards off the provider session", () =>
    Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const before = calls.length;
      const input = { threadId, itemId };
      assert.equal(
        yield* reason(requests.readResource({ ...input, uri: "ui://ex/card" })),
        "app-unavailable",
      );
      assert.equal(
        yield* reason(requests.callTool({ ...input, name: "ex_counter", arguments: {} })),
        "app-unavailable",
      );
      assert.equal(calls.length, before);
      yield* requests.updateModelContext({
        ...input,
        conversationThreadId: threadId,
        content: [{ type: "text", text: "Counter at 3" }],
      });
      assert.equal(storedContext.get(`${threadId}/${itemId}`), "Counter at 3");
    }).pipe(
      Effect.provide(
        makeLayer({
          item: appItem(
            {
              lecturnMcpApp: {
                ...app,
                server: "lecturn",
                tool: "ex_counter",
                resourceUri: "ui://ex/card",
              },
            },
            { toolName: "mcp__lecturn__ex_counter", providerThreadId: null },
          ),
          mcpApps,
        }),
      ),
    ),
  );
  const showcase = (shown: ReadonlyArray<string>) =>
    appItem(
      {
        content: [{ type: "text", text: "Published the showcase." }],
        structuredContent: {
          lecturnMcpApp: {
            ...app,
            server: "lecturn",
            tool: "squire_publish_showcase",
            resourceUri: "ui://lecturn/squire/showcase",
          },
          result: {
            content: [{ type: "text", text: "Published the showcase." }],
            structuredContent: { showcase: { itemIds: shown } },
          },
        },
      },
      { toolName: "mcp__lecturn__squire_publish_showcase", providerThreadId: null },
    );

  it.effect("serves showcase cards from the Squire route, without a provider thread", () => {
    const acted: Array<string> = [];
    return Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const before = calls.length;
      const input = { threadId, itemId };
      const info = yield* requests.toolInfo({ ...input, name: "squire_card_dismiss" });
      assert.include(info, { callable: true, readOnly: false });
      // App-only, so the client still asks before every call.
      assert.isTrue(mcpAppToolCallableByApp((info.tool as { _meta: unknown })._meta));
      assert.deepStrictEqual((info.tool as { _meta: unknown })._meta, {
        ui: { visibility: ["app"] },
      });
      const result = yield* requests.callTool({
        ...input,
        name: "squire_card_dismiss",
        arguments: { cardId: "card:steer:a" },
      });
      assert.deepStrictEqual(result.structuredContent, {
        cardId: "card:steer:a",
        status: "dismissed",
      });
      assert.deepStrictEqual(acted, ["dismiss:card:steer:a"]);
      // The page only reaches the items it shows.
      const other = yield* requests.callTool({
        ...input,
        name: "squire_card_accept",
        arguments: { cardId: "card:steer:b" },
      });
      assert.isTrue(other.isError);
      assert.deepStrictEqual(acted, ["dismiss:card:steer:a"]);
      assert.equal(
        yield* reason(requests.readResource({ ...input, uri: "ui://lecturn/squire/showcase" })),
        "not-an-app",
      );
      assert.equal(calls.length, before);
    }).pipe(
      Effect.provide(
        makeLayer({
          item: showcase(["card:steer:a"]),
          mcpApps,
          squire: { card: { status: "open" }, acted },
        }),
      ),
    );
  });

  it.effect("refuses Squire tools that are not the showcase's app-only buttons", () => {
    const acted: Array<string> = [];
    return Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const input = { threadId, itemId };
      for (const name of ["squire_publish_showcase", "squire_list_items", "squire_send_steer"]) {
        assert.isFalse((yield* requests.toolInfo({ ...input, name })).callable);
        assert.equal(
          yield* reason(
            requests.callTool({ ...input, name, arguments: { cardId: "card:steer:a" } }),
          ),
          "tool-not-callable",
        );
      }
      assert.deepStrictEqual(acted, []);
    }).pipe(
      Effect.provide(
        makeLayer({
          item: showcase(["card:steer:a"]),
          squire: { card: { status: "open" }, acted },
        }),
      ),
    );
  });

  it.effect("reports a closed item as outdated and leaves it alone", () => {
    const acted: Array<string> = [];
    return Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const result = yield* requests.callTool({
        threadId,
        itemId,
        name: "squire_card_accept",
        arguments: { cardId: "card:steer:a" },
      });
      assert.deepStrictEqual(result.structuredContent, {
        cardId: "card:steer:a",
        status: "resolved",
        outdated: true,
      });
      assert.deepStrictEqual(acted, []);
    }).pipe(
      Effect.provide(
        makeLayer({
          item: showcase(["card:steer:a"]),
          squire: { card: { status: "resolved" }, acted },
        }),
      ),
    );
  });

  it.effect("reports showcase cards unavailable while the Squire layer is off", () =>
    Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      assert.equal(
        yield* reason(
          requests.callTool({
            threadId,
            itemId,
            name: "squire_card_accept",
            arguments: { cardId: "card:steer:a" },
          }),
        ),
        "app-unavailable",
      );
    }).pipe(Effect.provide(makeLayer({ item: showcase(["card:steer:a"]), mcpApps }))),
  );
});
