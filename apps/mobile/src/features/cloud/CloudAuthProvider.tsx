import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { setManagedRelaySession } from "@lecturn/client-runtime/relay";
import type { ReactNode } from "react";
import { appAtomRegistry } from "../../state/atom-registry";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";
import { MultiAccountCloudAuthBridge } from "./MultiAccountCloudAuthBridge";
import { resolveCloudPublicConfig } from "./publicConfig";

export function deactivateCloudRelayAccount(): void {
  setAgentAwarenessRelayTokenProvider(null);
  setManagedRelaySession(appAtomRegistry, null);
}

const cloudConfig = resolveCloudPublicConfig();
// Build-time constant: null when this build has no cloud config.
const publishableKey = cloudConfig.relay.url ? cloudConfig.clerk.publishableKey : null;

if (!publishableKey) {
  // Without cloud config no account can ever activate, so drop anything a
  // previous build with cloud enabled left registered.
  deactivateCloudRelayAccount();
}

// Account transitions run in MultiAccountCloudAuthBridge, which owns every signed-in session.
export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  if (!publishableKey) {
    return props.children;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <MultiAccountCloudAuthBridge>{props.children}</MultiAccountCloudAuthBridge>
    </ClerkProvider>
  );
}
