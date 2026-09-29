import {
  MemoryDemoError,
  type MemoryDen,
  type MemoryDenNode,
  type MemoryQueryResult,
  type ProjectId,
  type ThreadId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { MemoryDemoStore } from "../../../memoryDemo/MemoryDemoStore.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MemoryToolkit } from "./tools.ts";

const DEFAULT_QUERY_LIMIT = 8;

const approxTokens = (tokens: number) =>
  tokens >= 1000 ? `about ${(tokens / 1000).toFixed(1)}k tokens` : `about ${tokens} tokens`;

/** Ranked hits as one line each: `1. id (scope, territory, type): summary`. */
export function formatQueryResult(query: string, result: MemoryQueryResult): string {
  if (result.hits.length === 0) {
    return `No memory matches "${query}". Explore the code, then record what you learn with memory_write.`;
  }
  const lines = result.hits.map(
    (hit, index) =>
      `${index + 1}. ${hit.nodeId} (${hit.scope}, ${hit.territoryId}, ${hit.type}): ${hit.summary}`,
  );
  const noun = result.hits.length === 1 ? "hit" : "hits";
  return [
    `${result.hits.length} ${noun} for "${query}" (${approxTokens(result.approxTokens)}):`,
    ...lines,
  ].join("\n");
}

export function formatWriteResult(node: MemoryDenNode, den: MemoryDen): string {
  const count = den.nodes.length;
  return `Recorded ${node.id} (${node.type}) in den "${den.name}". The den now holds ${count} ${count === 1 ? "node" : "nodes"} awaiting review.`;
}

/**
 * Handlers for `memory_query` / `memory_write`. The calling thread's project
 * picks the den; both calls are recorded with origin `agent` and the thread id.
 */
export const MemoryToolkitHandlersLive = MemoryToolkit.toLayer(
  Effect.gen(function* () {
    const store = yield* MemoryDemoStore;
    const projections = yield* ProjectionSnapshotQuery;

    const threadProjectId = (threadId: ThreadId) =>
      projections.getThreadShellById(threadId).pipe(
        Effect.map(Option.map((thread): ProjectId => thread.projectId)),
        Effect.mapError(
          () =>
            new MemoryDemoError({
              code: "not-found",
              message: "Could not read this thread's project.",
            }),
        ),
      );

    return {
      memory_query: ({ query, limit }) =>
        Effect.gen(function* () {
          const { threadId } = yield* McpInvocationContext.McpInvocationContext;
          const projectId = yield* threadProjectId(threadId);
          const result = yield* store.query(
            {
              text: query,
              limit: limit ?? DEFAULT_QUERY_LIMIT,
              ...(Option.isSome(projectId) ? { projectId: projectId.value } : {}),
            },
            { origin: "agent", threadId },
          );
          return formatQueryResult(query, result);
        }),
      memory_write: ({ summary, context, type, tags, sourcePath }) =>
        Effect.gen(function* () {
          const { threadId } = yield* McpInvocationContext.McpInvocationContext;
          const projectId = yield* threadProjectId(threadId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new MemoryDemoError({
                      code: "not-found",
                      message: "This thread is not attached to a project, so it has no den.",
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );
          const node = yield* store.write(
            {
              projectId,
              summary,
              ...(context === undefined ? {} : { context }),
              ...(type === undefined ? {} : { type }),
              ...(tags === undefined ? {} : { tags }),
              ...(sourcePath === undefined ? {} : { sourcePath }),
            },
            { origin: "agent", threadId },
          );
          const den = yield* store.den({ projectId });
          return formatWriteResult(node, den);
        }),
    };
  }),
);
