import { EnvironmentId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import { reconcileOnboardingComputers } from "./computerSelection.logic";

const localId = EnvironmentId.make("local");
const relayId = EnvironmentId.make("expired-account-computer");
const pendingId = EnvironmentId.make("registering-computer");

describe("onboarding computer selection", () => {
  it("selects unseen saved computers and keeps a deselection", () => {
    const catalog = new Set([localId, relayId]);
    const selected = reconcileOnboardingComputers(new Set(), catalog, new Set(), new Set());
    expect(selected).toEqual(catalog);
    const deselected = new Set([localId]);
    expect(reconcileOnboardingComputers(deselected, catalog, catalog, catalog)).toBe(deselected);
  });

  it("leaves a switched-off computer unselected when the caller marks it seen", () => {
    const catalog = new Set([localId, relayId]);
    expect(reconcileOnboardingComputers(new Set(), catalog, new Set(), new Set([relayId]))).toEqual(
      new Set([localId]),
    );
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
    expect(
      reconcileOnboardingComputers(new Set([localId, relayId]), current, previous, previous),
    ).toEqual(current);
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
