import { describe, expect, it } from "vite-plus/test";
import { relayHealthLabel } from "./RelaySettings.logic";

const linked = { linked: true, managedTunnel: true, checking: false, offline: false } as const;
describe("relayHealthLabel", () => {
  it("shows a device lease conflict even when stale discovery says online", () => {
    expect(
      relayHealthLabel({
        ...linked,
        availability: "online",
        deviceRelayConflict: "Another installation holds this device relay",
      }),
    ).toBe("Relay in use by another installation");
    expect(
      relayHealthLabel({
        ...linked,
        linked: false,
        deviceRelayConflict: "Another installation holds this device relay",
      }),
    ).toBe("Relay in use by another installation");
  });
  it("does not mistake a configured link for online health", () => {
    expect(relayHealthLabel(linked)).toContain("sign in");
    expect(relayHealthLabel({ ...linked, availability: "online" })).toContain("Online");
    expect(relayHealthLabel({ ...linked, availability: "offline" })).toContain("Offline");
  });
  it("does not show stale online status during refresh or client outage", () => {
    expect(relayHealthLabel({ ...linked, availability: "online", checking: true })).toContain(
      "Checking",
    );
    expect(relayHealthLabel({ ...linked, availability: "online", offline: true })).toContain(
      "client is offline",
    );
    expect(relayHealthLabel({ ...linked, availability: "online", error: "Unauthorized" })).toBe(
      "Unauthorized",
    );
  });
  it("distinguishes activity-only publishing and unlinking from a failed relay", () => {
    expect(relayHealthLabel({ ...linked, managedTunnel: false })).toContain(
      "Activity publishing only",
    );
    expect(relayHealthLabel({ ...linked, linked: false })).toBe("Not linked");
  });
});
