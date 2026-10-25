import { ProviderDriverKind } from "@lecturn/contracts";
import { piClient } from "@lecturn/provider-pi/client";
import { SCRIPTED_PROVIDER_EMBLEM } from "@lecturn/shared/providerEmblems";
import { describe, expect, it } from "vite-plus/test";

import { providerClients, providerDriverIcon } from "./providerDriverMeta";

describe("providerDriverIcon", () => {
  it("draws the scripted test driver with its own mark instead of its initials", () => {
    const scripted = ProviderDriverKind.make("scripted");
    expect(providerDriverIcon(scripted)).toBe(SCRIPTED_PROVIDER_EMBLEM);
    expect(providerClients.definitions.map((definition) => definition.driverKind)).not.toContain(
      scripted,
    );
  });

  it("keeps package icons and leaves drivers without one to the caller's fallback", () => {
    expect(providerDriverIcon(piClient.driverKind)).toBe(piClient.icon);
    expect(providerDriverIcon(ProviderDriverKind.make("codex"))).toBeUndefined();
    expect(providerDriverIcon(undefined)).toBeUndefined();
  });
});
