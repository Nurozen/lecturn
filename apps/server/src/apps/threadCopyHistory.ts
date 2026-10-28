/**
 * The pure half of thread copy: copy ids, the attachments a thread's
 * history references, and the rewrite of that history into a copy. Kept apart
 * from ThreadCopyService so the id and remap rules are testable without a
 * server.
 */
import {
  type AppId,
  type ChatAttachment,
  type EnvironmentId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@lecturn/contracts";
import { htmlRenderFromToolItem, mcpAppFromToolItem } from "@lecturn/shared/toolOutput";

import {
  attachmentRelativePath,
  createDeterministicAttachmentId,
  parseAttachmentFileExtension,
} from "../attachmentStore.ts";

/**
 * The id every later import of the same source thread finds again. The
 * source tuple is the importer's to choose, so the app leads: an app id holds
 * no `:`, and two apps naming one source never derive one thread.
 */
export const copyThreadId = (
  appId: AppId,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
) => ThreadId.make(`copy:${appId}:${sourceEnvironmentId}:${sourceThreadId}`);

/** Copies taken before ids named the app. They are found by `copiedFrom`, never derived again. */
export const legacyCopyThreadId = (sourceEnvironmentId: EnvironmentId, sourceThreadId: ThreadId) =>
  ThreadId.make(`copy:${sourceEnvironmentId}:${sourceThreadId}`);

/**
 * A copy that gained Lecturn-side turns, or holds history its source has
 * since dropped, is never replaced; newer source history goes to this thread
 * instead, keyed by the revision so a rerun finds it.
 */
export const recopyThreadId = (
  appId: AppId,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  historyRevision: number,
) =>
  ThreadId.make(`${copyThreadId(appId, sourceEnvironmentId, sourceThreadId)}:r${historyRevision}`);

/**
 * `chat` is an uploaded image or file: its stored name depends on the
 * attachment's mime type and file name. `document` is a captured card or HTML
 * render, stored under its id's extension suffix.
 */
export type ThreadAssetRef =
  | { readonly kind: "chat"; readonly attachment: ChatAttachment }
  | { readonly kind: "document" };

const isStoredChatAttachment = (attachment: ChatAttachment) =>
  attachment.type === "image" || attachment.type === "file";

/** Every attachment a thread's history shows, keyed by its id in that history. */
export function collectThreadAssetRefs(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyMap<string, ThreadAssetRef> {
  const refs = new Map<string, ThreadAssetRef>();
  const addChat = (attachments: ReadonlyArray<ChatAttachment>) => {
    for (const attachment of attachments) {
      if (isStoredChatAttachment(attachment) && !refs.has(attachment.id)) {
        refs.set(attachment.id, { kind: "chat", attachment });
      }
    }
  };
  for (const message of messages) addChat(message.attachments);
  for (const item of items) {
    if (item.type === "user_message") addChat(item.attachments);
    if (!("toolName" in item) || !("output" in item)) continue;
    const toolItem = { toolName: item.toolName, output: item.output };
    for (const reference of [mcpAppFromToolItem(toolItem), htmlRenderFromToolItem(toolItem)]) {
      if (reference !== undefined && !refs.has(reference.attachmentId)) {
        refs.set(reference.attachmentId, { kind: "document" });
      }
    }
  }
  return refs;
}

/**
 * The copy's own id for a source attachment: the copy thread's segment, so
 * deleting the copy deletes its files, and the source id's extension suffix,
 * so the asset route still serves cards as sandboxed documents.
 */
export function copiedAttachmentId(threadId: ThreadId, sourceAttachmentId: string): string | null {
  const base = createDeterministicAttachmentId(threadId, `thread-copy:${sourceAttachmentId}`);
  if (base === null) return null;
  const extension = parseAttachmentFileExtension(sourceAttachmentId);
  return extension === null ? base : `${base}-${extension}`;
}

/** Where an imported asset is stored, relative to the attachments directory. */
export function copiedAssetRelativePath(attachmentId: string, ref: ThreadAssetRef): string | null {
  if (ref.kind === "chat") return attachmentRelativePath({ ...ref.attachment, id: attachmentId });
  const extension = parseAttachmentFileExtension(attachmentId);
  return `${attachmentId}.${extension ?? "bin"}`;
}

/**
 * Only whole strings equal to a source attachment id change. Ids carry a
 * uuid, so this cannot touch text, and it reaches references wherever an
 * adapter nested them in a tool's output. Class instances (dates) are kept.
 */
function remapAttachmentIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => remapAttachmentIds(entry, ids));
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, remapAttachmentIds(entry, ids)]),
    );
  }
  return value;
}

const copiedMessageId = (threadId: ThreadId, sourceId: string) =>
  MessageId.make(`${threadId}:${sourceId}`);
const copiedItemId = (threadId: ThreadId, sourceId: string) =>
  TurnItemId.make(`${threadId}:${sourceId}`);

/**
 * Whether the copy holds a row taken from its source that the source's
 * history no longer has, as after a rollback there. A replace only upserts,
 * and a copied row has no run for the rollback to hide, so that row would
 * stay among the newer history. Rows this server added carry no copied id.
 */
export function copyHoldsDroppedHistory(input: {
  readonly threadId: ThreadId;
  readonly copiedMessageIds: ReadonlyArray<string>;
  readonly copiedItemIds: ReadonlyArray<string>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
}): boolean {
  const { threadId } = input;
  const prefix = `${threadId}:`;
  const holdsDropped = (copied: ReadonlyArray<string>, kept: ReadonlySet<string>) =>
    copied.some((id) => id.startsWith(prefix) && !kept.has(id));
  return (
    holdsDropped(
      input.copiedMessageIds,
      new Set(input.messages.map((message) => copiedMessageId(threadId, message.id))),
    ) ||
    holdsDropped(
      input.copiedItemIds,
      new Set(input.items.map((item) => copiedItemId(threadId, item.id))),
    )
  );
}

/**
 * A copy is run-less history: every run, node and provider reference
 * is dropped, ids are re-derived from the copy's id so a re-copy upserts the
 * same rows, and items are renumbered in the order the source showed them.
 */
export function copyThreadHistory(input: {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly attachmentIds: ReadonlyMap<string, string>;
}): {
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
} {
  const { threadId, attachmentIds } = input;
  const messages = input.messages.map(
    (message) =>
      remapAttachmentIds(
        {
          ...message,
          id: copiedMessageId(threadId, message.id),
          threadId,
          runId: null,
          nodeId: null,
        },
        attachmentIds,
      ) as OrchestrationV2ConversationMessage,
  );
  const items = input.items.map(
    (item, index) =>
      remapAttachmentIds(
        {
          ...item,
          id: copiedItemId(threadId, item.id),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId:
            item.parentItemId === null ? null : copiedItemId(threadId, item.parentItemId),
          ordinal: index + 1,
          ...("messageId" in item && typeof item.messageId === "string"
            ? { messageId: copiedMessageId(threadId, item.messageId) }
            : {}),
        },
        attachmentIds,
      ) as OrchestrationV2TurnItem,
  );
  return { messages, items };
}
