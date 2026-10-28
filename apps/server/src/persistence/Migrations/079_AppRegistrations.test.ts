import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import AppRegistrations from "./079_AppRegistrations.ts";
import ProjectionProjectsAppBinding from "./080_ProjectionProjectsAppBinding.ts";

const columnNames = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_info(${table})`;
    return rows.map((row) => row.name);
  });

const at = "2026-10-25T00:00:00.000Z";

describe("079 app registrations", () => {
  it.effect("creates the registration and pairing request tables", () =>
    Effect.gen(function* () {
      const executed = yield* runMigrations({ toMigrationInclusive: 79 });
      assert.deepEqual(executed.at(-1), [79, "AppRegistrations"]);
      assert.sameMembers(yield* columnNames("app_registrations"), [
        "app_id",
        "registration_json",
        "state",
        "granted_fingerprint",
        "runtime_ceiling",
        "cached_headless_tools_json",
        "cached_live_tools_json",
        "last_seen_at",
        "created_at",
        "updated_at",
      ]);
      assert.sameMembers(yield* columnNames("app_pairing_requests"), [
        "request_id",
        "app_id",
        "registration_json",
        "poll_secret_hash",
        "state",
        "expires_at",
        "credential_delivered",
        "created_at",
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("runs again without touching existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO app_registrations
        (app_id, registration_json, state, created_at, updated_at)
        VALUES ('dev.example.app', '{}', 'granted', ${at}, ${at})`;

      yield* AppRegistrations;
      yield* ProjectionProjectsAppBinding;

      assert.deepEqual(yield* sql`SELECT app_id, state FROM app_registrations`, [
        { app_id: "dev.example.app", state: "granted" },
      ]);
      assert.includeMembers(yield* columnNames("projection_projects"), [
        "app_id",
        "app_workspace_root",
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
