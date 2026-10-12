import { describe, expect, it } from "vite-plus/test";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import * as Schema from "effect/Schema";

import {
  RelayApi,
  RelayAccessTokenType,
  RelayDpopAccessTokenRequest,
  RelayDpopProofRequestHeaders,
  RelayDpopTokenExchangeGrantType,
  RelayJwtSubjectTokenType,
} from "./relay.ts";

const decodeExchangeRequest = Schema.decodeUnknownSync(RelayDpopAccessTokenRequest);
const decodeProofHeaders = Schema.decodeUnknownSync(RelayDpopProofRequestHeaders);
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

describe("RelayApi security", () => {
  it("describes DPoP access tokens using the HTTP DPoP authorization scheme", () => {
    const document = OpenApi.fromApi(RelayApi);

    expect(document.components.securitySchemes?.relayDpop).toEqual({
      type: "http",
      scheme: "DPoP",
      description: "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
    });
  });
});
