import { afterEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@lecturn/contracts";

import {
  closeStaveWizard,
  openStaveWizard,
  readStaveWizardState,
  resetStaveWizardForTests,
  subscribeStaveWizard,
} from "./staveWizard";

const environmentId = EnvironmentId.make("environment-1");

describe("staveWizard bus", () => {
  afterEach(() => {
    resetStaveWizardForTests();
  });

  it("starts closed and carries the launch request while open", () => {
    expect(readStaveWizardState()).toEqual({ status: "closed" });

    openStaveWizard({ environmentId, kind: "space" });
    expect(readStaveWizardState()).toEqual({
      status: "open",
      request: { environmentId, kind: "space" },
    });

    openStaveWizard({ environmentId, kind: "saga", saga: { root: "/work/saga" } });
    expect(readStaveWizardState()).toEqual({
      status: "open",
      request: { environmentId, kind: "saga", saga: { root: "/work/saga" } },
    });

    closeStaveWizard();
    expect(readStaveWizardState()).toEqual({ status: "closed" });
  });

  it("notifies subscribers on every transition and stops after unsubscribe", () => {
    let notified = 0;
    const unsubscribe = subscribeStaveWizard(() => {
      notified += 1;
    });

    openStaveWizard({ environmentId, kind: "space" });
    closeStaveWizard();
    closeStaveWizard();
    expect(notified).toBe(2);

    unsubscribe();
    openStaveWizard({ environmentId, kind: "space" });
    expect(notified).toBe(2);
  });
});
