import { EnvironmentId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  areOnboardingComputersReady,
  reconcileOnboardingComputers,
} from "./computerSelection.logic";

const localId = EnvironmentId.make("local");
const relayId = EnvironmentId.make("expired-account-computer");
const pendingId = EnvironmentId.make("registering-computer");
const local = { environmentId: localId, connection: { phase: "connected" } };
const relay = { environmentId: relayId, connection: { phase: "available" } };

describe("onboarding computer selection", () => {
  it("requires selected saved computers to connect and becomes ready after deselecting one", () => {
    const catalog = new Set([localId, relayId]);
    const selected = reconcileOnboardingComputers(new Set(), catalog, new Set(), new Set());
    expect(selected).toEqual(catalog);
    expect(areOnboardingComputersReady(selected, [local, relay])).toBe(false);
    expect(
      areOnboardingComputersReady(selected, [
        local,
        { ...relay, connection: { phase: "connected" } },
      ]),
    ).toBe(true);
    const deselected = new Set([localId]);
    expect(reconcileOnboardingComputers(deselected, catalog, catalog, catalog)).toBe(deselected);
    expect(areOnboardingComputersReady(deselected, [local, relay])).toBe(true);
    expect(areOnboardingComputersReady(new Set(), [local, relay])).toBe(false);
    expect(areOnboardingComputersReady(new Set([pendingId]), [local, relay])).toBe(false);
  });

  it("removes vanished catalog IDs while retaining discoveries being registered", () => {
    const previous = new Set([localId, relayId]);
    const current = new Set([localId]);
    const selected = reconcileOnboardingComputers(
      new Set([localId, relayId, pendingId]),
      current,
      previous,
      previous,
    );
    expect(selected).toEqual(new Set([localId, pendingId]));
    expect(areOnboardingComputersReady(selected, [local])).toBe(false);
    expect(
      reconcileOnboardingComputers(new Set([localId, relayId]), current, previous, previous),
    ).toEqual(current);
    expect(areOnboardingComputersReady(current, [local])).toBe(true);
  });

  it("preserves deselection after removal, rediscovery and registration while adding unseen computers", () => {
    const seen = new Set([localId, relayId, pendingId]);
    const restoredCatalog = new Set([localId, relayId, pendingId]);
    const deselected = new Set([localId]);
    expect(
      reconcileOnboardingComputers(deselected, restoredCatalog, new Set([localId]), seen),
    ).toBe(deselected);
    const newId = EnvironmentId.make("another-computer");
    expect(
      reconcileOnboardingComputers(
        deselected,
        new Set([...restoredCatalog, newId]),
        restoredCatalog,
        seen,
      ),
    ).toEqual(new Set([localId, newId]));
  });
});
