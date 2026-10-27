import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { codexTruncatedMcpResult } from "./CodexAdapterV2.testkit.ts";

const call = (server: string, result: unknown) => ({
  type: "mcpToolCall" as const,
  id: "call-1",
  server,
  tool: "fetch",
  status: "completed" as const,
  arguments: {},
  result: result as never,
});

describe("Codex MCP results that are not Lecturn app results", () => {
  it.effect("keeps a tool's own JSON text that looks like a result", () =>
    Effect.gen(function* () {
      const content = [
        {
          type: "text",
          text: '{"content":[{"type":"text","text":"sample"}],"other":"important"}',
        },
      ];
      for (const server of ["docs", "lecturn"]) {
        const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem(
          call(server, { content }),
        );
        assert.deepEqual(projection.output, content);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the head and tail of a result Codex cut to its event limit", () =>
    Effect.gen(function* () {
      const truncated = codexTruncatedMcpResult({
        content: [{ type: "text", text: `start ${"x".repeat(1_200_000)} end` }],
        structuredContent: { rows: 3 },
      });
      for (const server of ["docs", "lecturn"]) {
        const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem(
          call(server, truncated),
        );
        assert.deepEqual(projection.output, truncated.content);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a stamped result from another server as it came", () =>
    Effect.gen(function* () {
      const content = [
        {
          type: "text",
          text: JSON.stringify({
            content: [{ type: "text", text: "sample" }],
            _meta: { "lecturn/summary": "Not Lecturn's" },
          }),
        },
      ];
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem(
        call("docs", { content }),
      );
      assert.deepEqual(projection.output, content);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
