import { ClerkProvider, useAuth, useClerk } from "@clerk/react";
import { useEffect, type ComponentProps, type ReactNode } from "react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { ClerkDefaultAvatar } from "./ClerkDefaultAvatar";
import { clerkAppearance } from "./clerkAppearance";

/**
 * The clerk-js and Clerk UI builds hosted web loads. Exact, because relay
 * tokens are read from sessions that are not the active one, which Clerk does
 * not document and a newer CDN build could change. clerk-js is the version in
 * the lockfile, the UI the one the installed `@clerk/shared` was built against.
 */
export const PINNED_CLERK_VERSIONS = { clerkJS: "6.30.1", clerkUI: "1.30.8" } as const;

// Clerk keeps its script version props out of the provider's public types.
const pinnedClerkScripts = {
  __internal_clerkJSVersion: PINNED_CLERK_VERSIONS.clerkJS,
  __internal_clerkUIVersion: PINNED_CLERK_VERSIONS.clerkUI,
} as Partial<ComponentProps<typeof ClerkProvider>>;

/** Warns when another clerk-js loaded, which means Clerk renamed the props above. */
function ClerkVersionCheck() {
  const clerk = useClerk();
  const { isLoaded } = useAuth();
  const version = isLoaded ? clerk.version : undefined;
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- warns in the console once the loaded clerk-js reports a version other than the pinned one
  useEffect(() => {
    if (version !== undefined && version !== PINNED_CLERK_VERSIONS.clerkJS) {
      console.warn("[lecturn-connect] clerk-js is not the pinned version", {
        loaded: version,
        pinned: PINNED_CLERK_VERSIONS.clerkJS,
      });
    }
  }, [version]);
  return null;
}

/** Lazy-load Clerk so cloudless local mode never downloads it. */
export default function BrowserManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  return (
    <ClerkProvider
      appearance={clerkAppearance}
      publishableKey={publishableKey}
      {...pinnedClerkScripts}
    >
      <ClerkVersionCheck />
      <ClerkDefaultAvatar />
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkProvider>
  );
}
