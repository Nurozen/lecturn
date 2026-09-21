import { describe, expect, it } from "vite-plus/test";

import {
  mobileAccountAdditionAllowed,
  resolveAgentAwarenessPlatformPresentation,
} from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("explains that agent awareness settings are unavailable on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: false,
      subtitle: "iOS only",
    });
  });

  it("leaves supported iOS settings unchanged", () => {
    expect(resolveAgentAwarenessPlatformPresentation("ios")).toEqual({
      supported: true,
      subtitle: undefined,
    });
  });
});

describe("mobile add-account gate", () => {
  const base = {
    enabled: true,
    loaded: true,
    accountCount: 1,
    sharedGateAvailable: true,
    catalogReady: true,
    platform: "ios",
    multiAccountPush: false,
  };
  it("keeps first sign-in usable without relay multi-account push", () => {
    expect(
      mobileAccountAdditionAllowed({ ...base, accountCount: 0, sharedGateAvailable: false }),
    ).toBe(true);
  });
  it("requires push fan-out only for additional iOS accounts", () => {
    expect(mobileAccountAdditionAllowed(base)).toBe(false);
    expect(mobileAccountAdditionAllowed({ ...base, multiAccountPush: true })).toBe(true);
    expect(mobileAccountAdditionAllowed({ ...base, platform: "android" })).toBe(true);
  });
  it("honors the build, Clerk, ownership, and loading gates", () => {
    expect(mobileAccountAdditionAllowed({ ...base, enabled: false, accountCount: 0 })).toBe(false);
    expect(mobileAccountAdditionAllowed({ ...base, loaded: false, accountCount: 0 })).toBe(false);
    expect(
      mobileAccountAdditionAllowed({ ...base, platform: "android", sharedGateAvailable: false }),
    ).toBe(false);
    expect(
      mobileAccountAdditionAllowed({ ...base, platform: "android", catalogReady: false }),
    ).toBe(false);
  });
});
