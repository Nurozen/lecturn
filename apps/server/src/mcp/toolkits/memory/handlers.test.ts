import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MemoryDenNode,
  type MemoryQueryInput,
  type OrchestrationThreadShell,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { ServerConfig } from "../../../config.ts";
import * as MemoryDemoStore from "../../../memoryDemo/MemoryDemoStore.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MemoryToolkitRegistrationLive } from "./registration.ts";

const projectId = ProjectId.make("project-billing");
const threadId = ThreadId.make("thread-memory-tools");
const orphanThreadId = ThreadId.make("thread-without-project");

const invocation = (thread: ThreadId) => ({
  environmentId: EnvironmentId.make("environment-memory-test"),
  threadId: thread,
  providerSessionId: "provider-session-memory-test",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/** In-memory den per project plus a log of every call's source. */
const makeFakeStore = () => {
  const dens = new Map<ProjectId, MemoryDenNode[]>();
  const calls: Array<{
    readonly method: "query" | "write";
    readonly source: MemoryDemoStore.MemoryCallSource;
    readonly input: unknown;
  }> = [];
  const store: MemoryDemoStore.MemoryDemoStoreShape = {
    ...MemoryDemoStore.stub,
    den: ({ projectId }) =>
      Effect.succeed({
        projectId,
        name: "billing",
        revision: 1,
        nodes: dens.get(projectId) ?? [],
        recentQueries: [],
      }),
    write: (input, source) =>
      Effect.sync(() => {
        calls.push({ method: "write", source, input });
        const node: MemoryDenNode = {
          id: "billing/webhook-retries",
          projectId: input.projectId,
          type: input.type ?? "concept",
          namespace: "billing",
          summary: input.summary,
          context: input.context ?? "",
          tags: input.tags ?? [],
          sourcePath: input.sourcePath ?? null,
          origin: source.origin,
          threadId: source.threadId ?? null,
          createdAt: "2026-09-29T12:00:00.000Z",
          targetId: null,
          judgments: { method: "heuristic", model: null, standards: [], duplicate: null },
        };
        dens.set(input.projectId, [...(dens.get(input.projectId) ?? []), node]);
        return node;
      }),
    query: (input: MemoryQueryInput, source) =>
      Effect.sync(() => {
        calls.push({ method: "query", source, input });
        return {
          hits: [
            {
              nodeId: "webhooks/stripe-retry-window",
              scope: "warren" as const,
              territoryId: "webhooks",
              type: "decision" as const,
              summary: "Stripe retries failed webhooks for up to 3 days.",
              score: 4.2,
              matched: ["stripe", "webhook"],
            },
          ],
          pathIds: ["webhooks/stripe-retry-window"],
          approxTokens: 2100,
        };
      }),
  };
  return { store, calls };
};

const makeLayer = (store: MemoryDemoStore.MemoryDemoStoreShape, memoryDemoEnabled: boolean) =>
  MemoryToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.succeed(MemoryDemoStore.MemoryDemoStore, store)),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (id) =>
          Effect.succeed(
            id === threadId
              ? Option.some({ id, projectId } as unknown as OrchestrationThreadShell)
              : Option.none(),
          ),
      }),
    ),
    Layer.provide(Layer.succeed(ServerConfig, { memoryDemoEnabled } as never)),
  );

const callTool = (name: string, args: Record<string, unknown>, thread = threadId) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(thread)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const text = (result: McpSchema.CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

it.effect("memory_write records into the calling thread's project den as the agent", () => {
  const { store, calls } = makeFakeStore();
  return Effect.gen(function* () {
    const result = yield* callTool("memory_write", {
      summary: "Stripe webhook handlers dedupe on event.id.",
      type: "decision",
      tags: ["stripe"],
    });

    expect(result.isError).toBe(false);
    expect(text(result)).toBe(
      'Recorded billing/webhook-retries (decision) in den "billing". The den now holds 1 node awaiting review.',
    );
    expect(calls).toEqual([
      {
        method: "write",
        source: { origin: "agent", threadId },
        input: {
          projectId,
          summary: "Stripe webhook handlers dedupe on event.id.",
          type: "decision",
          tags: ["stripe"],
        },
      },
    ]);
  }).pipe(Effect.provide(makeLayer(store, true)));
});

it.effect("memory_write reports a thread without a project instead of writing", () => {
  const { store, calls } = makeFakeStore();
  return Effect.gen(function* () {
    const result = yield* callTool("memory_write", { summary: "Anything." }, orphanThreadId);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not attached to a project");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(makeLayer(store, true)));
});

it.effect("memory_query searches the project den and returns ranked hits as text", () => {
  const { store, calls } = makeFakeStore();
  return Effect.gen(function* () {
    const result = yield* callTool("memory_query", { query: "stripe webhook retries" });

    expect(result.isError).toBe(false);
    expect(text(result)).toBe(
      [
        '1 hit for "stripe webhook retries" (about 2.1k tokens):',
        "1. webhooks/stripe-retry-window (warren, webhooks, decision): Stripe retries failed webhooks for up to 3 days.",
      ].join("\n"),
    );
    expect(calls).toEqual([
      {
        method: "query",
        source: { origin: "agent", threadId },
        input: { text: "stripe webhook retries", limit: 8, projectId },
      },
    ]);
  }).pipe(Effect.provide(makeLayer(store, true)));
});

it.effect("surfaces the store's disabled error as tool error text", () =>
  Effect.gen(function* () {
    const result = yield* callTool("memory_query", { query: "anything" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("The memory demo is not enabled on this server.");
  }).pipe(Effect.provide(makeLayer(MemoryDemoStore.stub, true))),
);

it.effect("registers no memory tools when the demo flag is off", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map((entry) => entry.tool.name)).toEqual([]);
  }).pipe(Effect.provide(makeLayer(MemoryDemoStore.stub, false))),
);
