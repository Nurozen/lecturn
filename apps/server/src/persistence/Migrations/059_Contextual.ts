import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Purgeable Contextual state stays outside the immutable orchestration log. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE contextual_host_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), source_policy_json TEXT NOT NULL,
    source_revision INTEGER NOT NULL DEFAULT 0, purge_generation INTEGER NOT NULL DEFAULT 0,
    funding_generation INTEGER NOT NULL DEFAULT 0, capture_requested INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE contextual_project_settings (
    project_id TEXT PRIMARY KEY, default_enabled INTEGER NOT NULL DEFAULT 0,
    source_ids_json TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE contextual_thread_settings (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
    source_ids_json TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 0,
    exclusion_revision INTEGER NOT NULL DEFAULT 0, refresh_epoch INTEGER NOT NULL DEFAULT 0,
    context_epoch TEXT NOT NULL DEFAULT 'initial', origin_applied INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX contextual_thread_project ON contextual_thread_settings(project_id)`;
  yield* sql`INSERT INTO contextual_thread_settings(thread_id, project_id, origin_applied, updated_at)
    SELECT thread_id, project_id, 1, updated_at FROM projection_threads`;
  yield* sql`CREATE TABLE contextual_exclusions (
    thread_id TEXT NOT NULL, guidance_id TEXT NOT NULL, action_id TEXT NOT NULL,
    PRIMARY KEY(thread_id, guidance_id)
  )`;
  yield* sql`CREATE TABLE contextual_preparations (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, project_id TEXT NOT NULL,
    submission_id TEXT NOT NULL, message_id TEXT NOT NULL, state TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, preparation_json TEXT NOT NULL,
    dispatch_id TEXT, continuation_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(thread_id, submission_id), UNIQUE(dispatch_id)
  )`;
  yield* sql`CREATE INDEX contextual_preparation_queue ON contextual_preparations(thread_id, created_at, id)`;
  yield* sql`CREATE TABLE contextual_turn_queue (
    event_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, thread_id TEXT NOT NULL,
    preparation_id TEXT, dispatch_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'queued',
    event_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX contextual_turn_queue_thread ON contextual_turn_queue(thread_id, sequence)`;
  yield* sql`CREATE TABLE contextual_turn_watermarks (
    thread_id TEXT PRIMARY KEY, through_sequence INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE contextual_packets (
    id TEXT PRIMARY KEY, preparation_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
    packet_json TEXT, payload_bytes INTEGER NOT NULL, retention TEXT NOT NULL DEFAULT 'available',
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE contextual_receipts (
    id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
    packet_id TEXT, receipt_json TEXT NOT NULL, received_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX contextual_receipt_thread ON contextual_receipts(thread_id, received_at, id)`;
  yield* sql`CREATE TABLE contextual_supply (
    thread_id TEXT NOT NULL, guidance_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    context_epoch TEXT NOT NULL, packet_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
    message_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
    acceptance TEXT NOT NULL, supplied_at TEXT NOT NULL,
    PRIMARY KEY(thread_id, guidance_id, fingerprint, context_epoch)
  )`;
  yield* sql`CREATE TABLE contextual_context_boundaries (
    thread_id TEXT NOT NULL, boundary_key TEXT NOT NULL, context_epoch TEXT NOT NULL,
    PRIMARY KEY(thread_id,boundary_key)
  )`;
  yield* sql`CREATE TABLE contextual_inherited_disclosures (
    thread_id TEXT NOT NULL, message_id TEXT NOT NULL, origin_thread_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL, packet_id TEXT,
    PRIMARY KEY(thread_id,receipt_id)
  )`;
  yield* sql`CREATE TABLE contextual_lineage (
    source_id TEXT NOT NULL, source_evidence_id TEXT NOT NULL, entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL, PRIMARY KEY(source_id, source_evidence_id, entity_kind, entity_id)
  )`;
  yield* sql`CREATE INDEX contextual_lineage_entity ON contextual_lineage(entity_kind, entity_id)`;
  yield* sql`CREATE TABLE contextual_purge_jobs (
    id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL UNIQUE,
    selection_json TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE contextual_suppression (
    entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, generation INTEGER NOT NULL,
    PRIMARY KEY(entity_kind, entity_id)
  )`;
  yield* sql`CREATE TABLE contextual_evaluations (
    fingerprint TEXT PRIMARY KEY, feature_id TEXT NOT NULL, policy_version TEXT NOT NULL,
    purge_generation INTEGER NOT NULL, result_json TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE contextual_conflicts (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, preparation_id TEXT,
    revision INTEGER NOT NULL, relation_json TEXT, resolution_json TEXT,
    status TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX contextual_conflict_thread ON contextual_conflicts(thread_id, status, id)`;
  yield* sql`CREATE TABLE contextual_decision_groups (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, canonical_decision_id TEXT NOT NULL,
    revision INTEGER NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE contextual_group_members (
    decision_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, occurrence_revision INTEGER NOT NULL,
    merge_id TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX contextual_group_members_group ON contextual_group_members(group_id, decision_id)`;
  yield* sql`CREATE TABLE contextual_actions (
    action_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE contextual_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
    revision INTEGER NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, occurred_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX contextual_outbox_thread ON contextual_outbox(thread_id, sequence)`;
});
