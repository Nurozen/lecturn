import { describe, expect, it } from "vite-plus/test";

import { isGuestShareableThread } from "./guestShareAvailability";

describe("isGuestShareableThread", () => {
  it("offers a guest link on ordinary threads only", () => {
    const appProject = { appBinding: { appId: "dev.rocketwright.app" } };
    const squire = { squire: { squireId: "squire-1", role: "home" } };
    expect(isGuestShareableThread({}, {})).toBe(true);
    expect(isGuestShareableThread({ squire: undefined }, { appBinding: undefined })).toBe(true);
    expect(isGuestShareableThread(squire, {})).toBe(false);
    expect(isGuestShareableThread({}, appProject)).toBe(false);
    expect(isGuestShareableThread(squire, appProject)).toBe(false);
  });
});
