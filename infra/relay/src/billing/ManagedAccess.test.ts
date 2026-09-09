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

it.effect(
  "rejects old or unknown notification windows while keeping ordinary access available",
  () =>
    Effect.gen(function* () {
      const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      for (const accessWindowStart of [undefined, time]) {
        const service = make(() =>
          Effect.succeed({
            ...account(time),
            state: {
              accessUntil: time + 100,
              ...(accessWindowStart === undefined ? {} : { accessWindowStart }),
            },
          }),
        );
        yield* service.check("owner", "managedConnect");
        expect(
          (yield* service.check("owner", "pushNotifications", time - 1).pipe(Effect.flip))._tag,
        ).toBe("ManagedAccessRequired");
      }
    }),
);

it.effect(
  "accepts continuous-window delivery and subsecond job creation while rejecting invalid origins",
  () =>
    Effect.gen(function* () {
      const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const service = make(() =>
        Effect.succeed({
          ...account(time),
          state: { accessUntil: time + 100, accessWindowStart: time - 100 },
        }),
      );
      yield* service.check("owner", "pushNotifications", time - 100);
      yield* service.check("owner", "liveActivities", time + 0.999);
      for (const origin of [NaN, Infinity, time + 2, time - 100.001])
        expect(
          (yield* service.check("owner", "pushNotifications", origin).pipe(Effect.flip))._tag,
        ).toBe("ManagedAccessRequired");
    }),
);

it.effect("observe and disabled rollback service ignores old notification origin windows", () =>
  disabled.check("any-user", "pushNotifications", -1000),
);

it.effect("payment cohort exemptions never exempt deleted recipients", () =>
  Effect.gen(function* () {
    const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const deleted = { ...account(time), deleted_at: time };
    for (const enforce of [true, false]) {
      const service = make(() => Effect.succeed(deleted), [], enforce);
      expect((yield* Effect.flip(service.check("owner", "pushNotifications")))._tag).toBe(
        "ManagedAccessRequired",
      );
    }
    yield* make(() => Effect.succeed(account(time)), [], true).check("owner", "pushNotifications");
  }),
);
