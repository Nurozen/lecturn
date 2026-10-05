import { and, eq, inArray, not, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import * as RelayDb from "../db.ts";
import {
  relayPushTokenOwners,
  relayMobileDevices,
  relayLiveActivities,
} from "../persistence/schema.ts";

/** Only existing rows holding this token on this device may be retained. */
export function displacedTokenRows(input: {
  tokenColumn: PgColumn;
  userColumn: PgColumn;
  deviceColumn: PgColumn;
  token: string;
  userId: string;
  deviceId: string;
  deviceAccountIds?: readonly string[];
}): SQL {
  const token = eq(input.tokenColumn, input.token);
  if (input.deviceAccountIds === undefined) return token;
  const accounts = [...new Set([input.userId, ...input.deviceAccountIds])].slice(0, 5);
  return and(
    token,
    not(and(eq(input.deviceColumn, input.deviceId), inArray(input.userColumn, accounts))!),
  )!;
}

export const claimPushToken = Effect.fn("relay.push_tokens.claim")(function* (
  db: RelayDb.RelayDb["Service"],
  input: {
    kind: "push" | "push_to_start" | "activity";
    token: string;
    deviceId: string;
  },
) {
  // ON CONFLICT UPDATE holds a PostgreSQL row lock until the surrounding
  // registration transaction commits; Hyperdrive supports this lock path.
  yield* db
    .insert(relayPushTokenOwners)
    .values(input)
    .onConflictDoUpdate({
      target: [relayPushTokenOwners.kind, relayPushTokenOwners.token],
      set: { deviceId: input.deviceId },
    });
});

/** A claimed device token proves which prior account cards this install may retire. */
export function displacedDeviceActivities(condition: SQL, userId: string, deviceId: string): SQL {
  return and(
    not(and(eq(relayLiveActivities.userId, userId), eq(relayLiveActivities.deviceId, deviceId))!),
    sql`exists (select 1 from ${relayMobileDevices} where ${condition}
      and ${relayMobileDevices.userId} = ${relayLiveActivities.userId}
      and ${relayMobileDevices.deviceId} = ${relayLiveActivities.deviceId})`,
  )!;
}
