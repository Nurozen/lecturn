import {
  buildConnectClerkAuthorizeUrl,
  connectCallbackUrl,
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
  type ConnectAuthorizeRequest,
} from "@lecturn/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@lecturn/shared/relayAuth";

import { configuredHostedAppUrl, isHostedStaticApp } from "../hostedPairing";
import { hasCloudPublicConfig, resolveCloudPublicConfig, trimNonEmpty } from "./publicConfig";

const CONNECT_CLI_AUTH_STATE_STORAGE_KEY = "lecturn-connect-cli-auth-state";
const CONNECT_CLI_AUTH_ACCOUNT_STORAGE_KEY = "lecturn-connect-cli-auth-account";

export function resolveConnectCliOAuthClientId(): string | null {
  return trimNonEmpty(import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID as string | undefined);
}

export function hasConnectCliAuthConfig(): boolean {
  return Boolean(
    resolveCloudPublicConfig().clerkPublishableKey && resolveConnectCliOAuthClientId(),
  );
}

/**
 * Gate for the /connect routes: the CLI handshake only exists on the hosted
 * deployment (the same bundle ships inside local instances) and needs the
 * Clerk CLI OAuth client configured at build time.
 */
export function connectCliAuthRoutesEnabled(): boolean {
  return isHostedStaticApp() && hasCloudPublicConfig() && hasConnectCliAuthConfig();
}

/**
 * Builds the Clerk authorize URL for a CLI-initiated connect request. The
 * state is mirrored into sessionStorage so the callback page can verify the
 * response matches a request this browser actually started.
 *
 * A request carrying a loopback port came from a CLI with a local callback
 * listener: the authorization code must return to `127.0.0.1` directly, so
 * the hosted callback page never sees it. Clerk enforces its registered
 * redirect URI allowlist either way.
 */
export function buildConnectCliClerkAuthorizeUrl(request: ConnectAuthorizeRequest): string | null {
  const { clerkPublishableKey } = resolveCloudPublicConfig();
  const clientId = resolveConnectCliOAuthClientId();
  if (!clerkPublishableKey || !clientId) {
    return null;
  }
  return buildConnectClerkAuthorizeUrl({
    authorizationEndpoint: `${clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey)}/oauth/authorize`,
    clientId,
    redirectUri:
      request.loopbackPort === undefined
        ? connectCallbackUrl(configuredHostedAppUrl())
        : connectLoopbackRedirectUri(request.loopbackPort),
    scopes: CONNECT_OAUTH_SCOPES,
    state: request.state,
    challenge: request.challenge,
  });
}

/**
 * Where Clerk sends the browser once the sign-in modal on /connect completes.
 * It has to be the authorize endpoint rather than this page: /connect carries
 * the CLI request in its fragment, so navigating back to the same URL is a
 * same-document fragment navigation the browser never reloads — and Clerk
 * treats any post-sign-in navigation as a page unload and skips the state emit
 * that would otherwise re-render the surface, so the session never arrives
 * either. Falls back to the current URL when the authorize URL cannot be
 * built, which only happens on a deployment without the CLI OAuth config.
 */
export function connectCliSignInRedirectUrl(
  request: ConnectAuthorizeRequest,
  currentHref: string,
): string {
  return buildConnectCliClerkAuthorizeUrl(request) ?? currentHref;
}

export function rememberConnectCliAuthState(state: string): void {
  try {
    window.sessionStorage.setItem(CONNECT_CLI_AUTH_STATE_STORAGE_KEY, state);
  } catch {
    // Session storage can be unavailable (e.g. blocked). The callback page
    // then falls back to trusting the state Clerk echoed back.
  }
}

/**
 * Read-only on purpose: this runs during render, where a removal would be
 * consumed by React's double-invoked/discarded renders (StrictMode) and
 * silently disable the state check. The value is not a secret and is
 * overwritten by the next /connect visit.
 */
export function readConnectCliAuthState(): string | null {
  try {
    return window.sessionStorage.getItem(CONNECT_CLI_AUTH_STATE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export interface ConnectCliCallbackResult {
  readonly code: string;
  readonly state: string;
}

export function readConnectCliCallbackResult(
  url: URL = new URL(window.location.href),
): ConnectCliCallbackResult | null {
  const code = url.searchParams.get("code")?.trim() ?? "";
  const state = url.searchParams.get("state")?.trim() ?? "";
  if (!code || !state) {
    return null;
  }
  return { code, state };
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

type ConnectCliAuthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStorageOrNull(): ConnectCliAuthStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Leaves /connect for Clerk's authorize endpoint. A chosen account is made
 * active first, and recorded for the callback page only once Clerk confirmed
 * the switch. A switch that fails records nothing, removes an earlier record,
 * and rejects, so the page never names an account that was not authorized.
 */
export async function leaveForConnectCliAuthorize(input: {
  readonly state: string;
  /** null authorizes Clerk's active account as it is. */
  readonly accountId: string | null;
  readonly asAccount: (accountId: string, fn: () => void) => Promise<void>;
  readonly navigate: () => void;
  readonly storage?: ConnectCliAuthStorage | null;
}): Promise<void> {
  const storage = input.storage === undefined ? sessionStorageOrNull() : input.storage;
  const { accountId } = input;
  const forget = () => {
    try {
      storage?.removeItem(CONNECT_CLI_AUTH_ACCOUNT_STORAGE_KEY);
    } catch {
      // Nothing was stored then.
    }
  };
  const leave = () => {
    try {
      storage?.setItem(CONNECT_CLI_AUTH_STATE_STORAGE_KEY, input.state);
      if (accountId === null) {
        forget();
      } else {
        storage?.setItem(
          CONNECT_CLI_AUTH_ACCOUNT_STORAGE_KEY,
          JSON.stringify({ state: input.state, accountId }),
        );
      }
    } catch {
      // The callback page then trusts the state Clerk echoes and names Clerk's user.
    }
    input.navigate();
  };
  if (accountId === null) {
    leave();
    return;
  }
  try {
    await input.asAccount(accountId, leave);
  } catch (cause) {
    forget();
    throw cause;
  }
}

/** The account chosen on /connect for this request, or null when none was chosen. */
export function parseConnectCliAuthAccount(stored: string | null, state: string): string | null {
  try {
    const value: unknown = stored === null ? null : JSON.parse(stored);
    if (typeof value !== "object" || value === null) return null;
    const { state: storedState, accountId } = value as { state?: unknown; accountId?: unknown };
    return storedState === state && typeof accountId === "string" && accountId ? accountId : null;
  } catch {
    return null;
  }
}

/** Read-only, as `readConnectCliAuthState` is. `forgetConnectCliAuthAccount` removes it after use. */
export function readConnectCliAuthAccount(state: string): string | null {
  try {
    return parseConnectCliAuthAccount(
      window.sessionStorage.getItem(CONNECT_CLI_AUTH_ACCOUNT_STORAGE_KEY),
      state,
    );
  } catch {
    return null;
  }
}

export function forgetConnectCliAuthAccount(): void {
  try {
    window.sessionStorage.removeItem(CONNECT_CLI_AUTH_ACCOUNT_STORAGE_KEY);
  } catch {
    // Nothing to remove.
  }
}

/**
 * Who the callback page says the terminal connects as. Clerk's user is the
 * account that was authorized, so it is always the one named. A choice made
 * on /connect that Clerk's user does not match is called out.
 */
export function nameConnectCliAuthorizedAccount(input: {
  readonly chosenAccountId: string | null;
  readonly user: { readonly id: string; readonly label: string | null } | null | undefined;
}): { readonly label: string | null; readonly differsFromChoice: boolean } {
  const { user } = input;
  return {
    label: user?.label ?? null,
    differsFromChoice:
      user != null && input.chosenAccountId !== null && input.chosenAccountId !== user.id,
  };
}
