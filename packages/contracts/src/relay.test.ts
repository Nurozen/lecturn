import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  RelayAccessTokenType,
  RelayDeviceRegistrationRequest,
  RelayDpopAccessTokenRequest,
  RelayDpopProofRequestHeaders,
  RelayDpopTokenExchangeGrantType,
  RelayJwtSubjectTokenType,
} from "./relay.ts";

const decodeExchangeRequest = Schema.decodeUnknownSync(RelayDpopAccessTokenRequest);
const decodeProofHeaders = Schema.decodeUnknownSync(RelayDpopProofRequestHeaders);
const decodeDevice = Schema.decodeUnknownExit(RelayDeviceRegistrationRequest);
const exchangeRequest = {
  grant_type: RelayDpopTokenExchangeGrantType,
  subject_token: "opaque-oauth-token",
  subject_token_type: RelayAccessTokenType,
  requested_token_type: RelayAccessTokenType,
  resource: "https://relay.example.test",
  scope: "environment:connect",
  client_id: "lecturn-web",
};

describe("relay token exchange contract", () => {
  it.each([RelayJwtSubjectTokenType, RelayAccessTokenType])(
    "accepts explicit %s subjects",
    (subject_token_type) => {
      const request = { ...exchangeRequest, subject_token_type };
      expect(decodeExchangeRequest(request)).toEqual(request);
    },
  );

  it.each([
    { subject_token_type: "unknown-type" },
    { subject_token_type: undefined },
    { requested_token_type: RelayJwtSubjectTokenType },
    { client_id: "unknown-client" },
    { subject_token: "" },
  ])("rejects invalid exchange fields (%j)", (override) => {
    expect(() => decodeExchangeRequest({ ...exchangeRequest, ...override })).toThrow();
  });

  it("requires a nonempty DPoP proof header", () => {
    expect(() => decodeProofHeaders({})).toThrow();
    expect(() => decodeProofHeaders({ dpop: "" })).toThrow();
  });
});

const device = {
  deviceId: "device",
  label: "Phone",
  pushToken: "token",
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

describe("mobile device platforms", () => {
  it("rejects missing platform versions and Apple activity tokens on Android", () => {
    expect(decodeDevice({ ...device, platform: "ios" })._tag).toBe("Failure");
    expect(decodeDevice({ ...device, platform: "android" })._tag).toBe("Failure");
    expect(
      decodeDevice({
        ...device,
        platform: "android",
        androidApiLevel: 36,
        pushToStartToken: "apple-token",
      })._tag,
    ).toBe("Failure");
  });
});
