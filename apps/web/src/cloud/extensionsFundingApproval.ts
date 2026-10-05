import {
  ExtensionFundingApprovalInfo,
  type ExtensionFeatureId,
  ExtensionFundingApprovalRequest,
  ExtensionFundingApprovalResult,
} from "@lecturn/contracts";
import { Schema } from "effect";
import { readToken } from "./accountTokens";
import { resolveCloudPublicConfig } from "./publicConfig";

const encodeApproval = Schema.encodeSync(Schema.fromJsonString(ExtensionFundingApprovalRequest));
const decodeInfo = Schema.decodeUnknownSync(ExtensionFundingApprovalInfo);
const decodeApproval = Schema.decodeUnknownSync(ExtensionFundingApprovalResult);

const messageForStatus = (status: number) => {
  if (status === 401) return "Sign in again to approve this request.";
  if (status === 403) return "This account cannot approve this Extension request.";
  if (status === 409) return "This request has changed. Start a new request in Lecturn.";
  if (status === 410) return "This request expired. Start a new request in Lecturn.";
  return "Extension approval is unavailable. Try again shortly.";
};

export function createExtensionFundingApprovalClient(options: {
  readonly featureId: ExtensionFeatureId;
  readonly relayUrl: string;
  readonly token: (accountId: string) => Promise<string | null>;
  readonly fetch: typeof globalThis.fetch;
}) {
  const request = async (
    accountId: string,
    challengeId: string,
    approve: boolean,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const token = await options.token(accountId).catch(() => {
      throw new Error("Sign in again to approve this request.");
    });
    signal?.throwIfAborted();
    if (!token) throw new Error("Sign in again to approve this request.");
    const url = new URL(
      approve ? "/v1/extensions/funding/approve" : "/v1/extensions/funding/approval",
      options.relayUrl,
    );
    if (!approve) {
      url.searchParams.set("challengeId", challengeId);
      url.searchParams.set("featureId", options.featureId);
    }
    const response = await options
      .fetch(url, {
        method: approve ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(approve ? { "Content-Type": "application/json" } : {}),
        },
        ...(approve
          ? {
              body: encodeApproval({
                challengeId,
                featureId: options.featureId,
              }),
            }
          : {}),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        ...(signal ? { signal } : {}),
      })
      .catch(() => {
        throw new Error("Extension approval is unavailable. Try again shortly.");
      });
    if (!response.ok) throw new Error(messageForStatus(response.status));
    return response.json().catch(() => {
      throw new Error("Extension returned an invalid approval response.");
    });
  };
  return {
    info: async (accountId: string, challengeId: string, signal?: AbortSignal) => {
      const payload = await request(accountId, challengeId, false, signal);
      try {
        const info = decodeInfo(payload);
        if (info.featureId !== options.featureId || info.challengeId !== challengeId)
          throw new Error("Identity mismatch");
        return info;
      } catch {
        throw new Error("Extension returned an invalid approval response.");
      }
    },
    approve: async (accountId: string, challengeId: string, signal?: AbortSignal) => {
      const payload = await request(accountId, challengeId, true, signal);
      try {
        const result = decodeApproval(payload);
        if (result.featureId !== options.featureId || result.challengeId !== challengeId)
          throw new Error("Identity mismatch");
        return result;
      } catch {
        throw new Error("Extension returned an invalid approval response.");
      }
    },
  };
}

export const extensionFundingApprovalClient = (featureId: ExtensionFeatureId) => {
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  if (!relayUrl) throw new Error("Extension approval is unavailable.");
  return createExtensionFundingApprovalClient({
    featureId,
    relayUrl,
    token: readToken,
    fetch: globalThis.fetch.bind(globalThis),
  });
};
