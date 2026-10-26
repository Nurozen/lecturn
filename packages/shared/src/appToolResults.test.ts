import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  claimServedAppToolResult,
  recordServedAppToolResult,
  resetServedAppToolResults,
} from "./appToolResults.ts";

const T0 = 1_800_000_000_000;
const result = (count: number) => ({
  content: [{ type: "text", text: `The counter is now ${count}.` }],
  _meta: { "lecturn/summary": `Now ${count}` },
});

afterEach(() => resetServedAppToolResults());

describe("served app tool results", () => {
  it("fills a call from the result served for its thread, tool and arguments", () => {
    recordServedAppToolResult(
      { threadId: "t1", tool: "ex_counter_increment", args: { by: 1 }, result: result(1) },
      T0 + 50,
    );

    expect(
      claimServedAppToolResult(
        {
          threadId: "t1",
          tool: "ex_counter_increment",
          args: { by: 1 },
          callId: "call-1",
          startedAt: T0,
        },
        T0 + 100,
      ),
    ).toStrictEqual(result(1));
  });

  it("gives a row the same result on every later update, and never to another call", () => {
    recordServedAppToolResult(
      { threadId: "t1", tool: "ex_counter_increment", args: { by: 1 }, result: result(1) },
      T0 + 50,
    );
    const claim = (callId: string) =>
      claimServedAppToolResult(
        { threadId: "t1", tool: "ex_counter_increment", args: { by: 1 }, callId, startedAt: T0 },
        T0 + 100,
      );

    expect(claim("call-1")).toStrictEqual(result(1));
    expect(claim("call-1")).toStrictEqual(result(1));
    expect(claim("call-2")).toBeUndefined();
  });

  it("matches arguments whatever their key order, and tells calls apart by them", () => {
    recordServedAppToolResult(
      { threadId: "t1", tool: "ex_move", args: { x: 1, y: 2 }, result: "first" },
      T0 + 10,
    );
    recordServedAppToolResult(
      { threadId: "t1", tool: "ex_move", args: { x: 3, y: 4 }, result: "second" },
      T0 + 20,
    );
    const claim = (callId: string, args: unknown) =>
      claimServedAppToolResult(
        { threadId: "t1", tool: "ex_move", args, callId, startedAt: T0 },
        T0 + 30,
      );

    expect(claim("b", { y: 2, x: 1 })).toBe("first");
    expect(claim("a", { y: 4, x: 3 })).toBe("second");
  });

  it("gives identical calls their results in the order Lecturn served them", () => {
    recordServedAppToolResult(
      { threadId: "t1", tool: "ex_counter_increment", args: { by: 1 }, result: result(1) },
      T0 + 10,
    );
    recordServedAppToolResult(
      { threadId: "t1", tool: "ex_counter_increment", args: { by: 1 }, result: result(2) },
      T0 + 20,
    );
    const claim = (callId: string) =>
      claimServedAppToolResult(
        { threadId: "t1", tool: "ex_counter_increment", args: { by: 1 }, callId, startedAt: T0 },
        T0 + 30,
      );

    expect(claim("first")).toStrictEqual(result(1));
    expect(claim("second")).toStrictEqual(result(2));
  });

  it("never fills a call from a result served before the agent announced it", () => {
    // A result the provider already reported (another provider on this thread, say) stays unclaimed.
    recordServedAppToolResult(
      { threadId: "t1", tool: "ex_counter_increment", args: { by: 1 }, result: result(1) },
      T0,
    );

    expect(
      claimServedAppToolResult(
        {
          threadId: "t1",
          tool: "ex_counter_increment",
          args: { by: 1 },
          callId: "later",
          startedAt: T0 + 60_000,
        },
        T0 + 60_100,
      ),
    ).toBeUndefined();
  });

  it("keeps other threads' and tools' results apart", () => {
    recordServedAppToolResult({ threadId: "t1", tool: "ex_a", args: {}, result: "a" }, T0 + 10);
    const claim = (threadId: string, tool: string) =>
      claimServedAppToolResult(
        { threadId, tool, args: undefined, callId: `${threadId}-${tool}`, startedAt: T0 },
        T0 + 20,
      );

    expect(claim("t2", "ex_a")).toBeUndefined();
    expect(claim("t1", "ex_b")).toBeUndefined();
    expect(claim("t1", "ex_a")).toBe("a");
  });

  it("forgets results after a few minutes", () => {
    recordServedAppToolResult({ threadId: "t1", tool: "ex_a", args: {}, result: "a" }, T0);

    expect(
      claimServedAppToolResult(
        { threadId: "t1", tool: "ex_a", args: {}, callId: "c", startedAt: T0 },
        T0 + 10 * 60_000,
      ),
    ).toBeUndefined();
  });
});
