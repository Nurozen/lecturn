import { describe, expect, it } from "vite-plus/test";

import { extractClaudeSubagentSessionEvent } from "./claudeAcp.ts";

describe("extractClaudeSubagentSessionEvent", () => {
  it("reads subagent state from effect-acp unknown session updates", () => {
    expect(
      extractClaudeSubagentSessionEvent({
        sessionId: "parent",
        update: {
          sessionUpdate: "_lecturn_unknown",
          originalSessionUpdate: "subagent_update",
          raw: { sessionId: "child", state: { state: "idle", stopReason: "end_turn" } },
        },
      }),
    ).toEqual({
      type: "state",
      childSessionId: "child",
      parentSessionId: "parent",
      status: "completed",
      result: null,
    });
  });
});
