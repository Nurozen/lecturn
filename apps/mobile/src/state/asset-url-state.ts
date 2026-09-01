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
 * connection into the state a preview renders. A query still pending on an
 * environment that is offline, retrying, or in error is terminal, so previews can
 * offer a retry instead of spinning until the user leaves the screen.
 */
export function deriveAssetUrlState(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly httpBaseUrl: string | null;
  readonly query: AssetUrlQuery;
}): AssetUrlState {
  if (input.query._tag === "Failed") {
    return { _tag: "Failure", reason: "failed" };
  }
  if (input.query._tag === "Resolved" && input.httpBaseUrl !== null) {
    const url = resolveAssetUrl(input.httpBaseUrl, input.query.relativeUrl);
    return url === null ? { _tag: "Failure", reason: "failed" } : { _tag: "Success", url };
  }
  switch (input.connectionPhase) {
    case "offline":
    case "reconnecting":
    case "error":
      return { _tag: "Failure", reason: "disconnected" };
    // "available" means the environment has not been dialled yet, so the URL is
    // still on its way rather than lost.
    case "available":
    case "connecting":
    case "connected":
      return { _tag: "Loading" };
  }
}
