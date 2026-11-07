import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SecureStore from "expo-secure-store";
import { vi } from "vite-plus/test";

const secureStore = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((key: string) => Promise.resolve(secureStore.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: vi.fn((key: string) => {
    secureStore.delete(key);
    return Promise.resolve();
  }),
}));

import { managedRelayAccessTokenStore } from "./managedRelayTokenStore";

it.effect("keeps the surviving account's tokens when another account's are dropped", () =>
  Effect.gen(function* () {
    secureStore.clear();
    vi.mocked(SecureStore.deleteItemAsync).mockClear();
    const entryFor = (accountId: string) =>
      ({
        accountId,
        clientId: "lecturn-mobile",
        relayUrl: "https://relay.example.test",
        thumbprint: "thumbprint",
        scopes: ["environment:connect"],
        accessToken: `access-token:${accountId}`,
        expiresAtMillis: 1_800_000,
      }) as const;

    yield* managedRelayAccessTokenStore.save([entryFor("account-a"), entryFor("account-b")]);
    // A scoped reset writes the survivors back instead of clearing the whole entry.
    yield* managedRelayAccessTokenStore.save([entryFor("account-a")]);

    expect(yield* managedRelayAccessTokenStore.load).toEqual([entryFor("account-a")]);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  }),
);

it.effect("falls back to an empty cache when persisted data is invalid", () =>
  Effect.gen(function* () {
    secureStore.clear();
    secureStore.set("lecturn.cloud.relay-access-tokens", "not-json");

    expect(yield* managedRelayAccessTokenStore.load).toEqual([]);
  }),
);
