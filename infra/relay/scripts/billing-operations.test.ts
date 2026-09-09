import { describe, expect, it } from "@effect/vitest";
import { parseBillingOperation } from "./billing-operations.ts";

describe("billing operator command", () => {
  it("defaults to read-only status", () => {
    expect(parseBillingOperation([])).toEqual({ command: "status" });
    expect(parseBillingOperation(["status"])).toEqual({ command: "status" });
  });
  it("requires an explicit target and audit reason for replay", () => {
    expect(
      parseBillingOperation(["replay", "evt_123", "--reason", "Retry after provider recovery"]),
    ).toEqual({ command: "replay", eventId: "evt_123", reason: "Retry after provider recovery" });
    for (const args of [
      ["replay", "evt_123"],
      ["replay", "--reason", "Long enough reason"],
      ["replay", "evt_123", "--reason", "short"],
    ])
      expect(() => parseBillingOperation(args)).toThrow();
  });
  it("does not accept accidental destructive or unknown flags", () => {
    for (const args of [
      ["delete"],
      ["status", "--write"],
      ["prune", "--reason", "Maintenance run", "--all"],
    ])
      expect(() => parseBillingOperation(args)).toThrow();
    expect(parseBillingOperation(["prune", "--reason", "Maintenance run"]).command).toBe("prune");
  });
});

it("requires an explicit suspension direction and audit reason", () => {
  expect(
    parseBillingOperation(["suspension-control", "off", "--reason", "Emergency rollback"]),
  ).toEqual({ command: "suspension-control", enabled: false, reason: "Emergency rollback" });
  expect(() => parseBillingOperation(["suspension-control", "on"])).toThrow();
  expect(() =>
    parseBillingOperation(["suspension-control", "yes", "--reason", "Emergency rollback"]),
  ).toThrow();
});

it("keeps inventory read-only and grant retries tied to explicit timestamps and operation IDs", () => {
  expect(parseBillingOperation(["inventory"])).toEqual({ command: "inventory", after: "" });
  const args = [
    "grant",
    "user_123",
    "--id",
    "transition-123",
    "--operator",
    "Justin",
    "--reason",
    "Reviewed transition cohort",
    "--start",
    "1800000000",
  ];
  expect(parseBillingOperation(args)).toMatchObject({
    command: "grant",
    start: 1800000000,
    end: 1802592000,
    limit: 3,
  });
  expect(() => parseBillingOperation(args.slice(0, -2))).toThrow();
  expect(() => parseBillingOperation([...args, "--limit", "2"])).toThrow();
  expect(() => parseBillingOperation([...args, "--id", "another"])).toThrow();
  expect(
    parseBillingOperation([
      "revoke-grant",
      "user_123",
      "--id",
      "revoke-123",
      "--grant-id",
      "transition-123",
      "--operator",
      "Justin",
      "--reason",
      "Customer requested revoke",
    ]),
  ).toMatchObject({ command: "revoke-grant", grantId: "transition-123" });
});

it("lists pending payment reviews read-only and requires a documented operator resolution", () => {
  expect(parseBillingOperation(["payment-reviews"])).toEqual({ command: "payment-reviews" });
  expect(
    parseBillingOperation([
      "resolve-review",
      "--invoice",
      "in_123",
      "--operator",
      "Justin",
      "--reason",
      "Provider refund confirmed",
    ]),
  ).toEqual({
    command: "resolve-review",
    invoiceId: "in_123",
    operator: "Justin",
    reason: "Provider refund confirmed",
  });
  expect(() => parseBillingOperation(["resolve-review", "--invoice", "in_123"])).toThrow();
});
