import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { Schema } from "effect";
import {
  RelayDeviceRegistrationRequest,
  RelayLiveActivityRegistrationRequest,
} from "@lecturn/contracts/relay";
import { relayMobileDevices, relayLiveActivities } from "../persistence/schema.ts";
import { displacedTokenRows, displacedDeviceActivities } from "./PushTokenClaims.ts";

const isDeviceRegistration = Schema.is(RelayDeviceRegistrationRequest);
const isActivityRegistration = Schema.is(RelayLiveActivityRegistrationRequest);

for (const [table, tokenColumn, tokenName] of [
  [relayMobileDevices, relayMobileDevices.pushToken, "push_token"],
  [relayMobileDevices, relayMobileDevices.pushToStartToken, "push_to_start_token"],
  [relayLiveActivities, relayLiveActivities.activityPushToken, "activity_push_token"],
] as const) {
  describe(tokenName, () => {
    for (const [label, list, expected] of [
      [
        "retains only existing same-device listed accounts",
        ["A", "B", "unregistered"],
        ["A", "B", "different-token"],
      ],
      ["clears same-device unlisted accounts", ["B"], ["B", "different-token"]],
      ["legacy registration remains exclusive", undefined, ["different-token"]],
      [
        "deduplicates and retains caller even if omitted",
        ["A", "A"],
        ["A", "B", "different-token"],
      ],
    ] as const) {
      it(label, () => {
        const db = new NodeSqlite.DatabaseSync(":memory:");
        try {
          const tableName =
            table === relayMobileDevices ? "relay_mobile_devices" : "relay_live_activities";
          db.exec(`CREATE TABLE ${tableName}(user_id TEXT, device_id TEXT, ${tokenName} TEXT)`);
          const insert = db.prepare(`INSERT INTO ${tableName} VALUES (?, ?, ?)`);
          insert.run("A", "phone", "token");
          insert.run("B", "phone", "token");
          insert.run("C", "phone", "token");
          insert.run("other-device", "tablet", "token");
          insert.run("different-token", "phone", "other");
          const condition = new PgDialect().sqlToQuery(
            displacedTokenRows({
              tokenColumn,
              userColumn: table.userId,
              deviceColumn: table.deviceId,
              token: "token",
              userId: "B",
              deviceId: "phone",
              ...(list ? { deviceAccountIds: list } : {}),
            }),
          );
          db.prepare(
            `UPDATE ${tableName} SET ${tokenName}=NULL WHERE ${condition.sql.replace(/\$\d+/g, "?")}`,
          ).run(...(condition.params as string[]));
          const rows = db
            .prepare(
              `SELECT user_id FROM ${tableName} WHERE ${tokenName} IS NOT NULL ORDER BY user_id`,
            )
            .all();
          expect(rows.map((row) => row.user_id)).toEqual(expected);
        } finally {
          db.close();
        }
      });
    }
  });
}

it("rejects more than five retained accounts on both wire requests", () => {
  const deviceAccountIds = ["A", "B", "C", "D", "E", "F"];
  expect(
    isActivityRegistration({
      deviceId: "phone",
      activityPushToken: "token",
      deviceAccountIds,
    }),
  ).toBe(false);
  expect(
    isDeviceRegistration({
      deviceId: "phone",
      label: "Phone",
      platform: "ios",
      iosMajorVersion: 18,
      deviceAccountIds,
      preferences: {
        notificationsEnabled: false,
        notifyOnApproval: false,
        notifyOnInput: false,
        notifyOnCompletion: false,
        notifyOnFailure: false,
        liveActivitiesEnabled: false,
      },
    }),
  ).toBe(false);
});

it("retires displaced accounts' separate cards without ending the caller's card", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE relay_mobile_devices(user_id TEXT, device_id TEXT, push_token TEXT); CREATE TABLE relay_live_activities(user_id TEXT, device_id TEXT, activity_push_token TEXT);",
    );
    for (const user of ["A", "B", "C"]) {
      db.prepare("INSERT INTO relay_mobile_devices VALUES(?, 'phone', ?)").run(
        user,
        user === "C" ? "unrelated-token" : "shared-token",
      );
      db.prepare("INSERT INTO relay_live_activities VALUES(?, 'phone', ?)").run(
        user,
        `${user}-card`,
      );
    }
    const condition = displacedDeviceActivities(
      displacedTokenRows({
        tokenColumn: relayMobileDevices.pushToken,
        userColumn: relayMobileDevices.userId,
        deviceColumn: relayMobileDevices.deviceId,
        token: "shared-token",
        userId: "B",
        deviceId: "phone",
        deviceAccountIds: ["B"],
      }),
      "B",
      "phone",
    );
    const query = new PgDialect().sqlToQuery(condition);
    db.prepare(
      `UPDATE relay_live_activities SET activity_push_token=NULL WHERE ${query.sql.replace(/\$\d+/g, "?")}`,
    ).run(...(query.params as string[]));
    expect(
      db
        .prepare(
          "SELECT user_id FROM relay_live_activities WHERE activity_push_token IS NOT NULL ORDER BY user_id",
        )
        .all()
        .map((row) => row.user_id),
    ).toEqual(["B", "C"]);
  } finally {
    db.close();
  }
});
