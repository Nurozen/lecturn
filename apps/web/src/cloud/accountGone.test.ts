import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../connection/catalog", () => ({ environmentCatalog: {} }));

import { resolveAccountGone, withSignedOutAccount } from "./accountGone";

describe("withSignedOutAccount", () => {
  it("records only the environments the leaving account owns, next to earlier ones", () => {
    const current = new Map([["environment-z", { accountId: "account-z", email: null }]]);
    const next = withSignedOutAccount({
      current,
      accountId: "account-b",
      email: "b@example.com",
      accountByEnvironmentId: new Map([
        ["environment-a", "account-a"],
        ["environment-b", "account-b"],
      ]),
    });
    expect([...next.keys()]).toEqual(["environment-z", "environment-b"]);
    expect(next.get("environment-b")).toEqual({ accountId: "account-b", email: "b@example.com" });
  });
});

describe("resolveAccountGone", () => {
  const signedOutEnvironments = new Map([
    ["environment-b", { accountId: "account-b", email: "b@example.com" }],
  ]);
  const base = {
    environmentId: "environment-b",
    signedOutEnvironments,
    environmentInCatalog: false,
  };

  it("names the signed-out account behind a removed environment", () => {
    expect(resolveAccountGone(base)?.email).toBe("b@example.com");
  });

  it("stays quiet while the environment is in the catalog, and for any other environment", () => {
    // A failed cleanup, or the account signed in again.
    expect(resolveAccountGone({ ...base, environmentInCatalog: true })).toBeNull();
    expect(resolveAccountGone({ ...base, environmentId: "environment-a" })).toBeNull();
    expect(resolveAccountGone({ ...base, environmentId: null })).toBeNull();
  });
});
