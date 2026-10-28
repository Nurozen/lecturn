import { isProviderDriverKind } from "@lecturn/contracts";
import { acpRegistryClient } from "@lecturn/provider-acp-registry/client";
import { makeProviderClientRegistry, type ProviderIcon } from "@lecturn/provider-core/client";
import { cursorClient } from "@lecturn/provider-cursor/client";
import { grokClient } from "@lecturn/provider-grok/client";
import { museClient } from "@lecturn/provider-muse/client";
import { openCodeClient } from "@lecturn/provider-opencode/client";
import { piClient } from "@lecturn/provider-pi/client";
import { SCRIPTED_PROVIDER_EMBLEM } from "@lecturn/shared/providerEmblems";

const providerClients = makeProviderClientRegistry([
  cursorClient,
  grokClient,
  museClient,
  openCodeClient,
  piClient,
  acpRegistryClient,
]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}

/**
 * The scripted driver runs only under LECTURN_TEST_PROVIDERS, so it has an icon here but no
 * registry entry.
 */
export function getProviderIcon(driver: string | null | undefined): ProviderIcon | undefined {
  return driver === "scripted" ? SCRIPTED_PROVIDER_EMBLEM : getProviderClient(driver)?.icon;
}
