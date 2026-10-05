import { ConnectionTransientError } from "@lecturn/client-runtime/connection";
import { ConnectionCatalogDocument } from "@lecturn/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import { makeCatalogBackend, makeCatalogStore, planCatalogQuarantine } from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeCatalogStore", () => {
  it.effect("keeps an undecodable catalog in place and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toEqual([]);

      yield* store.update((document) => ({ ...document }));
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("refuses to overwrite an undecodable catalog that has no quarantine copy", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "quota exceeded",
      });
      const writes: string[] = [];
      const quarantined: string[] = [];
      let quarantineFails = true;
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) =>
          quarantineFails ? Effect.fail(failure) : Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(yield* Effect.flip(store.update((document) => ({ ...document })))).toBe(failure);
      expect(writes).toEqual([]);

      quarantineFails = false;
      yield* store.update((document) => ({ ...document }));
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("planCatalogQuarantine", () => {
  it("keeps a bounded number of quarantined catalogs, dropping the oldest", () => {
    const existing = [1, 2, 3].map((time) => ({
      key: `document:corrupt:${time}`,
      value: `blob-${time}`,
    }));

    expect(planCatalogQuarantine(existing, "blob-4", 4)).toEqual({
      put: "document:corrupt:4",
      remove: ["document:corrupt:1"],
    });
    expect(planCatalogQuarantine([], "blob-1", 1)).toEqual({
      put: "document:corrupt:1",
      remove: [],
    });
  });

  it("does not store the same blob twice", () => {
    const existing = [{ key: "document:corrupt:1", value: "blob-1" }];

    expect(planCatalogQuarantine(existing, "blob-1", 2)).toEqual({ put: null, remove: [] });
  });
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});
