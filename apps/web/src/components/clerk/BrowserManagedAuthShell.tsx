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

/**
 * Browser half of the managed-auth boundary, loaded lazily from the entry so
 * cloudless local mode never downloads a Clerk runtime. The browser provider
 * stays small on its own: it hotloads clerk-js at runtime instead of bundling
 * it.
 */
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
