import { isProviderDriverKind } from "@lecturn/contracts";
import { makeProviderClientRegistry } from "@lecturn/provider-core/client";
import { museClient } from "@lecturn/provider-muse/client";
import { piClient } from "@lecturn/provider-pi/client";

/** The provider client definitions this mobile build ships. */
const providerClients = makeProviderClientRegistry([museClient, piClient]);

/** The client definition for a driver kind, or `undefined` for drivers drawn by hand. */
export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}
