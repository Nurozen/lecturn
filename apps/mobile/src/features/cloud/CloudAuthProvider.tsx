import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { setManagedRelaySession } from "@lecturn/client-runtime/relay";
import { type ReactNode, useEffect } from "react";
import { appAtomRegistry } from "../../state/atom-registry";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";
import { MultiAccountCloudAuthBridge } from "./MultiAccountCloudAuthBridge";
import { resolveCloudPublicConfig } from "./publicConfig";

export function deactivateCloudRelayAccount(): void {
  setAgentAwarenessRelayTokenProvider(null);
  setManagedRelaySession(appAtomRegistry, null);
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  const config = resolveCloudPublicConfig();
  const publishableKey = config.clerk.publishableKey;
  const relayUrl = config.relay.url;

  useEffect(() => {
    if (!publishableKey || !relayUrl) {
      deactivateCloudRelayAccount();
    }
  }, [publishableKey, relayUrl]);

  if (!publishableKey || !relayUrl) {
    return props.children;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <MultiAccountCloudAuthBridge>{props.children}</MultiAccountCloudAuthBridge>
    </ClerkProvider>
  );
}
