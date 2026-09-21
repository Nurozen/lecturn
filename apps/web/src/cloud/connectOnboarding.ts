import * as Schema from "effect/Schema";

/**
 * Accounts that opted out of the post-sign-in Lecturn Connect onboarding wizard
 * ("Don't show this again"). The wizard otherwise shows on every sign-in,
 * since sign-out clears the connected environments.
 */
export const CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY = "lecturn:connect-onboarding-opt-out:v1";

export const ConnectOnboardingOptOutSchema = Schema.Struct({
  optOutAccounts: Schema.Array(Schema.String),
});

export type ConnectOnboardingOptOutState = typeof ConnectOnboardingOptOutSchema.Type;

export const EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE: ConnectOnboardingOptOutState = {
  optOutAccounts: [],
};

/** An account that is new to this client and is waiting to become the active one. */
export interface ConnectOnboardingRequest {
  readonly accountId: string;
  readonly requestedAt: number;
}

/** Clerk makes a new account active within moments. A request left over after this is dropped. */
export const CONNECT_ONBOARDING_REQUEST_MAX_AGE_MS = 60_000;

/** Requests still worth opening the wizard for, with new accounts queued behind them. */
export function pendingOnboardingRequests(input: {
  readonly requests: ReadonlyArray<ConnectOnboardingRequest>;
  readonly added: ReadonlyArray<string>;
  readonly knownAccountIds: ReadonlyArray<string>;
  readonly optOutAccounts: ReadonlyArray<string>;
  readonly now: number;
}): ReadonlyArray<ConnectOnboardingRequest> {
  return [
    ...input.requests.filter((request) => !input.added.includes(request.accountId)),
    ...input.added.map((accountId) => ({ accountId, requestedAt: input.now })),
  ].filter(
    (request) =>
      input.now - request.requestedAt < CONNECT_ONBOARDING_REQUEST_MAX_AGE_MS &&
      input.knownAccountIds.includes(request.accountId) &&
      !input.optOutAccounts.includes(request.accountId),
  );
}
