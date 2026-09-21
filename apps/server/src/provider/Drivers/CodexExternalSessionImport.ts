import {
  ExternalSessionImportError,
  type ExternalSessionImportFailure,
  isToolLifecycleItemType,
  type ProviderInstanceId,
} from "@lecturn/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as CodexClient from "effect-codex-app-server/client";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { IMPORT_HISTORY_MAX_MESSAGES } from "../../orchestration/threadImport.ts";
import { itemDetail, itemTitle, toCanonicalItemType } from "../Layers/CodexAdapter.ts";
import type { CodexResumeCursor } from "../Layers/CodexSessionRuntime.ts";
import type {
  ImportedExternalSession,
  ImportedTranscriptEntry,
  ProviderInstance,
} from "../ProviderDriver.ts";

const THREAD_IMPORT_TIMEOUT = "20 seconds";
const TURNS_PAGE_SIZE = 100;

// Everything below is decoded locally and loosely: the wire is newer than the
// generated bindings, and one item Codex added later must not fail an import.
const CodexImportTurn = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  startedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  completedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  items: Schema.Array(Schema.Unknown),
});
export type CodexImportTurn = typeof CodexImportTurn.Type;

const CodexImportThread = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  preview: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.String,
  createdAt: Schema.Number,
  historyMode: Schema.optionalKey(Schema.NullOr(Schema.String)),
  turns: Schema.optionalKey(Schema.Array(CodexImportTurn)),
});
const decodeThreadResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ thread: CodexImportThread }),
);
const decodeTurnsPage = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Array(CodexImportTurn),
    nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

const isUserMessageItem = Schema.is(
  Schema.Struct({
    type: Schema.Literal("userMessage"),
    content: Schema.Array(
      Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
    ),
  }),
);
const isAgentMessageItem = Schema.is(
  Schema.Struct({ type: Schema.Literal("agentMessage"), text: Schema.String }),
);
const isLifecycleItem = Schema.is(EffectCodexSchema.V2ItemCompletedNotification__ThreadItem);

type CodexImportClient = {
  readonly raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">;
};

// Codex reports unix seconds.
const toIsoDateTime = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

function userMessageText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .flatMap((part) => {
      if (part.type === "text") return part.text?.trim() ? [part.text] : [];
      return part.type === "image" || part.type === "localImage" ? ["[image]"] : [];
    })
    .join("\n");
}

/**
 * Turns a Codex thread's turns into import transcript rows, in order. Messages
 * keep their text; tool-like items become one activity each, titled and
 * detailed the way the live adapter reports a completed item, so no command
 * output, patch body or tool result is carried. Reasoning, plans and item
 * types this build does not know are skipped.
 *
 * Items carry no timestamp, so each takes its turn's start, else the latest
 * time seen before it (`fallbackSeconds` to begin with).
 */
export function codexTurnsToTranscript(
  turns: ReadonlyArray<CodexImportTurn>,
  fallbackSeconds: number,
): ReadonlyArray<ImportedTranscriptEntry> {
  const transcript: ImportedTranscriptEntry[] = [];
  let latestSeconds = fallbackSeconds;
  for (const turn of turns) {
    const createdAt = toIsoDateTime(turn.startedAt ?? latestSeconds);
    latestSeconds = turn.completedAt ?? turn.startedAt ?? latestSeconds;
    for (const item of turn.items) {
      if (isUserMessageItem(item)) {
        const text = userMessageText(item.content);
        if (text) transcript.push({ kind: "message", role: "user", text, createdAt });
      } else if (isAgentMessageItem(item)) {
        if (item.text.trim()) {
          transcript.push({ kind: "message", role: "assistant", text: item.text, createdAt });
        }
      } else if (isLifecycleItem(item)) {
        const itemType = toCanonicalItemType(item.type);
        if (!isToolLifecycleItemType(itemType)) continue;
        const detail = itemDetail(itemType, item);
        transcript.push({
          kind: "activity",
          // What ProviderRuntimeIngestion records for a live `item.completed`.
          tone: "tool",
          activityKind: "tool.completed",
          summary: itemTitle(itemType, item) ?? "Tool",
          itemType,
          ...(detail ? { detail } : {}),
          createdAt,
        });
      }
    }
  }
  return transcript;
}

/** A failed step of the import, before it is stamped with the instance. */
class CodexImportFailure extends Data.TaggedError("CodexImportFailure")<{
  readonly reason: ExternalSessionImportFailure;
  readonly cause?: unknown;
}> {}

// Observed on codex 0.154: "no rollout found for thread id <id>" and, for an
// id that is not a UUID, "invalid session id: …". An archived source and a
// source whose rollout is gone both fall through to `unreadable`.
const SESSION_NOT_FOUND = /no rollout found|invalid session id|thread not found/i;

const request = (client: CodexImportClient, method: string, payload: unknown) =>
  client.raw.request(method, payload).pipe(
    Effect.mapError(
      (cause) =>
        new CodexImportFailure({
          reason: SESSION_NOT_FOUND.test(cause.message) ? "session-not-found" : "unreadable",
          cause,
        }),
    ),
  );

const decoded = <A, E>(decode: (response: unknown) => Effect.Effect<A, E>, response: unknown) =>
  decode(response).pipe(
    Effect.mapError((cause) => new CodexImportFailure({ reason: "unreadable", cause })),
  );

const forkThread = (
  client: CodexImportClient,
  input: { readonly sessionId: string; readonly cwd: string; readonly lastTurnId?: string },
) =>
  request(client, "thread/fork", {
    threadId: input.sessionId,
    cwd: input.cwd,
    ...(input.lastTurnId !== undefined ? { lastTurnId: input.lastTurnId } : {}),
    // Turns are paged separately below.
    excludeTurns: true,
  }).pipe(Effect.flatMap((response) => decoded(decodeThreadResponse, response)));

const messageCount = (turn: CodexImportTurn) =>
  codexTurnsToTranscript([turn], 0).filter((entry) => entry.kind === "message").length;

/**
 * Reads the thread's turns through its last completed one, in chronological
 * order, and reports whether unfinished turns followed it (`cutOff`). Pages
 * arrive newest first and reading stops once they hold more messages than an
 * import keeps: one more than the cap, so the history builder still sees that
 * the session was longer. A very large session therefore costs a few pages
 * rather than its whole history.
 */
const readThreadTurns = Effect.fn("readCodexImportTurns")(function* (
  client: CodexImportClient,
  thread: typeof CodexImportThread.Type,
) {
  if (thread.historyMode !== "paginated") {
    const response = yield* request(client, "thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    const all = (yield* decoded(decodeThreadResponse, response)).thread.turns ?? [];
    const lastCompleted = all.findLastIndex((turn) => turn.status === "completed");
    return { turns: all.slice(0, lastCompleted + 1), cutOff: lastCompleted !== all.length - 1 };
  }
  // Newest first, starting at the last completed turn.
  const kept: CodexImportTurn[] = [];
  let cutOff = false;
  let messages = 0;
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = yield* request(client, "thread/turns/list", {
      threadId: thread.id,
      itemsView: "full",
      sortDirection: "desc",
      limit: TURNS_PAGE_SIZE,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const page = yield* decoded(decodeTurnsPage, response);
    for (const turn of page.data) {
      if (kept.length === 0 && turn.status !== "completed") {
        cutOff = true;
        continue;
      }
      kept.push(turn);
      messages += messageCount(turn);
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) {
        return yield* new CodexImportFailure({
          reason: "unreadable",
          cause: "Codex returned a repeated thread history cursor.",
        });
      }
      cursors.add(cursor);
    }
  } while (cursor !== undefined && messages <= IMPORT_HISTORY_MAX_MESSAGES);
  return { turns: kept.toReversed(), cutOff };
});

/**
 * Forks `sessionId` and reads the conversation back from the fork: Codex
 * serves no turns for a thread it has not loaded, and forking is what loads
 * one without touching the source. A trailing turn that never completed is
 * cut by forking again at the last completed turn; the first fork is then an
 * unused two-line rollout that never shows in `thread/list`.
 */
export const importCodexExternalThread = Effect.fn("importCodexExternalThread")(function* (
  client: CodexImportClient,
  input: { readonly sessionId: string; readonly cwd: string },
) {
  let fork = (yield* forkThread(client, input)).thread;
  const { turns, cutOff } = yield* readThreadTurns(client, fork);
  const lastCompletedTurn = turns.at(-1);
  if (lastCompletedTurn === undefined) {
    return yield* new CodexImportFailure({ reason: "empty-session" });
  }
  if (cutOff) {
    // A fork keeps its source's turn ids, so the id read from the first fork
    // names the same turn in the source.
    fork = (yield* forkThread(client, { ...input, lastTurnId: lastCompletedTurn.id })).thread;
  }

  // The fork reports the cwd it was given and no name or preview of its own.
  const source = (yield* decoded(
    decodeThreadResponse,
    yield* request(client, "thread/read", { threadId: input.sessionId, includeTurns: false }),
  )).thread;
  const transcript = codexTurnsToTranscript(turns, source.createdAt);
  if (!transcript.some((entry) => entry.kind === "message")) {
    return yield* new CodexImportFailure({ reason: "empty-session" });
  }
  const preview = source.preview?.trim() ?? "";
  return {
    resumeCursor: { threadId: fork.id } satisfies CodexResumeCursor,
    title: source.name?.trim() || (preview.split("\n", 1)[0] ?? "").trim(),
    cwd: source.cwd.trim(),
    transcript,
  } satisfies ImportedExternalSession;
});

/**
 * Builds `ProviderInstance.importExternalSession` for a Codex home.
 * `openClient` is the instance's short-lived app-server; the fork it writes
 * outlives it and is resumed later by the adapter's own app-server.
 */
export function makeCodexExternalSessionImporter<E>(options: {
  readonly instanceId: ProviderInstanceId;
  readonly openClient: Effect.Effect<CodexImportClient, E, Scope.Scope>;
}): NonNullable<ProviderInstance["importExternalSession"]> {
  return (input) =>
    options.openClient.pipe(
      Effect.flatMap((client) => importCodexExternalThread(client, input)),
      Effect.scoped,
      Effect.timeout(THREAD_IMPORT_TIMEOUT),
      Effect.mapError((cause) => {
        const failure =
          cause instanceof CodexImportFailure
            ? cause
            : new CodexImportFailure({ reason: "unreadable", cause });
        return new ExternalSessionImportError({
          providerInstanceId: options.instanceId,
          sessionId: input.sessionId,
          reason: failure.reason,
          ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
        });
      }),
    );
}
