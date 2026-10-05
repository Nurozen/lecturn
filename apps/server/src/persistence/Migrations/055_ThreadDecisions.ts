import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE decision_project_settings (
    project_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '', config_revision INTEGER NOT NULL DEFAULT 0,
    cancellation_epoch INTEGER NOT NULL DEFAULT 0, activation_sequence INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, activated_at TEXT,
    funding_json TEXT
  )`;
  yield* sql`CREATE TABLE decision_thread_state (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    tracking_override TEXT NOT NULL DEFAULT 'inherit' CHECK(tracking_override IN ('inherit', 'paused')),
    pause_epoch INTEGER NOT NULL DEFAULT 0, source_generation INTEGER NOT NULL DEFAULT 0,
    generation_sequence INTEGER NOT NULL DEFAULT 0,
    activation_sequence INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX decision_thread_project ON decision_thread_state(project_id)`;
  yield* sql`CREATE TABLE decision_sources (
    thread_id TEXT NOT NULL, message_id TEXT NOT NULL, source_generation INTEGER NOT NULL,
    project_id TEXT NOT NULL, source_hash TEXT NOT NULL, source_sequence INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')), created_at TEXT NOT NULL,
    PRIMARY KEY(thread_id, message_id, source_generation)
  )`;
  yield* sql`CREATE INDEX decision_sources_order ON decision_sources(thread_id, source_generation, source_sequence, message_id)`;
  yield* sql`CREATE TABLE thread_decisions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, thread_title TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, rationale TEXT, comment TEXT,
    attribution TEXT NOT NULL CHECK(attribution IN ('user-directed', 'user-accepted', 'agent-chosen')),
    review_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_state IN ('unreviewed', 'confirmed', 'dismissed')),
    lifecycle TEXT NOT NULL DEFAULT 'current' CHECK(lifecycle IN ('current', 'superseded')),
    user_edited INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
    source_sequence INTEGER NOT NULL, occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, provenance_json TEXT NOT NULL,
    action_key TEXT NOT NULL UNIQUE
  )`;
  yield* sql`CREATE INDEX thread_decisions_project_order ON thread_decisions(project_id, occurred_at DESC, source_sequence DESC, id DESC)`;
  yield* sql`CREATE INDEX thread_decisions_thread_order ON thread_decisions(thread_id, source_sequence, id)`;
  yield* sql`CREATE TABLE decision_evidence (
    id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')), source_hash TEXT NOT NULL,
    source_generation INTEGER NOT NULL, canonical_version TEXT NOT NULL,
    quote TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
    prefix TEXT NOT NULL, suffix TEXT NOT NULL, source_sequence INTEGER NOT NULL,
    UNIQUE(decision_id, thread_id, message_id, source_hash, start_offset, end_offset)
  )`;
  yield* sql`CREATE INDEX decision_evidence_note ON decision_evidence(decision_id)`;
  yield* sql`CREATE INDEX decision_evidence_source ON decision_evidence(thread_id, message_id, source_hash)`;
  yield* sql`CREATE TABLE decision_relationships (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, predecessor_id TEXT NOT NULL, successor_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('proposed', 'accepted', 'rejected', 'undone')),
    predecessor_revision INTEGER NOT NULL, successor_revision INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK(predecessor_id <> successor_id), UNIQUE(predecessor_id, successor_id)
  )`;
  yield* sql`CREATE INDEX decision_relationship_project ON decision_relationships(project_id)`;
  yield* sql`CREATE TABLE decision_suppression (
    project_id TEXT NOT NULL, fingerprint TEXT NOT NULL, decision_id TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, fingerprint)
  )`;
  yield* sql`CREATE TABLE decision_scans (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT, preview_key TEXT UNIQUE,
    state TEXT NOT NULL, cancellation_epoch INTEGER NOT NULL DEFAULT 0,
    from_sequence INTEGER NOT NULL, through_sequence INTEGER NOT NULL,
    include_suppressed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE decision_jobs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    consumer_id TEXT NOT NULL, scan_id TEXT, state TEXT NOT NULL, source_message_id TEXT NOT NULL DEFAULT '',
    source_generation INTEGER NOT NULL, from_sequence INTEGER NOT NULL, through_sequence INTEGER NOT NULL,
    config_revision INTEGER NOT NULL, description TEXT NOT NULL, cancellation_epoch INTEGER NOT NULL,
    pause_epoch INTEGER NOT NULL, fingerprint TEXT NOT NULL, run_id TEXT NOT NULL,
    stage_json TEXT NOT NULL DEFAULT '{}', provider_binding_json TEXT,
    lease_owner TEXT, lease_until TEXT, fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(consumer_id, fingerprint)
  )`;
  yield* sql`CREATE INDEX decision_jobs_claim ON decision_jobs(state, lease_until, created_at)`;
  yield* sql`CREATE INDEX decision_jobs_thread ON decision_jobs(thread_id, state)`;
  yield* sql`CREATE INDEX decision_jobs_project ON decision_jobs(project_id, state)`;
  yield* sql`CREATE TABLE decision_evaluations (
    fingerprint TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_id TEXT NOT NULL,
    result_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE decision_coverage (
    consumer_id TEXT NOT NULL, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, source_message_id TEXT NOT NULL DEFAULT '',
    source_generation INTEGER NOT NULL, from_sequence INTEGER NOT NULL, through_sequence INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'complete', 'incomplete', 'unscanned', 'canceled')),
    reason TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY(consumer_id, thread_id, source_generation, from_sequence, through_sequence, source_message_id)
  )`;
  yield* sql`CREATE INDEX decision_coverage_project ON decision_coverage(project_id, thread_id, from_sequence)`;
  yield* sql`CREATE TABLE decision_ingestion_cursor (id INTEGER PRIMARY KEY CHECK(id = 1), sequence INTEGER NOT NULL)`;
  yield* sql`INSERT INTO decision_ingestion_cursor(id, sequence) VALUES (1, 0)`;
  yield* sql`CREATE TABLE decision_outbox (
    project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, published_revision INTEGER NOT NULL DEFAULT 0
  )`;
});
