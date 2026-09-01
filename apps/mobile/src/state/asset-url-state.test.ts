import { describe, expect, it } from "@effect/vitest";

import { deriveAssetUrlState } from "./asset-url-state";

const BASE_URL = "https://environment.example/";

describe("deriveAssetUrlState", () => {
  it("resolves a signed relative URL against the prepared connection", () => {
    expect(
      deriveAssetUrlState({
        connectionPhase: "connected",
        httpBaseUrl: BASE_URL,
        query: { _tag: "Resolved", relativeUrl: "/api/assets/abc?sig=1" },
      }),
    ).toEqual({ _tag: "Success", url: "https://environment.example/api/assets/abc?sig=1" });
  });

  it("waits while the query is pending and the environment is still reachable", () => {
    for (const connectionPhase of ["available", "connecting", "connected"] as const) {
      expect(
        deriveAssetUrlState({
          connectionPhase,
          httpBaseUrl: BASE_URL,
          query: { _tag: "Pending" },
        }),
      ).toEqual({ _tag: "Loading" });
    }
  });

  it("stops waiting once the environment is offline, retrying, or in error", () => {
    for (const connectionPhase of ["offline", "reconnecting", "error"] as const) {
      expect(
        deriveAssetUrlState({
          connectionPhase,
          httpBaseUrl: BASE_URL,
          query: { _tag: "Pending" },
        }),
      ).toEqual({ _tag: "Failure", reason: "disconnected" });
    }
  });

  it("reports a failed query even while the environment is disconnected", () => {
    expect(
      deriveAssetUrlState({
        connectionPhase: "error",
        httpBaseUrl: null,
        query: { _tag: "Failed" },
      }),
    ).toEqual({ _tag: "Failure", reason: "failed" });
  });

  it("fails when the signed URL cannot be resolved against the base URL", () => {
    expect(
      deriveAssetUrlState({
        connectionPhase: "connected",
        httpBaseUrl: "not a url",
        query: { _tag: "Resolved", relativeUrl: "/api/assets/abc" },
      }),
    ).toEqual({ _tag: "Failure", reason: "failed" });
  });

  it("keeps loading when a URL arrived before the prepared connection did", () => {
    expect(
      deriveAssetUrlState({
        connectionPhase: "connecting",
        httpBaseUrl: null,
        query: { _tag: "Resolved", relativeUrl: "/api/assets/abc" },
      }),
    ).toEqual({ _tag: "Loading" });
  });
});
