import { ProviderDriverKind } from "@lecturn/contracts";
import { providerClients } from "@lecturn/client-runtime/provider-clients";
import type { ProviderIcon } from "@lecturn/provider-core/client";
import { SCRIPTED_PROVIDER_EMBLEM } from "@lecturn/shared/providerEmblems";

export { providerClients };

const SCRIPTED_DRIVER = ProviderDriverKind.make("scripted");

/**
 * The scripted driver runs only under LECTURN_TEST_PROVIDERS and is never offered in settings, so
 * it has an icon here but no registry entry.
 */
export function providerDriverIcon(
  driverKind: ProviderDriverKind | undefined,
): ProviderIcon | undefined {
  return driverKind === SCRIPTED_DRIVER
    ? SCRIPTED_PROVIDER_EMBLEM
    : providerClients.get(driverKind)?.icon;
}
