import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Enum-like columns carry no CHECK: their value sets grow across Squire phases,
// and SQLite can only widen a CHECK by rebuilding the table.
// No foreign keys, within Squire or across domains: the Squire reactor runs the
// cascades, so a deleted thread, project, or Squire is cleaned up in steps that
// resume at startup.
// Idempotent because Migrations.ts re-runs it whenever another build's ledger
// holds a different migration at this id.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS squire (
    id TEXT PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL, lifecycle TEXT NOT NULL,
    home_generation INTEGER NOT NULL DEFAULT 0, home_thread_id TEXT, home_project_id TEXT NOT NULL,
    provider_instance_id TEXT, model_selection_json TEXT, summary_model_selection_json TEXT,
    brief TEXT NOT NULL, status TEXT NOT NULL, events_json TEXT NOT NULL,
    permissions_json TEXT NOT NULL, budgets_json TEXT NOT NULL, undo_window_seconds INTEGER NOT NULL,
    digest_json TEXT, digest_last_date TEXT, onboarded_at TEXT, sweep_json TEXT,
    user_active_at TEXT, inactivity_prompted_at TEXT, automation_paused_at TEXT,
    companion_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    create_request_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    timezone TEXT
  )`;
  // Databases that ran an earlier 082 have the table without the Lead's timezone.
  const squireColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(squire)`;
  if (!squireColumns.some((column) => column.name === "timezone")) {
    yield* sql`ALTER TABLE squire ADD COLUMN timezone TEXT`;
  }
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS squire_one_lead ON squire(role) WHERE role = 'lead'`;

  yield* sql`CREATE TABLE IF NOT EXISTS squire_grant (
    squire_id TEXT NOT NULL, kind TEXT NOT NULL, target_id TEXT NOT NULL,
    origin TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(squire_id, kind, target_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS squire_grant_target ON squire_grant(kind, target_id)`;

  // AUTOINCREMENT: the id is the inject sequence, which must never be reused
  // after a cascade deletes the newest rows.
  yield* sql`CREATE TABLE IF NOT EXISTS squire_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT, squire_id TEXT NOT NULL, thread_id TEXT,
    kind TEXT NOT NULL, state_key TEXT NOT NULL, payload_json TEXT, status TEXT NOT NULL,
    defer_reason TEXT, not_before TEXT NOT NULL, batch_id TEXT, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS squire_event_key
    ON squire_event(squire_id, kind, ifnull(thread_id, ''), state_key)`;
  yield* sql`CREATE INDEX IF NOT EXISTS squire_event_thread ON squire_event(thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS squire_event_queue ON squire_event(status, not_before)`;

  yield* sql`CREATE TABLE IF NOT EXISTS squire_summary (
    thread_id TEXT NOT NULL, run_id TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL,
    summary_json TEXT NOT NULL, payer_squire_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(thread_id, run_id, stage)
  )`;
  // The overlap detector compares only recently summarized threads.
  yield* sql`CREATE INDEX IF NOT EXISTS squire_summary_recent ON squire_summary(updated_at)`;

  yield* sql`CREATE TABLE IF NOT EXISTS squire_card (
    id TEXT PRIMARY KEY, squire_id TEXT NOT NULL, owner_squire_id TEXT NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL, target_thread_id TEXT, project_id TEXT,
    title TEXT NOT NULL, why TEXT NOT NULL, payload_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL, trigger_json TEXT NOT NULL, intent_json TEXT,
    origin TEXT NOT NULL, steer_kind TEXT, routed_task_id TEXT, rule_id TEXT, finding_key TEXT,
    escalate_at TEXT, opened_at TEXT, executes_at TEXT, attempt INTEGER NOT NULL DEFAULT 0,
    command_id TEXT, execution_key TEXT UNIQUE, dedupe_key TEXT,
    replaced_count INTEGER NOT NULL DEFAULT 0, ask_json TEXT, resolution TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  // Holds are not open, so they never block a card.
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS squire_card_one_open
    ON squire_card(squire_id, target_thread_id, kind) WHERE status = 'open'`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS squire_card_open_dedupe
    ON squire_card(kind, dedupe_key) WHERE status = 'open'`;
  yield* sql`CREATE INDEX IF NOT EXISTS squire_card_target ON squire_card(target_thread_id)`;
  // Queue scans read open and held cards, a small slice once settled cards pile up.
  // SQLite uses a partial index only when the query repeats this WHERE term
  // literally, so SquireRepository adds it (SQUIRE_CARD_LIVE).
  yield* sql`CREATE INDEX IF NOT EXISTS squire_card_live
    ON squire_card(status, created_at) WHERE status IN ('open', 'held')`;

  yield* sql`CREATE TABLE IF NOT EXISTS squire_budget_usage (
    id INTEGER PRIMARY KEY, squire_id TEXT NOT NULL, thread_id TEXT, kind TEXT NOT NULL,
    room_id TEXT, executed_at TEXT NOT NULL, execution_key TEXT UNIQUE
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS squire_budget_usage_window ON squire_budget_usage(squire_id, executed_at)`;

  yield* sql`CREATE TABLE IF NOT EXISTS squire_action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, squire_id TEXT NOT NULL, kind TEXT NOT NULL,
    room_id TEXT, post_id INTEGER, trigger_id TEXT, task_id TEXT,
    thread_id TEXT, card_id TEXT, event_id INTEGER, run_id TEXT,
    invocation_key TEXT, execution_key TEXT, data_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS squire_action_log_invocation
    ON squire_action_log(invocation_key) WHERE kind = 'tool.called'`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS squire_action_log_execution
    ON squire_action_log(execution_key) WHERE kind = 'action.executed'`;
  yield* sql`CREATE INDEX IF NOT EXISTS squire_action_log_squire ON squire_action_log(squire_id, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS squire_action_log_card ON squire_action_log(card_id) WHERE card_id IS NOT NULL`;

  yield* sql`CREATE TABLE IF NOT EXISTS squire_rule (
    id TEXT PRIMARY KEY, squire_id TEXT NOT NULL, effect TEXT NOT NULL,
    action_class TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
    steer_kind TEXT, status TEXT NOT NULL, match_count INTEGER NOT NULL DEFAULT 0,
    last_matched_at TEXT, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS squire_rule_key ON squire_rule(
    squire_id, effect, action_class, target_kind, target_id, ifnull(steer_kind, '')
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS squire_trigger (
    id TEXT PRIMARY KEY, squire_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
    instruction TEXT NOT NULL, status TEXT NOT NULL, schedule_json TEXT, next_slot_at TEXT,
    secret_ref TEXT, secret_generation INTEGER NOT NULL DEFAULT 0,
    last_payload_excerpt TEXT, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS squire_trigger_squire ON squire_trigger(squire_id)`;

  yield* sql`CREATE TABLE IF NOT EXISTS squire_room (
    id TEXT PRIMARY KEY, topic TEXT NOT NULL, about_json TEXT NOT NULL, status TEXT NOT NULL,
    muted INTEGER NOT NULL DEFAULT 0, bot_messaging TEXT NOT NULL,
    idle_ttl_seconds INTEGER NOT NULL, creator_kind TEXT NOT NULL, proposal_event_id INTEGER,
    last_post_at TEXT NOT NULL, closed_reason TEXT, create_request_id TEXT UNIQUE,
    revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS squire_room_member (
    room_id TEXT NOT NULL, member_kind TEXT NOT NULL, member_id TEXT NOT NULL,
    read_cursor INTEGER NOT NULL DEFAULT 0, user_seen_cursor INTEGER,
    PRIMARY KEY(room_id, member_kind, member_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS squire_room_member_member ON squire_room_member(member_kind, member_id)`;

  // The room log only: direct messages live as squire_event rows and home-thread
  // messages. AUTOINCREMENT because room read cursors hold post ids, so an id
  // must never be reused.
  yield* sql`CREATE TABLE IF NOT EXISTS squire_room_post (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_key TEXT NOT NULL UNIQUE, room_id TEXT NOT NULL,
    author_kind TEXT NOT NULL, author_id TEXT, body TEXT NOT NULL,
    reply_to INTEGER, refs_json TEXT NOT NULL, hop INTEGER NOT NULL DEFAULT 0,
    routing_json TEXT NOT NULL, rerouted_from INTEGER, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS squire_room_post_room ON squire_room_post(room_id, id)`;

  yield* sql`CREATE TABLE IF NOT EXISTS squire_reactor_cursor (
    id INTEGER PRIMARY KEY CHECK(id = 1), sequence INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT OR IGNORE INTO squire_reactor_cursor(id, sequence, enabled) VALUES (1, 0, 0)`;
});
