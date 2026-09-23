import * as Schema from "effect/Schema";
import {
  ForwardCompatibleNullable,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  ThreadNoteId,
} from "./baseSchemas.ts";
import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  ASSISTANT_CITATION_CONTEXT_LENGTH,
} from "./assistantCitations.ts";

const anchorFields = {
  threadId: ThreadId,
  messageId: MessageId,
  messageRole: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(ASSISTANT_CITATION_MAX_TEXT_LENGTH),
  ),
  comment: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_MAX_COMMENT_LENGTH)),
  ),
  start: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  end: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  prefix: Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
  suffix: Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
};
const validAnchor = Schema.makeFilter(
  (note: { start: number; end: number; text: string }) =>
    note.end > note.start && note.text.trim().length > 0,
);
const noteFields = {
  id: ThreadNoteId,
  projectId: ProjectId,
  ...anchorFields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};
export const ThreadNote = Schema.Struct(noteFields).check(validAnchor);
export type ThreadNote = typeof ThreadNote.Type;
export const ThreadNoteAnchorState = Schema.Literals([
  "ok",
  "message-missing",
  "thread-deleted",
  "thread-archived",
]);
export const ThreadNoteListItem = Schema.Struct({
  ...noteFields,
  threadTitle: Schema.NullOr(Schema.String),
  anchorState: ForwardCompatibleNullable(ThreadNoteAnchorState),
}).check(validAnchor);
export type ThreadNoteListItem = typeof ThreadNoteListItem.Type;
export const ThreadNoteListInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type ThreadNoteListInput = typeof ThreadNoteListInput.Type;
export const ThreadNoteListResult = Schema.Struct({
  notes: Schema.Array(ThreadNoteListItem),
  truncated: Schema.Boolean,
});
export type ThreadNoteListResult = typeof ThreadNoteListResult.Type;
export const ThreadNoteCreateInput = Schema.Struct({ id: ThreadNoteId, ...anchorFields }).check(
  validAnchor,
);
export type ThreadNoteCreateInput = typeof ThreadNoteCreateInput.Type;
export const ThreadNoteUpdateInput = Schema.Struct({
  id: ThreadNoteId,
  comment: anchorFields.comment,
});
export type ThreadNoteUpdateInput = typeof ThreadNoteUpdateInput.Type;
export const ThreadNoteDeleteInput = Schema.Struct({ id: ThreadNoteId });
export type ThreadNoteDeleteInput = typeof ThreadNoteDeleteInput.Type;
export class ThreadNoteError extends Schema.TaggedErrorClass<ThreadNoteError>()("ThreadNoteError", {
  code: Schema.Literals(["not-found", "invalid", "conflict", "unavailable", "forbidden"]),
  message: Schema.String,
}) {}
