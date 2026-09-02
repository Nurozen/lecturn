import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

/** What the asset URL query knows on its own, with the atom plumbing removed. */
export type AssetUrlQuery =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Failed" }
  | { readonly _tag: "Resolved"; readonly relativeUrl: string };

export type AssetUrlFailureReason = "disconnected" | "failed";

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure"; readonly reason: AssetUrlFailureReason }
  | { readonly _tag: "Success"; readonly url: string };

/**
 * Folds the asset URL query, the environment connection phase, and the prepared
 * connection into the state a preview renders. The connection phase is checked
 * before the query outcome because a dead environment fails the query too, and
 * that failure must read as "disconnected" rather than "file unavailable".
 */
export function deriveAssetUrlState(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly httpBaseUrl: string | null;
  readonly query: AssetUrlQuery;
}): AssetUrlState {
  if (input.query._tag === "Resolved" && input.httpBaseUrl !== null) {
    const url = resolveAssetUrl(input.httpBaseUrl, input.query.relativeUrl);
    return url === null ? { _tag: "Failure", reason: "failed" } : { _tag: "Success", url };
  }
  switch (input.connectionPhase) {
    case "offline":
    case "reconnecting":
    case "error":
      return { _tag: "Failure", reason: "disconnected" };
    // "available" is the idle, not yet dialled state. A pending query there is
    // still on its way, but the query atom fails at once while idle, so a
    // failure means the environment is not connected rather than the file is
    // missing.
    case "available":
      return input.query._tag === "Failed"
        ? { _tag: "Failure", reason: "disconnected" }
        : { _tag: "Loading" };
    case "connecting":
      return { _tag: "Loading" };
    case "connected":
      return input.query._tag === "Failed"
        ? { _tag: "Failure", reason: "failed" }
        : { _tag: "Loading" };
  }
}
