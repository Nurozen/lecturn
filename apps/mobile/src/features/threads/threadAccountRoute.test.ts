import { describe, expect, it } from "vite-plus/test";
import { resolveThreadAccountRoute } from "./threadAccountRoute";
const base = {
  catalogReady: true,
  accountsReady: true,
  target: { _tag: "RelayConnectionTarget", accountId: "a" },
  accounts: [
    { accountId: "a", signedIn: true },
    { accountId: "b", signedIn: true },
  ],
};
describe("mobile thread account routes", () => {
  it("opens the owning account even when another account is active", () => {
    expect(resolveThreadAccountRoute({ ...base, requestedAccountId: "a" })).toEqual({
      kind: "ready",
      accountId: "a",
    });
  });
  it("rejects stale activity links after an environment is relinked to another account", () => {
    expect(resolveThreadAccountRoute({ ...base, requestedAccountId: "b" })).toEqual({
      kind: "unavailable",
    });
  });
  it("requires sign-in for an expired owner and never picks another signed-in account", () => {
    expect(
      resolveThreadAccountRoute({
        ...base,
        accounts: [
          { accountId: "a", signedIn: false },
          { accountId: "b", signedIn: true },
        ],
      }),
    ).toEqual({ kind: "sign-in", accountId: "a" });
  });
  it("waits for account hydration and rejects unknown or unowned relay targets", () => {
    expect(resolveThreadAccountRoute({ ...base, accountsReady: false })).toEqual({
      kind: "loading",
    });
    expect(resolveThreadAccountRoute({ ...base, target: undefined })).toEqual({
      kind: "unavailable",
    });
    expect(
      resolveThreadAccountRoute({
        ...base,
        target: { _tag: "RelayConnectionTarget", accountId: undefined },
      }),
    ).toEqual({ kind: "unavailable" });
  });
  it("keeps direct connections usable without a cloud session", () => {
    expect(
      resolveThreadAccountRoute({
        ...base,
        accountsReady: false,
        target: { _tag: "BearerConnectionTarget", accountId: undefined },
        accounts: [],
      }),
    ).toEqual({ kind: "ready", accountId: null });
  });
});
