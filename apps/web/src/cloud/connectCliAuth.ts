import {
  buildConnectClerkAuthorizeUrl,
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
  type ConnectAuthorizeRequest,
} from "@lecturn/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@lecturn/shared/relayAuth";

import { isHostedStaticApp } from "../hostedPairing";
import { hasCloudPublicConfig, resolveCloudPublicConfig, trimNonEmpty } from "./publicConfig";

function resolveConnectCliOAuthClientId(): string | null {
  return trimNonEmpty(import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID as string | undefined);
}

export function hasConnectCliAuthConfig(): boolean {
  return Boolean(
    resolveCloudPublicConfig().clerkPublishableKey && resolveConnectCliOAuthClientId(),
  );
}

export function connectCliAuthRoutesEnabled(): boolean {
  return isHostedStaticApp() && hasCloudPublicConfig() && hasConnectCliAuthConfig();
}

export function buildConnectCliClerkAuthorizeUrl(request: ConnectAuthorizeRequest): string | null {
  const { clerkPublishableKey } = resolveCloudPublicConfig();
  const clientId = resolveConnectCliOAuthClientId();
  if (!clerkPublishableKey || !clientId) {
    return null;
  }
  return buildConnectClerkAuthorizeUrl({
    authorizationEndpoint: `${clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey)}/oauth/authorize`,
    clientId,
    redirectUri: connectLoopbackRedirectUri(request.loopbackPort),
    scopes: CONNECT_OAUTH_SCOPES,
    state: request.state,
    challenge: request.challenge,
  });
}

/**
 * It has to be the authorize endpoint rather than this page: /connect carries the CLI request
 * in its fragment, so navigating back to the same URL is a same-document fragment navigation
 * the browser never reloads — and Clerk treats any post-sign-in navigation as a page unload and
 * skips the state emit that would otherwise re-render the surface, so the session never arrives
 * either.
 */
export function connectCliSignInRedirectUrl(
  request: ConnectAuthorizeRequest,
  currentHref: string,
): string {
  return buildConnectCliClerkAuthorizeUrl(request) ?? currentHref;
}

export type ConnectCliAuthorizeStep =
  | { readonly _tag: "wait" }
  | { readonly _tag: "sign-in" }
  | { readonly _tag: "choose" }
  /** `accountId` null authorizes Clerk's active account as it is. */
  | { readonly _tag: "redirect"; readonly accountId: string | null };

/**
 * What /connect does next. Clerk's authorize endpoint acts as the active
 * account, so with two or more known accounts the user picks one first and it
 * is made active before the redirect. With one account nothing is asked.
 */
export function decideConnectCliAuthorizeStep(input: {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly knownAccountIds: ReadonlyArray<string>;
  /** False until Clerk's sessions were applied to the known list. */
  readonly knownAccountsSynced: boolean;
  readonly confirmedAccountId: string | null;
}): ConnectCliAuthorizeStep {
  if (!input.isLoaded) return { _tag: "wait" };
  if (!input.isSignedIn) return { _tag: "sign-in" };
  if (!input.knownAccountsSynced) return { _tag: "wait" };
  if (input.knownAccountIds.length < 2) return { _tag: "redirect", accountId: null };
  return input.confirmedAccountId === null
    ? { _tag: "choose" }
    : { _tag: "redirect", accountId: input.confirmedAccountId };
}

/**
 * Leaves /connect for Clerk's authorize endpoint. A chosen account is made
 * active first; a switch that fails rejects without navigating, so the CLI is
 * never authorized as an account the user did not pick.
 */
export async function leaveForConnectCliAuthorize(input: {
  /** null authorizes Clerk's active account as it is. */
  readonly accountId: string | null;
  readonly asAccount: (accountId: string, fn: () => void) => Promise<void>;
  readonly navigate: () => void;
}): Promise<void> {
  if (input.accountId === null) {
    input.navigate();
    return;
  }
  await input.asAccount(input.accountId, input.navigate);
}
