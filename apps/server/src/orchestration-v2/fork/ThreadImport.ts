/**
 * Lecturn: import a provider session created outside Lecturn (thread.import).
 *
 * The external session is never resumed or modified. The provider natively
 * forks it (a local operation), the new thread binds that fork as its
 * provider thread, and the session's transcript is copied in as history that
 * belongs to no run. Event order: thread.created -> provider-thread.updated ->
 * message.updated/turn-item.updated (runId null) -> thread.imported.
 *
 * Imported history is not a turn: no run, no checkpoint, nothing to revert or
 * queue. The first message the user sends starts run 1 on the forked native
 * thread.
 */
import {
  ExternalSessionImportError,
  MessageId,
  type IsoDateTime,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderThreadId,
  type ThreadImportOrigin,
  TurnItemId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ImportedTranscriptEntry } from "@lecturn/provider-core/server/driver";
import { ProviderInstanceRegistry } from "../../provider/ProviderInstanceRegistry.ts";

/** An import shows the tail of the session: only its last messages are copied. */
export const IMPORT_HISTORY_MAX_MESSAGES = 200;
/** Activities are summary rows, but a long agentic session holds thousands. */
export const IMPORT_HISTORY_MAX_ACTIVITIES = 1_000;
export const IMPORT_MESSAGE_TEXT_MAX_LENGTH = 20_000;
export const IMPORT_MESSAGE_TRUNCATION_SUFFIX = "\n\n[… truncated on import]";
const IMPORT_ACTIVITY_DETAIL_MAX_LENGTH = 500;
const EXTERNAL_SESSION_TEXT_MAX_LENGTH = 200;

export type ThreadImportCommand = Extract<
  OrchestrationV2Command,
  { readonly type: "thread.import" }
>;

export interface ImportedExternalSessionV2 {
  /** Native id of the FORK cut from the external session (Claude session id, Codex thread id). */
  readonly nativeThreadId: string;
  readonly driverKind: ProviderDriverKind;
  /** The external session's own title, capped. */
  readonly title: string;
  /** The imported thread's title: the caller's choice, else the session's, else a default. */
  readonly threadTitle: string;
  /** The external session's own cwd, which may differ from the import cwd. */
  readonly cwd: string;
  /** Chronological. */
  readonly transcript: ReadonlyArray<ImportedTranscriptEntry>;
}

export interface ExternalSessionImporterV2Shape {
  /**
   * Natively forks one external session and reads its history. A session
   * forked here stays on disk even if the import is later rejected, so every
   * validation must run before it.
   */
  readonly importSession: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly sessionId: string;
    readonly cwd: string;
    readonly title?: string | undefined;
  }) => Effect.Effect<ImportedExternalSessionV2, ExternalSessionImportError>;
}

export class ExternalSessionImporterV2 extends Context.Service<
  ExternalSessionImporterV2,
  ExternalSessionImporterV2Shape
>()("lecturn/orchestration-v2/fork/ThreadImport/ExternalSessionImporterV2") {}

function capText(value: string, maxLength: number, suffix: string): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - suffix.length)}${suffix}` : value;
}

function capListingText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > EXTERNAL_SESSION_TEXT_MAX_LENGTH
    ? `${trimmed.slice(0, EXTERNAL_SESSION_TEXT_MAX_LENGTH - 1).trimEnd()}…`
    : trimmed;
}

/** Consumes the driver-side API (`ProviderInstance.importExternalSession`). */
export const layerFromProviderInstanceRegistry: Layer.Layer<
  ExternalSessionImporterV2,
  never,
  ProviderInstanceRegistry
> = Layer.effect(
  ExternalSessionImporterV2,
  Effect.gen(function* () {
    const instances = yield* ProviderInstanceRegistry;
    return ExternalSessionImporterV2.of({
      importSession: Effect.fn("ExternalSessionImporterV2.importSession")(function* (input) {
        const fail = (reason: ExternalSessionImportError["reason"], cause?: unknown) =>
          new ExternalSessionImportError({
            providerInstanceId: input.providerInstanceId,
            sessionId: input.sessionId,
            reason,
            ...(cause === undefined ? {} : { cause }),
          });
        const instance = yield* instances.getInstance(input.providerInstanceId);
        if (instance === undefined || !instance.enabled) {
          return yield* fail("provider-unavailable");
        }
        if (instance.importExternalSession === undefined) {
          return yield* fail("provider-unsupported");
        }
        const imported = yield* instance.importExternalSession({
          sessionId: input.sessionId,
          cwd: input.cwd,
        });
        const nativeThreadId = imported.nativeThreadId.trim();
        if (nativeThreadId === "") {
          return yield* fail("unreadable", "The provider fork reported no native session id.");
        }
        const title = capListingText(imported.title);
        return {
          nativeThreadId,
          driverKind: instance.driverKind,
          title,
          threadTitle: capListingText(input.title ?? "") || title || "Imported session",
          cwd: imported.cwd,
          transcript: imported.transcript,
        } satisfies ImportedExternalSessionV2;
      }),
    });
  }),
);

export interface ImportedThreadHistoryV2 {
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  /** Messages or activities were dropped, or a message's text was capped. */
  readonly historyTruncated: boolean;
}

/**
 * Pure history builder: a provider-neutral transcript becomes run-less V2
 * messages and turn items. Ids are derived from the thread id and position,
 * so a replayed plan is identical.
 *
 * Timestamps are made strictly increasing and no later than `importedAt`:
 * `isImportedHistoryMessage` treats every run-less message at or before
 * `importedFrom.importedAt` as imported history.
 */
export function buildImportedThreadHistoryV2(input: {
  readonly threadId: OrchestrationV2AppThread["id"];
  readonly transcript: ReadonlyArray<ImportedTranscriptEntry>;
  readonly importedAt: DateTime.Utc;
}): ImportedThreadHistoryV2 {
  const { transcript } = input;
  const messageIndexes = transcript.flatMap((entry, index) =>
    entry.kind === "message" ? [index] : [],
  );
  const droppedMessageCount = Math.max(0, messageIndexes.length - IMPORT_HISTORY_MAX_MESSAGES);
  // The window opens at the first kept message, so activities that belong to
  // dropped messages go with them.
  const windowStart = droppedMessageCount === 0 ? 0 : (messageIndexes[droppedMessageCount] ?? 0);
  const windowed = transcript.slice(windowStart);
  const activityCount = windowed.length - (messageIndexes.length - droppedMessageCount);
  let activitiesToDrop = Math.max(0, activityCount - IMPORT_HISTORY_MAX_ACTIVITIES);
  const droppedActivities = activitiesToDrop > 0;
  const kept = windowed.filter((entry) => {
    if (entry.kind === "activity" && activitiesToDrop > 0) {
      activitiesToDrop -= 1;
      return false;
    }
    return true;
  });

  // Walked newest to oldest so each row only ever moves earlier.
  const timestamps: Array<DateTime.Utc> = Array.from({ length: kept.length });
  let ceilingMs = DateTime.toEpochMillis(input.importedAt);
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const parsedMs = Date.parse(kept[index]!.createdAt);
    const clampedMs = Number.isNaN(parsedMs) ? ceilingMs : Math.min(parsedMs, ceilingMs);
    timestamps[index] = DateTime.makeUnsafe(clampedMs);
    ceilingMs = clampedMs - 1;
  }

  let cappedText = false;
  const messages: Array<OrchestrationV2ConversationMessage> = [];
  const turnItems: Array<OrchestrationV2TurnItem> = [];
  kept.forEach((entry, index) => {
    const at = timestamps[index]!;
    const suffix = String(index).padStart(6, "0");
    const common = {
      id: TurnItemId.make(`import:${input.threadId}:item:${suffix}`),
      threadId: input.threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed" as const,
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
    };
    if (entry.kind === "message") {
      const text = capText(
        entry.text,
        IMPORT_MESSAGE_TEXT_MAX_LENGTH,
        IMPORT_MESSAGE_TRUNCATION_SUFFIX,
      );
      cappedText ||= text !== entry.text;
      const messageId = MessageId.make(`import:${input.threadId}:message:${suffix}`);
      messages.push({
        createdBy: entry.role === "user" ? "user" : "agent",
        creationSource: "server",
        id: messageId,
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        role: entry.role,
        text,
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      });
      turnItems.push(
        entry.role === "user"
          ? {
              ...common,
              createdBy: "user",
              creationSource: "server",
              type: "user_message",
              messageId,
              inputIntent: "turn_start",
              text,
              attachments: [],
            }
          : {
              ...common,
              type: "assistant_message",
              messageId,
              text,
              streaming: false,
            },
      );
      return;
    }
    const summary = entry.summary.trim();
    if (summary.length === 0 || entry.activityKind.trim().length === 0) return;
    const detail = entry.detail?.trim();
    const cappedDetail =
      detail === undefined || detail === ""
        ? undefined
        : capText(detail, IMPORT_ACTIVITY_DETAIL_MAX_LENGTH, "…");
    const status = entry.tone === "error" ? ("failed" as const) : ("completed" as const);
    if (entry.itemType === "command_execution") {
      turnItems.push({
        ...common,
        status,
        title: summary,
        type: "command_execution",
        input: cappedDetail ?? summary,
      });
    } else if (entry.itemType === "file_change" && cappedDetail !== undefined) {
      turnItems.push({
        ...common,
        status,
        title: summary,
        type: "file_change",
        fileName: cappedDetail,
      });
    } else if (entry.itemType === "web_search") {
      turnItems.push({
        ...common,
        status,
        title: summary,
        type: "web_search",
        ...(cappedDetail === undefined ? {} : { patterns: [cappedDetail] }),
      });
    } else {
      turnItems.push({
        ...common,
        status,
        title: summary,
        type: "dynamic_tool",
        toolName: null,
        input: cappedDetail === undefined ? { summary } : { summary, detail: cappedDetail },
      });
    }
  });

  return {
    messages,
    turnItems,
    historyTruncated: droppedMessageCount > 0 || droppedActivities || cappedText,
  };
}

export interface ThreadImportPlan {
  /** thread.created payload (no importedFrom yet). */
  readonly createdThread: OrchestrationV2AppThread;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly history: ImportedThreadHistoryV2;
  /** thread.imported payload. */
  readonly importedThread: OrchestrationV2AppThread;
  readonly importedFrom: ThreadImportOrigin;
}

/** Pure plan of one thread.import after validation and the native fork. */
export function planThreadImport(input: {
  readonly command: ThreadImportCommand;
  readonly imported: ImportedExternalSessionV2;
  readonly providerThreadId: ProviderThreadId;
  readonly now: DateTime.Utc;
}): ThreadImportPlan {
  const { command, imported, now } = input;
  const nowIso = DateTime.formatIso(now) as IsoDateTime;
  const history = buildImportedThreadHistoryV2({
    threadId: command.threadId,
    transcript: imported.transcript,
    importedAt: now,
  });
  const importedFrom: ThreadImportOrigin = {
    providerInstanceId: command.providerInstanceId,
    driverKind: imported.driverKind,
    sessionId: command.sessionId,
    cwd: imported.cwd,
    title: imported.title,
    importedAt: nowIso,
    historyTruncated: history.historyTruncated,
  };
  const createdThread: OrchestrationV2AppThread = {
    createdBy: command.createdBy,
    creationSource: command.creationSource,
    id: command.threadId,
    projectId: command.projectId,
    title: command.title ?? imported.threadTitle,
    providerInstanceId: command.modelSelection.instanceId,
    modelSelection: command.modelSelection,
    runtimeMode: command.runtimeMode,
    interactionMode: command.interactionMode,
    branch: command.branch,
    worktreePath: command.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: command.threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const providerThread: OrchestrationV2ProviderThread = {
    id: input.providerThreadId,
    driver: imported.driverKind,
    providerInstanceId: command.modelSelection.instanceId,
    providerSessionId: null,
    appThreadId: command.threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: imported.driverKind,
      nativeId: imported.nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    contextUsage: null,
    nativeMetadata: null,
    createdAt: now,
    updatedAt: now,
  };
  return {
    createdThread,
    providerThread,
    history,
    importedThread: { ...createdThread, importedFrom },
    importedFrom,
  };
}
