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

  // A dead environment fails the URL query itself, so the query outcome alone
  // cannot tell a missing file from a missing connection.
  it("reports disconnected when the query failed while the environment is down", () => {
    for (const connectionPhase of ["available", "offline", "reconnecting", "error"] as const) {
      expect(
        deriveAssetUrlState({
          connectionPhase,
          httpBaseUrl: null,
          query: { _tag: "Failed" },
        }),
      ).toEqual({ _tag: "Failure", reason: "disconnected" });
    }
  });

  it("reports a failed query on a connected environment", () => {
    expect(
      deriveAssetUrlState({
        connectionPhase: "connected",
        httpBaseUrl: BASE_URL,
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
