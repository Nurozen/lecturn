import { describe, expect, it } from "vite-plus/test";
import { accountTintColor } from "@lecturn/shared/accountTint";
import { mobileAccountSurfaceColor } from "./accountTint";

describe("mobile account decoration", () => {
  const accounts = [
    { accountId: "work", preset: "jade" },
    { accountId: "personal", preset: "violet" },
  ];
  it("follows the environment owner, independently of account ordering", () => {
    expect(mobileAccountSurfaceColor("personal", accounts)).toBe(accountTintColor("violet"));
    expect(mobileAccountSurfaceColor("work", [...accounts].reverse())).toBe(
      accountTintColor("jade"),
    );
  });
  it("does not assign another signed-in account to local or unknown-owner surfaces", () => {
    expect(mobileAccountSurfaceColor(undefined, accounts)).toBeUndefined();
    expect(mobileAccountSurfaceColor("removed", accounts)).toBeUndefined();
    expect(mobileAccountSurfaceColor("work", [])).toBeUndefined();
  });
  it("updates decorative color with the owner's appearance", () => {
    expect(mobileAccountSurfaceColor("work", [{ accountId: "work", preset: "cyan" }])).toBe(
      accountTintColor("cyan"),
    );
  });
});
