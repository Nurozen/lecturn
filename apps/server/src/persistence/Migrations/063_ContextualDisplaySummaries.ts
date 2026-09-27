import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Display summaries are purgeable derived source text, never orchestration event payloads. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE contextual_display_summaries (
    packet_id TEXT PRIMARY KEY, text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 600)
  )`;
  yield* sql`CREATE TRIGGER contextual_summary_packet_update AFTER UPDATE OF packet_json,retention ON contextual_packets
    WHEN NEW.packet_json IS NOT OLD.packet_json OR NEW.retention IS NOT OLD.retention
    BEGIN DELETE FROM contextual_display_summaries WHERE packet_id=NEW.id; END`;
  yield* sql`CREATE TRIGGER contextual_summary_packet_delete AFTER DELETE ON contextual_packets
    BEGIN DELETE FROM contextual_display_summaries WHERE packet_id=OLD.id; END`;
  yield* sql`CREATE TRIGGER contextual_summary_host_update AFTER UPDATE OF source_revision,purge_generation,funding_generation ON contextual_host_state
    WHEN NEW.source_revision != OLD.source_revision OR NEW.purge_generation != OLD.purge_generation OR NEW.funding_generation != OLD.funding_generation
    BEGIN DELETE FROM contextual_display_summaries; END`;
  yield* sql`CREATE TRIGGER contextual_summary_thread_update AFTER UPDATE OF revision,exclusion_revision ON contextual_thread_settings
    WHEN NEW.revision != OLD.revision OR NEW.exclusion_revision != OLD.exclusion_revision
    BEGIN DELETE FROM contextual_display_summaries WHERE packet_id IN (SELECT id FROM contextual_packets WHERE thread_id=NEW.thread_id); END`;
  yield* sql`CREATE TRIGGER contextual_summary_project_update AFTER UPDATE OF revision ON contextual_project_settings
    WHEN NEW.revision != OLD.revision
    BEGIN DELETE FROM contextual_display_summaries WHERE packet_id IN (SELECT id FROM contextual_packets WHERE json_extract(packet_json,'$.task.projectId')=NEW.project_id); END`;
});
