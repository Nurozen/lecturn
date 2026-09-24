import {
  DecisionFundingAccountListResult,
  DecisionFundingRevokeRequest,
  DecisionFundingRevokeResult,
} from "@lecturn/contracts";
import { Schema } from "effect";
import { readToken } from "./accountTokens";
import { resolveCloudPublicConfig } from "./publicConfig";

const decodeList = Schema.decodeUnknownSync(DecisionFundingAccountListResult);
const decodeRevoke = Schema.decodeUnknownSync(DecisionFundingRevokeResult);
const encodeRevoke = Schema.encodeSync(Schema.fromJsonString(DecisionFundingRevokeRequest));

export function createDecisionFundingAccountsClient(options: {
  relayUrl: string;
  token: (accountId: string) => Promise<string | null>;
  fetch: typeof globalThis.fetch;
}) {
  async function request(accountId: string, path: string, body?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const token = await options.token(accountId).catch(() => null);
    signal?.throwIfAborted();
    if (!token) throw new Error("Sign in again to manage Decisions funding.");
    const response = await options
      .fetch(new URL(path, options.relayUrl), {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
        ...(signal ? { signal } : {}),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      })
      .catch(() => {
        throw new Error("Decisions funding is unavailable. Try again.");
      });
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? "Funding changed. Refresh the list before trying again."
          : "Decisions funding could not be updated. Refresh or sign in again.",
      );
    return response.json();
  }
  return {
    async list(accountId: string, cursor?: string, signal?: AbortSignal) {
      const params = new URLSearchParams({ limit: "25", ...(cursor ? { cursor } : {}) });
      return decodeList(
        await request(accountId, `/v1/decisions/funding/account-list?${params}`, undefined, signal),
      );
    },
    async revoke(
      accountId: string,
      input: typeof DecisionFundingRevokeRequest.Type,
      signal?: AbortSignal,
    ) {
      return decodeRevoke(
        await request(
          accountId,
          "/v1/decisions/funding/account-revoke",
          encodeRevoke(input),
          signal,
        ),
      );
    },
  };
}
export function decisionFundingAccountsClient() {
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  if (!relayUrl) throw new Error("Decisions funding is unavailable.");
  return createDecisionFundingAccountsClient({
    relayUrl,
    token: readToken,
    fetch: globalThis.fetch.bind(globalThis),
  });
}
