import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider } from "@clerk/electron/react";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { ClerkDefaultAvatar } from "./ClerkDefaultAvatar";
import { useClientSettings } from "../../hooks/useSettings";
import { clerkAppearance, redesignClerkAppearance } from "./clerkAppearance";

/** Load only lazily inside desktop; clerk-js is statically bundled and would otherwise enter every
 * client's startup graph. */
export default function ElectronManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  const redesign = useClientSettings((settings) => settings.redesignEnabled);
  return (
    <ClerkProvider
      appearance={redesign ? redesignClerkAppearance : clerkAppearance}
      publishableKey={publishableKey}
      passkeys={passkeys}
    >
      <ClerkDefaultAvatar />
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkProvider>
  );
}
