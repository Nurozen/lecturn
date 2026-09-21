import { describe, expect, it } from "vite-plus/test";
import { rejectedMobileAccountIds } from "./mobileAccountAdmission";
const base = {
  knownAccountIds: ["a"],
  observedAccountIds: ["a", "b"],
  platform: "ios",
  multiAccountPush: true,
  clerkSingleSessionMode: false,
  targets: [],
  unlistedRelayEnvironmentIds: new Set<string>(),
} as const;
describe("native account admission", () => {
  it("rejects native profile additions above five including expired known accounts", () => {
    expect([
      ...rejectedMobileAccountIds({
        ...base,
        knownAccountIds: ["a", "b", "c", "d", "e"],
        observedAccountIds: ["a", "f", "e"],
      }),
    ]).toEqual(["f"]);
  });
  it("preserves existing and returning accounts when push capability is unavailable", () => {
    expect([
      ...rejectedMobileAccountIds({
        ...base,
        knownAccountIds: ["a", "b"],
        observedAccountIds: ["b", "c", "a"],
        multiAccountPush: false,
      }),
    ]).toEqual(["c"]);
  });
  it("admits first sign-in without capability and rejects a second", () => {
    expect([
      ...rejectedMobileAccountIds({ ...base, knownAccountIds: [], multiAccountPush: false }),
    ]).toEqual(["b"]);
  });
  it("enforces sign-in configuration but admits supported additions", () => {
    expect([...rejectedMobileAccountIds({ ...base, clerkSingleSessionMode: true })]).toEqual(["b"]);
    expect([...rejectedMobileAccountIds(base)]).toEqual([]);
  });
});
