import { EnvironmentId } from "@lecturn/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { readStaveWizardState, resetStaveWizardForTests } from "../staveWizard";
import { CommandPalette } from "./CommandPalette";

const ENVIRONMENT_ID = EnvironmentId.make("environment-stave");

// One connected environment, the usual case, so "Add project" goes straight to its sources.
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: () =>
    ({
      isReady: true,
      networkStatus: "online",
      presentationById: new Map(),
      environments: [
        {
          environmentId: ENVIRONMENT_ID,
          label: "Local",
          entry: { target: { _tag: "PrimaryConnectionTarget" } },
          connection: { phase: "connected", error: null, traceId: null },
          serverConfig: null,
        },
      ],
    }) as never,
}));

// Stave is available on that environment only, as `stave.status` reports per environment.
vi.mock(import("../state/stave"), async (original) => ({
  ...(await original()),
  useStaveFeatureAvailable: (environmentId) =>
    ({
      supported: environmentId === ENVIRONMENT_ID,
      available: environmentId === ENVIRONMENT_ID,
      status: { data: null, error: null, isPending: false },
    }) as never,
}));

function setup() {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  resetStaveWizardForTests();
  const stack = new DisposableStack();
  stack.defer(resetStaveWizardForTests);
  return stack;
}

describe("CommandPalette add-project intent", () => {
  it("offers the Stave sources and opens the Stave wizard", async () => {
    using _setup = setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "add-project" });

    await expect.element(page.getByRole("option", { name: /Local folder/ })).toBeVisible();
    const space = page.getByRole("option", { name: /New Stave space/ });
    await expect.element(space).toBeVisible();
    await expect.element(page.getByRole("option", { name: /New Stave saga/ })).toBeVisible();

    await act(() => space.element().dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await expect
      .poll(() => readStaveWizardState())
      .toEqual({ status: "open", request: { environmentId: ENVIRONMENT_ID, kind: "space" } });
  });
});
