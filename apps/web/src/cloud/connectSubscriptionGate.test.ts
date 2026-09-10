import { describe, expect, it } from "vite-plus/test";
import { isConnectSubscriptionRequired } from "./connectSubscriptionGate";

describe("subscription error recognition", () => {
  it("recognizes structured relay errors through transport wrappers", () => {
    expect(
      isConnectSubscriptionRequired({
        cause: { relayError: { _tag: "RelayConnectSubscriptionRequiredError" } },
      }),
    ).toBe(true);
    expect(isConnectSubscriptionRequired({ data: { code: "connect_subscription_required" } })).toBe(
      true,
    );
  });
  it("never interprets a generic forbidden or network failure as requiring purchase", () => {
    expect(isConnectSubscriptionRequired({ status: 403, message: "Forbidden" })).toBe(false);
    expect(isConnectSubscriptionRequired(new Error("Failed to fetch"))).toBe(false);
  });
  it("terminates on cyclic error wrappers", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(isConnectSubscriptionRequired(error)).toBe(false);
  });
});
