import { ManagedRelayRequestTimeoutError, ManagedRelayRequestFailedError } from "./managedRelay.ts";
import { RelayAuthInvalidError } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import {
  DPOP_CLOCK_HINT,
  DPOP_RETRY_HINT,
  DPOP_UNKNOWN_HINT,
  relayProtectedErrorMessage,
  relayClientErrorDetail,
} from "./errorPresentation.ts";

describe("relayProtectedErrorMessage", () => {
  it("presents clock skew as one possible cause when the relay omits the reason", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe(
      `Relay rejected the DPoP proof. ${DPOP_UNKNOWN_HINT}`,
    );
  });

  it("keeps the clock hint for a relay that confirms a time-window failure", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      dpopFailureReason: "time_window",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toContain(DPOP_CLOCK_HINT);
  });

  it("does not blame the clock when the relay identifies another proof failure", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      dpopFailureReason: "key_mismatch",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe(
      `Relay rejected the DPoP proof. ${DPOP_RETRY_HINT}`,
    );
  });

  it("preserves the existing message for other authentication failures", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_bearer",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe("Relay rejected the cloud session token.");
  });
});

describe("relayClientErrorDetail", () => {
  it("retains the timeout and recovery action for setup screens", () => {
    expect(
      relayClientErrorDetail(
        new ManagedRelayRequestTimeoutError({
          activity: "Relay environment link challenge",
          timeoutMs: 35000,
          traceId: "trace-client",
        }),
      ),
    ).toBe(
      "Relay environment link challenge timed out after 35 seconds. Check your connection and try again.",
    );
  });
  it("does not expose raw transport causes", () => {
    expect(
      relayClientErrorDetail(
        new ManagedRelayRequestFailedError({
          action: "create relay environment link challenge",
          cause: new Error("private transport details"),
        }),
      ),
    ).toBeNull();
  });
});
