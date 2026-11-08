import { getProviderClient } from "@lecturn/client-runtime/provider-clients";
import { SCRIPTED_PROVIDER_EMBLEM } from "@lecturn/shared/providerEmblems";

type ProviderIcon = NonNullable<NonNullable<ReturnType<typeof getProviderClient>>["icon"]>;

/**
 * The scripted driver runs only under LECTURN_TEST_PROVIDERS, so it has an icon here but no
 * registry entry.
 */
export function getProviderIcon(driver: string | null | undefined): ProviderIcon | undefined {
  return driver === "scripted" ? SCRIPTED_PROVIDER_EMBLEM : getProviderClient(driver)?.icon;
}
