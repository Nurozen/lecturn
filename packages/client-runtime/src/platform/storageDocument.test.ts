import { EnvironmentId } from "@lecturn/contracts";
import { RelayManagedEndpoint } from "@lecturn/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as TokenStore from "../authorization/tokenStore.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  RelayConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
} from "./storageDocument.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});
const REMOTE_TOKEN = new TokenStore.RemoteDpopAccessToken({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  endpoint: {
    httpBaseUrl: "https://remote.example.test",
    wsBaseUrl: "wss://remote.example.test",
    providerKind: "cloudflare_tunnel",
  },
  accessToken: "dpop-token",
  expiresAtEpochMs: 1_000_000,
  dpopThumbprint: "thumbprint",
});

describe("ConnectionCatalogDocument", () => {
  it("registers a bearer connection as one catalog mutation", () => {
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(document.targets).toEqual([BEARER_TARGET]);
    expect(document.profiles).toEqual([BEARER_PROFILE]);
    expect(document.credentials).toEqual([
      {
        connectionId: BEARER_TARGET.connectionId,
        credential: BEARER_CREDENTIAL,
      },
    ]);
  });

  it("replaces obsolete connection metadata without discarding a reusable DPoP token", () => {
    const bearer = registerConnectionInCatalog(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        remoteDpopTokens: [REMOTE_TOKEN],
      },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const relayTarget = new RelayConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Remote",
    });
    const relay = registerConnectionInCatalog(
      bearer,
      new RelayConnectionRegistration({ target: relayTarget }),
    );

    expect(relay.targets).toEqual([relayTarget]);
    expect(relay.profiles).toEqual([]);
    expect(relay.credentials).toEqual([]);
    expect(relay.remoteDpopTokens).toEqual([REMOTE_TOKEN]);
  });

  it("removes every catalog record owned by an explicit disconnect", () => {
    const registered = registerConnectionInCatalog(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        remoteDpopTokens: [REMOTE_TOKEN],
      },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(removeConnectionFromCatalog(registered, BEARER_TARGET)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("persists the normalized SSH profile beside its target", () => {
    const target = new SshConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "SSH",
      connectionId: "ssh-1",
    });
    const profile = new SshConnectionProfile({
      connectionId: target.connectionId,
      environmentId: target.environmentId,
      label: target.label,
      target: {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      },
    });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new SshConnectionRegistration({ target, profile }),
    );

    expect(document.targets).toEqual([target]);
    expect(document.profiles).toEqual([profile]);
    expect(document.credentials).toEqual([]);
  });
});

// A frozen copy of the relay target, token, and document schemas as they
// shipped before `accountId` existed. It stands in for an older build reading
// a catalog written by a newer one.
class PreAccountRelayConnectionTarget extends Schema.TaggedClass<PreAccountRelayConnectionTarget>()(
  "RelayConnectionTarget",
  {
    environmentId: EnvironmentId,
    label: Schema.String,
  },
) {}
class PreAccountRemoteDpopAccessToken extends Schema.Class<PreAccountRemoteDpopAccessToken>(
  "test/PreAccountRemoteDpopAccessToken",
)({
  environmentId: EnvironmentId,
  label: Schema.String,
  endpoint: RelayManagedEndpoint,
  accessToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
  dpopThumbprint: Schema.String,
}) {}
const PreAccountConnectionCatalogDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(
    Schema.Union([BearerConnectionTarget, PreAccountRelayConnectionTarget, SshConnectionTarget]),
  ),
  profiles: Schema.Array(Schema.Union([BearerConnectionProfile, SshConnectionProfile])),
  credentials: Schema.Array(
    Schema.Struct({
      connectionId: Schema.String,
      credential: Schema.Union([BearerConnectionCredential]),
    }),
  ),
  remoteDpopTokens: Schema.Array(PreAccountRemoteDpopAccessToken),
});

const CatalogJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeCatalogJson = Schema.decodeUnknownSync(CatalogJson);
const encodeCatalogJson = Schema.encodeSync(CatalogJson);
const decodePreAccountCatalogJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(PreAccountConnectionCatalogDocument),
);

const REMOTE_TOKEN_JSON = {
  environmentId: "environment-1",
  label: "Remote",
  endpoint: REMOTE_TOKEN.endpoint,
  accessToken: "dpop-token",
  expiresAtEpochMs: 1_000_000,
  dpopThumbprint: "thumbprint",
};
const UNTAGGED_CATALOG_JSON = JSON.stringify({
  schemaVersion: 1,
  targets: [{ _tag: "RelayConnectionTarget", environmentId: "environment-1", label: "Remote" }],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [REMOTE_TOKEN_JSON],
});
const TAGGED_CATALOG_JSON = JSON.stringify({
  schemaVersion: 1,
  targets: [
    {
      _tag: "RelayConnectionTarget",
      environmentId: "environment-1",
      label: "Remote",
      accountId: "user_a",
    },
  ],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [{ ...REMOTE_TOKEN_JSON, accountId: "user_a" }],
});

describe("ConnectionCatalogDocument accountId", () => {
  it("decodes a document written before accountId existed and re-encodes it unchanged", () => {
    const document = decodeCatalogJson(UNTAGGED_CATALOG_JSON);

    expect(document.targets).toEqual([
      new RelayConnectionTarget({ environmentId: ENVIRONMENT_ID, label: "Remote" }),
    ]);
    expect(document.remoteDpopTokens).toEqual([REMOTE_TOKEN]);
    expect(JSON.parse(encodeCatalogJson(document))).toEqual(JSON.parse(UNTAGGED_CATALOG_JSON));
  });

  it("round-trips a tagged relay target and token", () => {
    const document = decodeCatalogJson(TAGGED_CATALOG_JSON);

    expect(document.targets).toEqual([
      new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Remote",
        accountId: "user_a",
      }),
    ]);
    expect(document.remoteDpopTokens[0]?.accountId).toBe("user_a");
    expect(JSON.parse(encodeCatalogJson(document))).toEqual(JSON.parse(TAGGED_CATALOG_JSON));
  });

  it("keeps the tag through a catalog registration", () => {
    const target = new RelayConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Remote",
      accountId: "user_a",
    });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new RelayConnectionRegistration({ target }),
    );

    expect(document.targets[0]).toEqual(target);
  });

  it("lets a build from before accountId decode a tagged document", () => {
    const document = decodePreAccountCatalogJson(TAGGED_CATALOG_JSON);

    // The older build ignores the tag rather than rejecting the catalog.
    expect(document.targets).toEqual([
      new PreAccountRelayConnectionTarget({ environmentId: ENVIRONMENT_ID, label: "Remote" }),
    ]);
    expect(document.remoteDpopTokens).toHaveLength(1);
    expect("accountId" in document.remoteDpopTokens[0]!).toBe(false);
  });
});
