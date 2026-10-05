import { OrchestrationDispatchCommandError } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadImportFailureReason, wasBootstrapThreadDeleted } from "./orchestration.ts";

describe("wasBootstrapThreadDeleted", () => {
  it("accepts only a confirmed deleted bootstrap thread", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(true);
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({ message: "Failed to create worktree." }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadDeleted(new Error("connection lost"))).toBe(false);
  });
});

describe("threadImportFailureReason", () => {
  it("reads the import reason off a dispatch error and nothing else", () => {
    expect(
      threadImportFailureReason(
        new OrchestrationDispatchCommandError({
          message: "Failed to import session.",
          threadImportFailure: "session-not-found",
        }),
      ),
    ).toBe("session-not-found");
    expect(
      threadImportFailureReason(
        new OrchestrationDispatchCommandError({ message: "Failed to import session." }),
      ),
    ).toBeNull();
    expect(threadImportFailureReason(new Error("connection lost"))).toBeNull();
  });
});
