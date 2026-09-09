import { expect, it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { BillingError, type BillingAccount } from "./BillingStore.ts";
import { disabled, make } from "./ManagedAccess.ts";

const account = (time: number): BillingAccount => ({
  user_id: "owner",
  customer_id: "cus_test",
  deleted_at: null,
  generation: 1,
  updated_at: time,
  lease_token: null,
  state: { accessUntil: time + 100 },
});
it.effect("allows every included feature from a current canonical entitlement", () =>
  Effect.gen(function* () {
    const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const service = make((id) => Effect.succeed(id === "owner" ? account(time) : undefined));
    for (const feature of ["managedConnect", "pushNotifications", "liveActivities"] as const)
      yield* service.check("owner", feature);
    expect((yield* Effect.flip(service.check("other", "managedConnect")))._tag).toBe(
      "ManagedAccessRequired",
    );
  }),
);
it.effect("separates expired/deleted access from stale or unavailable storage", () =>
  Effect.gen(function* () {
    const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    for (const value of [
      { ...account(time), state: { accessUntil: time } },
      { ...account(time), deleted_at: time },
    ])
      expect(
        (yield* Effect.flip(make(() => Effect.succeed(value)).check("owner", "managedConnect")))
          ._tag,
      ).toBe("ManagedAccessRequired");
    for (const updated_at of [time - 900, time + 1])
      expect(
        (yield* Effect.flip(
          make(() => Effect.succeed({ ...account(time), updated_at })).check(
            "owner",
            "managedConnect",
          ),
        ))._tag,
      ).toBe("ManagedAccessUnavailable");
    expect(
      (yield* Effect.flip(
        make(() =>
          Effect.fail(new BillingError({ code: "persistence", message: "offline" })),
        ).check("owner", "managedConnect"),
      ))._tag,
    ).toBe("ManagedAccessUnavailable");
  }),
);
it.effect("disabled mode needs neither billing storage nor payment", () =>
  disabled.check("any-user", "managedConnect"),
);
