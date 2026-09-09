import { describe, expect, it } from "vite-plus/test";
import { parseBillingConfig } from "./BillingConfig.ts";
import { parseManagedGatewayConfig } from "./ManagedGatewayConfig.ts";
const disabled = parseBillingConfig({});
const sandbox = {
  ...disabled,
  mode: "observe" as const,
  managedAccessEnabled: true,
  enforcementUsers: ["user_owner"],
};
const live = { ...sandbox, mode: "enforce" as const, livemode: true };
const proven = {
  MANAGED_GATEWAY_ENABLED: "true",
  MANAGED_GATEWAY_ORIGIN_GUARD_VERIFIED: "true",
  MANAGED_GATEWAY_ROUTE_VERIFIED: "true",
};
describe("managed gateway deployment gates", () => {
  it("defaults off for ordinary observation and disabled billing", () => {
    for (const billing of [disabled, { ...disabled, mode: "observe" as const }]) {
      expect(parseManagedGatewayConfig({}, billing, "prod").enabled).toBe(false);
    }
  });
  it("accepts an explicitly reviewed sandbox and production cohort with both proofs", () => {
    expect(parseManagedGatewayConfig(proven, sandbox, "stripe-sandbox").enabled).toBe(true);
    expect(parseManagedGatewayConfig(proven, live, "prod").enabled).toBe(true);
  });
  it("rejects production enforcement without a gateway and rejects either missing proof", () => {
    expect(() => parseManagedGatewayConfig({}, live, "prod")).toThrow("verified managed gateway");
    for (const name of [
      "MANAGED_GATEWAY_ORIGIN_GUARD_VERIFIED",
      "MANAGED_GATEWAY_ROUTE_VERIFIED",
    ]) {
      expect(() => parseManagedGatewayConfig({ ...proven, [name]: "false" }, live, "prod")).toThrow(
        "verified origin blocking",
      );
    }
  });
  it("rejects missing admission checks, cohorts and cross-stage credentials", () => {
    expect(() => parseManagedGatewayConfig(proven, disabled, "stripe-sandbox")).toThrow(
      "managed-access",
    );
    expect(() =>
      parseManagedGatewayConfig(proven, { ...sandbox, enforcementUsers: [] }, "stripe-sandbox"),
    ).toThrow("reviewed");
    expect(() =>
      parseManagedGatewayConfig(
        proven,
        { ...sandbox, enforcementUsers: ["owner@example.com"] },
        "stripe-sandbox",
      ),
    ).toThrow("reviewed");
    expect(() => parseManagedGatewayConfig(proven, live, "stripe-sandbox")).toThrow("must match");
    expect(() => parseManagedGatewayConfig(proven, sandbox, "prod")).toThrow("must match");
  });
  it("rejects stages that would truncate gateway origin hostnames", () => {
    expect(() => parseManagedGatewayConfig(proven, sandbox, "a".repeat(37))).toThrow("at most 36");
  });
  it("rejects ambiguous boolean values even while disabled", () => {
    expect(() =>
      parseManagedGatewayConfig({ MANAGED_GATEWAY_ENABLED: "1" }, disabled, "prod"),
    ).toThrow("true or false");
  });
});
