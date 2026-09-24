import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeCatalogStore } from "./storage";

const taggedCatalog = {
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
  remoteDpopTokens: [
    {
      environmentId: "environment-1",
      label: "Remote",
      endpoint: {
        httpBaseUrl: "https://remote.example.test",
        wsBaseUrl: "wss://remote.example.test",
        providerKind: "cloudflare_tunnel",
      },
      accessToken: "dpop-token",
      expiresAtEpochMs: 1_000_000,
      dpopThumbprint: "thumbprint",
      accountId: "user_a",
    },
  ],
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("makeCatalogStore accountId", () => {
  it.effect("round-trips a tagged relay target and token", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed(encodeJson(taggedCatalog)),
        write: (raw) => Effect.sync(() => writes.push(raw)),
      });

      const document = yield* store.read;
      expect(document.targets[0]).toMatchObject({ accountId: "user_a" });
      expect(document.remoteDpopTokens[0]?.accountId).toBe("user_a");

      yield* store.update((current) => ({ ...current }));
      expect(writes).toHaveLength(1);
      expect(decodeJson(writes[0]!)).toEqual(taggedCatalog);
    }),
  );
});
