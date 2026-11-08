/**
 * V1 events share the global sequence space, so a V1 ingestion cursor stays comparable and every V2
 * event lies above it. Legacy-import (`migration:*`) events only advance the cursor: V1 already
 * indexed them, and replaying would re-enqueue every migrated thread's whole history.
 */
import type { ApplicationStoredEvent, MessageId, ProjectId, ThreadId } from "@lecturn/contracts";

export type DecisionSourceEvent =
  | { readonly sequence: number; readonly kind: "ignored" }
  | { readonly sequence: number; readonly kind: "project-deleted"; readonly projectId: ProjectId }
  | {
      readonly sequence: number;
      readonly kind: "thread-generation";
      readonly threadId: ThreadId;
      /** `created` keeps the first generation; every other source change starts a new one. */
      readonly reason: "created" | "forked" | "imported" | "reverted";
    }
  | {
      readonly sequence: number;
      readonly kind: "thread-deleted" | "thread-archived" | "thread-unarchived";
      readonly threadId: ThreadId;
    }
  | {
      readonly sequence: number;
      readonly kind: "message-final";
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
    };

const LEGACY_IMPORT_EVENT_PREFIX = "migration:";

export function decisionSourceEvent(stored: ApplicationStoredEvent): DecisionSourceEvent {
  if ("aggregateKind" in stored) {
    return stored.type === "project.deleted"
      ? { sequence: stored.sequence, kind: "project-deleted", projectId: stored.payload.projectId }
      : { sequence: stored.sequence, kind: "ignored" };
  }
  const { sequence, event } = stored;
  if (event.id.startsWith(LEGACY_IMPORT_EVENT_PREFIX)) return { sequence, kind: "ignored" };
  switch (event.type) {
    case "thread.created":
      return {
        sequence,
        kind: "thread-generation",
        threadId: event.threadId,
        reason: event.payload.lineage.relationshipToParent === "fork" ? "forked" : "created",
      };
    case "thread.imported":
      return { sequence, kind: "thread-generation", threadId: event.threadId, reason: "imported" };
    case "run.updated":
      return event.payload.status === "rolled_back"
        ? { sequence, kind: "thread-generation", threadId: event.threadId, reason: "reverted" }
        : { sequence, kind: "ignored" };
    case "thread.deleted":
      return { sequence, kind: "thread-deleted", threadId: event.threadId };
    case "thread.archived":
      return { sequence, kind: "thread-archived", threadId: event.threadId };
    case "thread.unarchived":
      return { sequence, kind: "thread-unarchived", threadId: event.threadId };
    case "message.updated":
      return !event.payload.streaming &&
        (event.payload.role === "user" || event.payload.role === "assistant")
        ? { sequence, kind: "message-final", threadId: event.threadId, messageId: event.payload.id }
        : { sequence, kind: "ignored" };
    default:
      return { sequence, kind: "ignored" };
  }
}
