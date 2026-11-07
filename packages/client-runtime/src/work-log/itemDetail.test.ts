import { ThreadId, TurnItemId } from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { turnItemOutputText } from "./itemDetail.ts";

const screenshot = {
  id: TurnItemId.make("tool-screenshot"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "mcp__lecturn__device_screenshot",
  input: { deviceId: "phone" },
  output: {
    content: [
      { type: "text", text: "Captured the home screen." },
      { type: "image", mimeType: "image/png" },
    ],
  },
  startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
};

describe("tool output text", () => {
  it("reads an app result's text, not the summary Lecturn keeps beside it", () => {
    const content = [{ type: "text", text: '{"status":"clean"}' }];
    const _meta = { "lecturn/summary": "Clean" };
    for (const output of [
      { content, _meta },
      { content, structuredContent: { status: "clean" }, _meta },
    ]) {
      expect(turnItemOutputText({ ...screenshot, output })).toBe('{\n  "status": "clean"\n}');
    }
  });
});
