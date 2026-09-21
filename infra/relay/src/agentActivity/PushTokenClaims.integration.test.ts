import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Effect, Layer, Redacted } from "effect";
import { RelayDb } from "../db.ts";
import { Devices, layer as deviceLayer } from "./Devices.ts";
import { LiveActivities, layer as activityLayer } from "./LiveActivities.ts";

const url = process.env.RELAY_PUSH_TEST_DATABASE_URL;
const database = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(url ?? "postgresql://127.0.0.1/unused") })),
);
const services = Layer.mergeAll(deviceLayer, activityLayer).pipe(Layer.provideMerge(database));
const preferences = {
  notificationsEnabled: false,
  notifyOnApproval: false,
  notifyOnInput: false,
  notifyOnCompletion: false,
  notifyOnFailure: false,
  liveActivitiesEnabled: false,
};

describe.skipIf(!url)("PostgreSQL token ownership", () => {
  it.effect(
    "serializes concurrent first claims and preserves only same-device listed users",
    () =>
      Effect.gen(function* () {
        const db = yield* RelayDb;
        const devices = yield* Devices;
        const activities = yield* LiveActivities;
        const prefix = `push-test-${NodeCrypto.randomUUID()}`;
        const a = `${prefix}-A`,
          b = `${prefix}-B`,
          token = `${prefix}-token`;
        const register = (userId: string, deviceId: string, deviceAccountIds?: readonly string[]) =>
          devices.register({
            userId,
            registration: {
              deviceId,
              label: "Push test",
              platform: "ios",
              iosMajorVersion: 18,
              pushToken: token,
              pushToStartToken: token,
              preferences,
              ...(deviceAccountIds ? { deviceAccountIds } : {}),
            },
          });
        const active = () =>
          db.$client<{
            user_id: string;
            device_id: string;
          }>`SELECT user_id, device_id FROM relay_mobile_devices WHERE push_token=${token} ORDER BY user_id`;
        yield* Effect.gen(function* () {
          yield* Effect.all([register(a, "phone", [a, b]), register(b, "tablet", [a, b])], {
            concurrency: 2,
          });
          expect(yield* active()).toHaveLength(1);
          yield* register(a, "phone", [a, b]);
          yield* register(b, "phone", [a, b]);
          expect((yield* active()).map((row) => row.user_id)).toEqual([a, b]);
          yield* register(b, "phone", [b]);
          expect((yield* active()).map((row) => row.user_id)).toEqual([b]);
          yield* register(a, "phone");
          expect((yield* active()).map((row) => row.user_id)).toEqual([a]);
          const activity = (userId: string, deviceId: string) =>
            activities.register({
              userId,
              registration: { deviceId, activityPushToken: token, deviceAccountIds: [a, b] },
            });
          yield* Effect.all([activity(a, "phone"), activity(b, "tablet")], { concurrency: 2 });
          expect(
            yield* db.$client`SELECT user_id FROM relay_live_activities WHERE activity_push_token=${token}`,
          ).toHaveLength(1);
          yield* activity(a, "phone");
          yield* activity(b, "phone");
          expect(
            yield* db.$client`SELECT user_id FROM relay_live_activities WHERE activity_push_token=${token}`,
          ).toHaveLength(2);
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* db.$client`DELETE FROM relay_live_activities WHERE user_id IN (${a},${b})`;
              yield* db.$client`DELETE FROM relay_mobile_devices WHERE user_id IN (${a},${b})`;
              yield* db.$client`DELETE FROM relay_push_token_owners WHERE token=${token}`;
            }).pipe(Effect.orDie),
          ),
        );
      }).pipe(Effect.provide(services)),
    30_000,
  );
});
