import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE decision_relation_queue (
    decision_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE decision_relation_suggestions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, left_id TEXT NOT NULL, right_id TEXT NOT NULL,
    left_revision INTEGER NOT NULL, right_revision INTEGER NOT NULL, canonical_id TEXT NOT NULL,
    kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'suggested', model TEXT NOT NULL,
    policy_version TEXT NOT NULL, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX decision_relation_suggestions_project ON decision_relation_suggestions(project_id,left_id,right_id)`;
  // New and revised notes only: installing the feature never backfills paid work.
  yield* sql`CREATE TRIGGER decision_relation_created AFTER INSERT ON thread_decisions BEGIN
    INSERT OR REPLACE INTO decision_relation_queue VALUES(NEW.id,NEW.project_id,NEW.revision,'queued',NEW.updated_at);
  END`;
  yield* sql`CREATE TRIGGER decision_relation_changed AFTER UPDATE OF revision ON thread_decisions BEGIN
    INSERT OR REPLACE INTO decision_relation_queue VALUES(NEW.id,NEW.project_id,NEW.revision,'queued',NEW.updated_at);
    DELETE FROM decision_relation_suggestions WHERE left_id=NEW.id OR right_id=NEW.id;
  END`;
  yield* sql`CREATE TRIGGER decision_relation_deleted AFTER DELETE ON thread_decisions BEGIN
    DELETE FROM contextual_group_members WHERE decision_id=OLD.id;
    UPDATE contextual_decision_groups SET canonical_decision_id=(SELECT MIN(decision_id) FROM contextual_group_members WHERE group_id=contextual_decision_groups.id),revision=revision+1 WHERE canonical_decision_id=OLD.id AND EXISTS(SELECT 1 FROM contextual_group_members WHERE group_id=contextual_decision_groups.id);
    DELETE FROM contextual_decision_groups WHERE NOT EXISTS(SELECT 1 FROM contextual_group_members WHERE group_id=contextual_decision_groups.id);
    DELETE FROM decision_relation_queue WHERE decision_id=OLD.id;
    DELETE FROM decision_relation_suggestions WHERE left_id=OLD.id OR right_id=OLD.id;
  END`;
});
