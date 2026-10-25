import { piClient } from "@lecturn/provider-pi/client";
import { SCRIPTED_PROVIDER_EMBLEM } from "@lecturn/shared/providerEmblems";
import { describe, expect, it } from "vite-plus/test";

import { getProviderClient, getProviderIcon } from "./providerClients";

describe("getProviderIcon", () => {
  it("draws the scripted test driver with its own mark", () => {
    expect(getProviderIcon("scripted")).toBe(SCRIPTED_PROVIDER_EMBLEM);
    expect(getProviderClient("scripted")).toBeUndefined();
  });

  it("keeps package icons and leaves other drivers to the fallback", () => {
    expect(getProviderIcon("pi")).toBe(piClient.icon);
    expect(getProviderIcon("codex")).toBeUndefined();
    expect(getProviderIcon(null)).toBeUndefined();
  });
});
