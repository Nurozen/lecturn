import { getProviderClient } from "@lecturn/client-runtime/provider-clients";
import { SCRIPTED_PROVIDER_EMBLEM } from "@lecturn/shared/providerEmblems";
import { describe, expect, it } from "vite-plus/test";

import { getProviderIcon } from "./providerClients";

describe("getProviderIcon", () => {
  it("draws the scripted test driver with its own mark", () => {
    expect(getProviderIcon("scripted")).toBe(SCRIPTED_PROVIDER_EMBLEM);
    expect(getProviderClient("scripted")).toBeUndefined();
  });

  it("keeps package icons and leaves other drivers to the fallback", () => {
    const piIcon = getProviderClient("pi")?.icon;
    expect(piIcon).toBeDefined();
    expect(getProviderIcon("pi")).toBe(piIcon);
    expect(getProviderIcon("fx")).toBe(getProviderClient("fx")?.icon);
    expect(getProviderIcon("codex")).toBeUndefined();
    expect(getProviderIcon(null)).toBeUndefined();
  });
});
