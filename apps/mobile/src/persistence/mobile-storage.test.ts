import { vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeAgentAwarenessRegistrationDocument, make } from "./mobile-storage";
import { MobileSecureStorage } from "./mobile-secure-storage";

vi.mock("expo-secure-store", () => ({}));

describe("account push registration persistence", () => {
  it("migrates a scalar under its own identity and rejects mismatched v2 keys", () => {
    expect(decodeAgentAwarenessRegistrationDocument({ identity: "a", signature: "sig-a" })).toEqual(
      { version: 2, records: { a: { identity: "a", signature: "sig-a" } } },
    );
    expect(
      decodeAgentAwarenessRegistrationDocument({
        version: 2,
        records: { a: { identity: "b", signature: "sig" } },
      }),
    ).toEqual({ version: 2, records: {} });
  });
  it.effect("serializes concurrent account saves and removes only the signed-out account", () => {
    const values = new Map<string, string>([
      [
        "lecturn.agent-awareness.registration",
        JSON.stringify({ identity: "legacy", signature: "old" }),
      ],
    ]);
    return Effect.gen(function* () {
      const storage = yield* make();
      expect(yield* storage.loadAgentAwarenessRegistrationRecord("legacy")).toEqual({
        identity: "legacy",
        signature: "old",
      });
      yield* Effect.all(
        [
          storage.saveAgentAwarenessRegistrationRecord({ identity: "a", signature: "sig-a" }),
          storage.saveAgentAwarenessRegistrationRecord({ identity: "b", signature: "sig-b" }),
        ],
        { concurrency: "unbounded" },
      );
      yield* storage.clearAgentAwarenessRegistrationRecord("b");
      expect(yield* storage.loadAgentAwarenessRegistrationRecord("a")).toEqual({
        identity: "a",
        signature: "sig-a",
      });
      expect(yield* storage.loadAgentAwarenessRegistrationRecord("b")).toBeNull();
      expect(yield* storage.loadAgentAwarenessRegistrationRecord("legacy")).toEqual({
        identity: "legacy",
        signature: "old",
      });
      expect(JSON.parse(values.get("lecturn.agent-awareness.registration")!).version).toBe(2);
    }).pipe(
      Effect.provideService(
        MobileSecureStorage,
        MobileSecureStorage.of({
          getItem: (key) => Effect.sync(() => values.get(key) ?? null),
          setItem: (key, value) =>
            Effect.sync(() => {
              values.set(key, value);
            }),
          removeItem: (key) =>
            Effect.sync(() => {
              values.delete(key);
            }),
        }),
      ),
    );
  });
});
