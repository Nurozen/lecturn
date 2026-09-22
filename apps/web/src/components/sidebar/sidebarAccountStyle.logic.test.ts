import { describe, expect, it } from "vite-plus/test";
import { sidebarOwnerForEnvironments } from "./sidebarAccountStyle.logic";

describe("sidebar ownership without account section wrappers", () => {
  const owners = new Map([
    ["relay-one", "account-one"],
    ["relay-two", "account-one"],
    ["relay-three", "account-two"],
  ]);
  it("uses an owned environment even with only one signed-in account", () => {
    expect(sidebarOwnerForEnvironments(["relay-one"], owners)).toBe("account-one");
    expect(sidebarOwnerForEnvironments(["relay-one", "relay-two"], owners)).toBe("account-one");
  });
  it("does not assign an account to local or mixed-ownership logical projects", () => {
    expect(sidebarOwnerForEnvironments(["local"], owners)).toBeUndefined();
    expect(sidebarOwnerForEnvironments(["relay-one", "local"], owners)).toBeUndefined();
    expect(sidebarOwnerForEnvironments(["relay-one", "relay-three"], owners)).toBeUndefined();
    expect(sidebarOwnerForEnvironments([], owners)).toBeUndefined();
  });
});
