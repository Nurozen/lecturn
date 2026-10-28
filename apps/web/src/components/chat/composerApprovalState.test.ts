import { AppId, RuntimeRequestId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PendingApproval } from "../../session-logic";
import {
  APP_TOOL_APPROVAL_SEND_BLOCK_REASON,
  appApprovalReasonLine,
  appApprovalTestId,
  approvalReplacesComposer,
  approvalSendBlockReason,
} from "./composerApprovalState";

const providerApproval: PendingApproval = {
  requestId: RuntimeRequestId.make("approval-1"),
  requestKind: "command",
  createdAt: "2026-10-25T00:00:00.000Z",
  detail: "rm -rf build",
  responseCapability: "live",
};

const appApproval = (reason: string | null, source: "static" | "app"): PendingApproval => ({
  ...providerApproval,
  requestKind: "permission",
  connectedAppTool: {
    appId: AppId.make("dev.rocketwright"),
    appName: "RocketWright",
    toolName: "rw_simulate",
    reason,
    source,
  },
});

describe("composer approval state", () => {
  it("leaves the composer alone with nothing pending", () => {
    expect(approvalReplacesComposer(null)).toBe(false);
    expect(approvalSendBlockReason(null)).toBeNull();
    expect(appApprovalTestId(null, "card")).toBeUndefined();
  });

  it("lets a provider approval take over the composer without its own send reason", () => {
    expect(approvalReplacesComposer(providerApproval)).toBe(true);
    expect(approvalSendBlockReason(providerApproval)).toBeNull();
    expect(appApprovalTestId(providerApproval, "card")).toBeUndefined();
    expect(appApprovalTestId(providerApproval, "more")).toBeUndefined();
  });

  it("keeps the composer live under an app tool approval but blocks send with a reason", () => {
    const approval = appApproval("Monte Carlo 500 samples > 100", "app");
    expect(approvalReplacesComposer(approval)).toBe(false);
    expect(approvalSendBlockReason(approval)).toBe(APP_TOOL_APPROVAL_SEND_BLOCK_REASON);
  });

  it("gives test ids to the app approval card's parts only", () => {
    const approval = appApproval(null, "static");
    expect(appApprovalTestId(approval, "card")).toBe("app-approval-card");
    expect(appApprovalTestId(approval, "icon")).toBe("app-approval-icon");
    expect(appApprovalTestId(approval, "more")).toBe("app-approval-more");
  });

  it("shows the app's reason line and none for a static gate", () => {
    expect(appApprovalReasonLine(appApproval("  Monte Carlo 500 samples > 100 ", "app"))).toBe(
      "Monte Carlo 500 samples > 100",
    );
    expect(appApprovalReasonLine(appApproval(null, "static"))).toBeNull();
    expect(appApprovalReasonLine(appApproval("   ", "app"))).toBeNull();
    expect(appApprovalReasonLine(providerApproval)).toBeNull();
  });
});
