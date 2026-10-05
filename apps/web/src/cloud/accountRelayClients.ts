import { createBillingClient, createTeamsClient } from "@lecturn/client-runtime/relay";

import { readToken } from "./accountTokens";
import { resolveCloudPublicConfig } from "./publicConfig";

function accountClientOptions(accountId: string | null | undefined, token?: string) {
  return {
    relayUrl: resolveCloudPublicConfig().relayUrl ?? "",
    getToken: () =>
      token !== undefined
        ? Promise.resolve(token)
        : accountId
          ? readToken(accountId)
          : Promise.resolve(null),
  };
}

/**
 * Relay billing for one account, authorized by that account's own token,
 * whichever account Clerk has active. `token` reuses one that was just read.
 */
export function createAccountBillingClient(accountId: string | null | undefined, token?: string) {
  return createBillingClient(accountClientOptions(accountId, token));
}

/** Relay teams for one account, authorized the same way. */
export function createAccountTeamsClient(accountId: string | null | undefined, token?: string) {
  return createTeamsClient(accountClientOptions(accountId, token));
}
