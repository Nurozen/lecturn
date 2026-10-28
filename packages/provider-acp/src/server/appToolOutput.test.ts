import { assert, describe, it } from "@effect/vitest";
import {
  recordServedAppToolResult,
  resetServedAppToolResults,
} from "@lecturn/shared/appToolResults";
import { afterEach } from "vite-plus/test";

import { acpLecturnMcpToolRawOutput, acpMcpToolCallArgs } from "./appToolOutput.ts";

const T0 = 1_800_000_000_000;
const served = {
  content: [{ type: "text", text: "The counter is now 1." }],
  _meta: { "lecturn/summary": "Now 1" },
};
const call = (overrides: Partial<Parameters<typeof acpLecturnMcpToolRawOutput>[0]> = {}) =>
  acpLecturnMcpToolRawOutput({
    threadId: "t1",
    callId: "call-1",
    server: "lecturn",
    tool: "ex_counter_increment",
    args: { by: 1 },
    status: "completed",
    startedAtMillis: T0,
    nowMillis: T0 + 200,
    rawOutput: undefined,
    ...overrides,
  });

// Lecturn's `/mcp` serves the call after the agent announced it at T0.
const serve = () =>
  recordServedAppToolResult(
    { threadId: "t1", tool: "ex_counter_increment", args: { by: 1 }, result: served },
    T0 + 100,
  );

afterEach(() => resetServedAppToolResults());

describe("acpLecturnMcpToolRawOutput", () => {
  it("fills a Lecturn call the agent ended without a result from the result Lecturn served", () => {
    serve();

    assert.deepEqual(call(), { result: served });
  });

  it("replaces text content the agent reported in place of the result", () => {
    serve();
    const text = [{ type: "content", content: { type: "text", text: "Now 1" } }];

    assert.deepEqual(call({ rawOutput: text }), { result: served });
  });

  it("keeps the provider's own MCP result, a running call and other servers' calls", () => {
    serve();
    const own = { result: { content: [{ type: "text", text: "own" }] } };

    assert.strictEqual(call({ rawOutput: own }), own);
    assert.isUndefined(call({ status: "running" }));
    assert.isUndefined(call({ server: "weather" }));
    assert.deepEqual(call(), { result: served });
  });
});

describe("acpMcpToolCallArgs", () => {
  it("reads the arguments from the identity, `arguments` or Grok's `tool_input`", () => {
    assert.deepEqual(acpMcpToolCallArgs({ a: 1 }, { arguments: { b: 2 } }), { a: 1 });
    assert.deepEqual(acpMcpToolCallArgs(undefined, { arguments: { b: 2 } }), { b: 2 });
    assert.deepEqual(
      acpMcpToolCallArgs(undefined, {
        tool_name: "lecturn__ex_counter_increment",
        tool_input: { by: 1 },
        variant: "UseTool",
      }),
      { by: 1 },
    );
    assert.isUndefined(acpMcpToolCallArgs(undefined, { server: "lecturn", tool: "ex_a" }));
  });
});
