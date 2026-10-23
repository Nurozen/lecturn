import { isProviderDriverKind } from "@lecturn/contracts";
import { acpRegistryClient } from "@lecturn/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@lecturn/provider-core/client";
import { cursorClient } from "@lecturn/provider-cursor/client";
import { grokClient } from "@lecturn/provider-grok/client";
import { museClient } from "@lecturn/provider-muse/client";
import { openCodeClient } from "@lecturn/provider-opencode/client";
import { piClient } from "@lecturn/provider-pi/client";

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
