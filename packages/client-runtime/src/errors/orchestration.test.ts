import {
  CommandId,
  OrchestrationDispatchCommandError,
  OrchestrationV2DispatchCommandError,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadImportFailureReason } from "./orchestration.ts";

describe("threadImportFailureReason", () => {
  it("reads the import reason off a V2 dispatch error and nothing else", () => {
    const failed = {
      commandId: CommandId.make("import-command"),
      commandType: "thread.import",
      message: "Failed to import session.",
    };
    expect(
      threadImportFailureReason(
        new OrchestrationV2DispatchCommandError({
          ...failed,
          threadImportFailure: "session-not-found",
        }),
      ),
    ).toBe("session-not-found");
    expect(threadImportFailureReason(new OrchestrationV2DispatchCommandError(failed))).toBeNull();
    expect(
      threadImportFailureReason(
        new OrchestrationDispatchCommandError({ message: "Failed to import session." }),
      ),
    ).toBeNull();
    expect(threadImportFailureReason(new Error("connection lost"))).toBeNull();
  });
});
