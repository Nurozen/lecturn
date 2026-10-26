import { AppId, RuntimeRequestId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pendingApprovalCardText } from "./pendingApprovalCardText";

const appApproval = {
  requestId: RuntimeRequestId.make("approval-1"),
  requestKind: "permission",
  createdAt: "2026-10-25T00:00:00.000Z",
  responseCapability: "live",
  detail: "Approve rw_engine_simulate · Simulates 120 s of burn",
  connectedAppTool: {
    appId: AppId.make("dev.rocketwright.app"),
    appName: "RocketWright",
    toolName: "rw_engine_simulate",
    reason: " Simulates 120 s of burn ",
    source: "app",
  },
} as const;

describe("pendingApprovalCardText", () => {
  it("names an app tool by its declared title", () => {
    expect(
      pendingApprovalCardText({
        ...appApproval,
        connectedAppTool: { ...appApproval.connectedAppTool, toolTitle: "Simulate engine" },
      }),
    ).toEqual({
      eyebrow: "RocketWright · Approval needed",
      title: "Approve Simulate engine",
      detail: "Simulates 120 s of burn",
      monoDetail: true,
    });
  });

  it("falls back to the called name when the tool declares no title", () => {
    expect(pendingApprovalCardText(appApproval).title).toBe("Approve rw_engine_simulate");
  });

  it("keeps the provider's prompt for other approvals", () => {
    expect(
      pendingApprovalCardText({
        requestKind: "command",
        detail: "Run vp test",
      }),
    ).toEqual({
      eyebrow: "Approval needed",
      title: "command",
      detail: "Run vp test",
      monoDetail: false,
    });
  });
});
