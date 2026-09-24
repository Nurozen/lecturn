import {
  DecisionSourceMessage,
  type DecisionEvidence,
  type ProjectId,
  type ThreadDecisionSourceWindowResult,
  ThreadDecisionError,
} from "@lecturn/contracts";
import { canonicalDecisionText, resolveDecisionSource } from "@lecturn/shared/decisionEvidence";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { requireDecisionProject } from "./DecisionRevisions.ts";

interface MessageRow {
  message_id: string;
  role: string;
  text: string;
  created_at: string;
}

export const decisionSourceWindow = Effect.fn("Decisions.sourceWindow")(function* (
  projectId: ProjectId,
  evidence: DecisionEvidence,
): Effect.fn.Return<ThreadDecisionSourceWindowResult, ThreadDecisionError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.gen(function* () {
    yield* requireDecisionProject(sql, projectId);
    const base = {
      threadId: evidence.threadId,
      messageId: evidence.messageId,
      messages: [],
      start: null,
      end: null,
    };
    const threads = yield* sql<{
      project_id: string;
      deleted_at: string | null;
      archived_at: string | null;
    }>`SELECT project_id, deleted_at, archived_at FROM projection_threads WHERE thread_id = ${evidence.threadId}`;
    const thread = threads[0];
    if (thread && thread.project_id !== projectId)
      return yield* new ThreadDecisionError({
        code: "forbidden",
        message: "This source does not belong to this project.",
      });
    if (!thread || thread.deleted_at)
      return { ...base, outcome: "unavailable" as const, reason: "thread-deleted" as const };
    const targets =
      yield* sql<MessageRow>`SELECT message_id, role, text, created_at FROM projection_thread_messages WHERE thread_id = ${evidence.threadId} AND message_id = ${evidence.messageId}`;
    const target = targets[0];
    if (!target)
      return { ...base, outcome: "unavailable" as const, reason: "message-missing" as const };
    const generations = yield* sql<{
      source_generation: number;
    }>`SELECT source_generation FROM decision_thread_state WHERE thread_id = ${evidence.threadId} AND project_id = ${projectId}`;
    const outcome =
      generations[0]?.source_generation === evidence.sourceGeneration
        ? resolveDecisionSource(target.text, evidence)
        : ("message-only" as const);
    // A huge source still has a message-level destination. Never mislabel a clipped
    // substring as the entire message or silently change its canonical coordinates.
    if (target.text.length > 64000)
      return { ...base, outcome: "message-only" as const, reason: null };
    const before =
      yield* sql<MessageRow>`SELECT message_id, role, text, created_at FROM projection_thread_messages
      WHERE thread_id = ${evidence.threadId} AND role IN ('user', 'assistant') AND is_streaming = 0
      AND (created_at < ${target.created_at} OR (created_at = ${target.created_at} AND message_id < ${target.message_id}))
      ORDER BY created_at DESC, message_id DESC LIMIT 10`;
    const after =
      yield* sql<MessageRow>`SELECT message_id, role, text, created_at FROM projection_thread_messages
      WHERE thread_id = ${evidence.threadId} AND role IN ('user', 'assistant') AND is_streaming = 0
      AND (created_at > ${target.created_at} OR (created_at = ${target.created_at} AND message_id > ${target.message_id}))
      ORDER BY created_at, message_id LIMIT 10`;
    let remaining = 96000 - target.text.length;
    const neighbors = [...before, ...after].filter((message) => {
      if (message.text.length > Math.min(64000, remaining)) return false;
      remaining -= message.text.length;
      return true;
    });
    const messages = yield* Effect.forEach(
      [...neighbors, target].sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id),
      ),
      (message) =>
        Schema.decodeUnknownEffect(DecisionSourceMessage)({
          id: message.message_id,
          role: message.role,
          text: message.text,
          createdAt: message.created_at,
        }),
    );
    const offsets = canonicalDecisionText(target.text).sourceOffsets;
    return {
      ...base,
      outcome,
      messages,
      start: outcome === "exact" ? (offsets[evidence.start] ?? null) : null,
      end: outcome === "exact" ? (offsets[evidence.end] ?? null) : null,
      reason:
        outcome === "message-only"
          ? ("changed" as const)
          : thread.archived_at
            ? ("thread-archived" as const)
            : null,
    };
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(ThreadDecisionError)(error)
        ? error
        : new ThreadDecisionError({
            code: "unavailable",
            message: "The decision source could not be loaded.",
          }),
    ),
  );
});
