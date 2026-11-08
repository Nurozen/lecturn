import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0091 from "./091_SquireChatFirst.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const seededAt = "2026-10-01T00:00:00.000Z";

interface Seed {
  readonly id: string;
  readonly kind: string;
  readonly status?: string;
  readonly origin?: string;
  readonly payload?: unknown;
}

const seeds: ReadonlyArray<Seed> = [
  { id: "fyi-summary", kind: "fyi", payload: { type: "fyi", source: "summary" } },
  { id: "fyi-digest", kind: "fyi", payload: { type: "fyi", source: "digest" } },
  { id: "fyi-inactivity", kind: "fyi", payload: { type: "fyi", source: "inactivity" } },
  { id: "steer-event", kind: "steer", origin: "event" },
  { id: "steer-sweep", kind: "steer", origin: "sweep" },
  { id: "steer-user", kind: "steer", origin: "user" },
  { id: "steer-voice", kind: "steer", origin: "voice" },
  { id: "steer-held", kind: "steer", origin: "event", status: "held" },
  { id: "steer-accepting", kind: "steer", origin: "event", status: "accepting" },
  { id: "proposal-event", kind: "proposal", origin: "event", payload: { type: "thread-proposal" } },
  { id: "proposal-user", kind: "proposal", origin: "user", payload: { type: "thread-proposal" } },
  {
    id: "merge-user",
    kind: "proposal",
    origin: "user",
    payload: { type: "control", action: "merge" },
  },
  {
    id: "pause-user",
    kind: "proposal",
    origin: "user",
    payload: { type: "control", action: "pause" },
  },
  { id: "question-event", kind: "question", origin: "event" },
  { id: "overlap-event", kind: "overlap", origin: "event" },
  {
    id: "fyi-dismissed",
    kind: "fyi",
    status: "dismissed",
    payload: { type: "fyi", source: "summary" },
  },
];

const closed = [
  "fyi-digest",
  "fyi-summary",
  "merge-user",
  "proposal-event",
  "steer-event",
  "steer-sweep",
];

layer("091_SquireChatFirst", (it) => {
  it.effect("closes the backlog once, without waking the Lead", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 90 });
      for (const [index, seed] of seeds.entries()) {
        yield* sql`
          INSERT INTO squire_card (
            id, squire_id, owner_squire_id, kind, status, target_thread_id, title, why,
            payload_json, evidence_json, trigger_json, origin, created_at, updated_at
          )
          VALUES (
            ${seed.id}, ${"squire-1"}, ${"squire-1"}, ${seed.kind}, ${seed.status ?? "open"},
            ${`thread-${index}`}, 'Title', 'Why', ${JSON.stringify(seed.payload ?? {})}, '{}', '{}',
            ${seed.origin ?? "event"}, ${seededAt}, ${seededAt}
          )
        `;
      }

      yield* runMigrations();

      const read = () =>
        sql<{
          readonly id: string;
          readonly status: string;
          readonly resolution: string | null;
          readonly updated_at: string;
          readonly expires_at: string | null;
        }>`SELECT id, status, resolution, updated_at, expires_at FROM squire_card ORDER BY id`;
      const first = yield* read();
      const statusOf = (id: string) => first.find((row) => row.id === id)?.status;

      assert.deepStrictEqual(
        first.filter((row) => row.status === "outdated").map((row) => row.id),
        closed,
      );
      for (const row of first.filter((entry) => entry.status === "outdated")) {
        assert.strictEqual(row.resolution, "outdated");
        assert.notStrictEqual(row.updated_at, seededAt);
        assert.isNull(row.expires_at);
      }
      assert.strictEqual(statusOf("fyi-inactivity"), "open");
      assert.strictEqual(statusOf("steer-user"), "open");
      assert.strictEqual(statusOf("steer-voice"), "open");
      assert.strictEqual(statusOf("steer-held"), "held");
      assert.strictEqual(statusOf("steer-accepting"), "accepting");
      assert.strictEqual(statusOf("proposal-user"), "open");
      assert.strictEqual(statusOf("pause-user"), "open");
      assert.strictEqual(statusOf("question-event"), "open");
      assert.strictEqual(statusOf("overlap-event"), "open");
      assert.strictEqual(statusOf("fyi-dismissed"), "dismissed");

      assert.deepStrictEqual(yield* sql`SELECT id FROM squire_event`, []);

      yield* Migration0091;
      assert.deepStrictEqual(yield* read(), first);
    }),
  );

  it.effect("leaves a database that has no card table yet alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE squire_card RENAME TO squire_card_kept`;
      yield* Migration0091;
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'squire_card'`,
        [],
      );
      yield* sql`ALTER TABLE squire_card_kept RENAME TO squire_card`;
    }),
  );
});
