import { EnvironmentId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mobileAccountAdditionAllowed,
  resolveAutoSettleReferenceEnvironmentId,
} from "./SettingsRouteScreen.logic";

describe("resolveAutoSettleReferenceEnvironmentId", () => {
  const firstId = EnvironmentId.make("first");
  const secondId = EnvironmentId.make("second");

  it("waits for an earlier grant before exposing a later writable reference", () => {
    const second = { environmentId: secondId, canWriteSettings: true };
    expect(
      resolveAutoSettleReferenceEnvironmentId([
        { environmentId: firstId, canWriteSettings: null },
        second,
      ]),
    ).toBeNull();
    expect(
      resolveAutoSettleReferenceEnvironmentId([
        { environmentId: firstId, canWriteSettings: false },
        second,
      ]),
    ).toBe(secondId);
    expect(
      resolveAutoSettleReferenceEnvironmentId([
        { environmentId: firstId, canWriteSettings: true },
        second,
      ]),
    ).toBe(firstId);
  });

  it("waits before showing a read-only fallback until all grants are resolved", () => {
    expect(
      resolveAutoSettleReferenceEnvironmentId([
        { environmentId: firstId, canWriteSettings: false },
        { environmentId: secondId, canWriteSettings: null },
      ]),
    ).toBeNull();
    expect(
      resolveAutoSettleReferenceEnvironmentId([
        { environmentId: firstId, canWriteSettings: false },
        { environmentId: secondId, canWriteSettings: false },
      ]),
    ).toBe(firstId);
  });
});

describe("mobile add-account gate", () => {
  const base = {
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
    expect(mobileAccountAdditionAllowed({ ...base, loaded: false, accountCount: 0 })).toBe(false);
    expect(
      mobileAccountAdditionAllowed({ ...base, platform: "android", sharedGateAvailable: false }),
    ).toBe(false);
    expect(
      mobileAccountAdditionAllowed({ ...base, platform: "android", catalogReady: false }),
    ).toBe(false);
  });
});
