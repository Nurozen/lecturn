import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BillingError } from "./BillingStore.ts";
import { clerkIdentityLookup, reconcileIdentity } from "./BillingOperations.ts";

describe("missed Clerk deletion compensation", () => {
  it.effect(
    "tombstones only a confirmed missing identity with a stable reconciliation receipt",
    () => {
      const tombstones: unknown[] = [];
      return Effect.gen(function* () {
        const tombstone = (user: string, now: number, event: string) =>
          Effect.sync(() => {
            tombstones.push({ user, now, event });
          });
        yield* reconcileIdentity("user_kept", 100, () => Effect.succeed("present"), tombstone);
        yield* reconcileIdentity("user_deleted", 100, () => Effect.succeed("missing"), tombstone);
        expect(tombstones).toEqual([
          { user: "user_deleted", now: 100, event: "identity-reconcile:user_deleted" },
        ]);
      });
    },
  );
  it.effect("a transient identity error never tombstones or acknowledges deletion", () => {
    let writes = 0;
    return Effect.gen(function* () {
      const result = yield* reconcileIdentity(
        "user",
        100,
        () => Effect.fail(new BillingError({ code: "unavailable", message: "temporary" })),
        () =>
          Effect.sync(() => {
            writes++;
          }),
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(writes).toBe(0);
    });
  });
  it.effect("failed tombstone persistence is retryable", () =>
    Effect.gen(function* () {
      const result = yield* reconcileIdentity(
        "user",
        100,
        () => Effect.succeed("missing"),
        () => Effect.fail(new BillingError({ code: "persistence", message: "offline" })),
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );
  for (const status of [401, 403, 429, 500, 502]) {
    it.effect(`treats Clerk HTTP ${status} as uncertainty`, () =>
      Effect.gen(function* () {
        const lookup = clerkIdentityLookup("sk_test", async () => new Response("{}", { status }));
        expect((yield* lookup("user").pipe(Effect.result))._tag).toBe("Failure");
      }),
    );
  }
  it.effect("requires a Clerk-shaped 404 and validates successful identity responses", () =>
    Effect.gen(function* () {
      expect(
        yield* clerkIdentityLookup("sk_test", async () =>
          Response.json({ errors: [{ code: "resource_not_found" }] }, { status: 404 }),
        )("user"),
      ).toBe("missing");
      expect(
        yield* clerkIdentityLookup("sk_test", async () => Response.json({ id: "user" }))("user"),
      ).toBe("present");
      for (const response of [
        new Response("proxy error", { status: 404 }),
        Response.json({ id: "other" }),
      ])
        expect(
          (yield* clerkIdentityLookup("sk_test", async () => response)("user").pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
      expect(
        (yield* clerkIdentityLookup("sk_test", async () => {
          throw new Error("timeout");
        })("user").pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  );
});
