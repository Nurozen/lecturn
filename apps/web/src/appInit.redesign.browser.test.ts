import { DEFAULT_CLIENT_SETTINGS } from "@lecturn/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { startClientAppearance } from "./appInit";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  persistClientSettingsPatch,
} from "./hooks/useSettings";

const keepInMemory = async () => {};

function clientAppearance(): Disposable {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const stop = startClientAppearance();
  return {
    [Symbol.dispose]: () => {
      stop();
      __resetClientSettingsPersistenceForTests();
      document.documentElement.removeAttribute("data-redesign");
    },
  };
}

describe("new design toggle", () => {
  it("keeps the Lecturn look by default and switches data-redesign with the Beta setting", async () => {
    const root = document.documentElement;
    expect(DEFAULT_CLIENT_SETTINGS.redesignEnabled).toBe(false);
    using _appearance = clientAppearance();
    expect(root.hasAttribute("data-redesign")).toBe(false);
    await persistClientSettingsPatch({ redesignEnabled: true }, keepInMemory);
    expect(root.hasAttribute("data-redesign")).toBe(true);
    await persistClientSettingsPatch({ redesignEnabled: false }, keepInMemory);
    expect(root.hasAttribute("data-redesign")).toBe(false);
  });
});
