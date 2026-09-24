import { describe, expect, it } from "vite-plus/test";
import { relayHealthLabel, relayHealthStatus } from "./RelaySettings.logic";

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

describe("relay health indicator", () => {
  it("never shows healthy green from stale online discovery", () => {
    const online = { ...linked, availability: "online" as const };
    expect(relayHealthStatus(online).tone).toBe("online");
    expect(relayHealthStatus({ ...online, checking: true }).tone).toBe("checking");
    expect(relayHealthStatus({ ...online, offline: true }).tone).toBe("offline");
    expect(relayHealthStatus({ ...online, linked: false }).tone).toBe("inactive");
    expect(relayHealthStatus({ ...online, managedTunnel: false }).tone).toBe("inactive");
    expect(relayHealthStatus({ ...online, error: "Unauthorized" }).tone).toBe("error");
    expect(relayHealthStatus({ ...online, deviceRelayConflict: "In use" }).tone).toBe("error");
  });
  it("distinguishes unknown health from an offline or checking environment", () => {
    expect(relayHealthStatus(linked).tone).toBe("inactive");
    expect(relayHealthStatus({ ...linked, availability: "checking" }).tone).toBe("checking");
    expect(relayHealthStatus({ ...linked, availability: "offline" }).tone).toBe("offline");
    expect(relayHealthStatus({ ...linked, availability: "error" }).tone).toBe("error");
  });
});
