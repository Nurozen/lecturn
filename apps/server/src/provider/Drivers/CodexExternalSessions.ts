import {
  type ExternalSessionOrigin,
  ExternalSessionsListError,
  type ProviderInstanceId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as CodexClient from "effect-codex-app-server/client";

import { LECTURN_CODEX_CLIENT_NAME } from "../Layers/CodexProvider.ts";
import { CodexResumeCursorSchema } from "../Layers/CodexSessionRuntime.ts";
import type {
  ExternalSessionListing,
  ListExternalSessionsResult,
  ProviderInstance,
} from "../ProviderDriver.ts";

// Lecturn's own threads are filtered out after the fact, so how deep the scan
// goes must not depend on the caller's `limit`: a user who mostly works in
// Lecturn has their external threads far down the list. Bounded by threads
// scanned so a home full of Lecturn threads cannot page forever.
const THREAD_LIST_PAGE_SIZE = 100;
const MAX_THREADS_SCANNED = 1000;
const THREAD_LIST_TIMEOUT = "20 seconds";

const DESKTOP_ORIGINATORS = new Set(["Codex Desktop", "codex_work_desktop"]);

/**
 * The slice of a `thread/list` row the lister reads. `originator` is on the
 * wire but newer than the generated bindings, which is why the response is
 * decoded here rather than through the typed client. `source` stays unknown so
 * a source kind Codex adds later cannot fail the whole list.
 */
const CodexListedThread = Schema.Struct({
  id: Schema.String,
  preview: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  ephemeral: Schema.optionalKey(Schema.Boolean),
  parentThreadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  source: Schema.optionalKey(Schema.Unknown),
  originator: Schema.optionalKey(Schema.NullOr(Schema.String)),
  gitInfo: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ branch: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
  ),
});
export type CodexListedThread = typeof CodexListedThread.Type;

const CodexThreadListPage = Schema.Struct({
  data: Schema.Array(CodexListedThread),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeCodexThreadListPage = Schema.decodeUnknownEffect(CodexThreadListPage);
const isCodexResumeCursor = Schema.is(CodexResumeCursorSchema);

type CodexThreadListClient = {
  readonly raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">;
};

function isSubAgentSource(source: unknown): boolean {
  return typeof source === "object" && source !== null && "subAgent" in source;
}

function originOf(thread: CodexListedThread): ExternalSessionOrigin {
  if (thread.source === "cli" || thread.source === "exec") return "cli";
  // Older Codex builds omit `originator`. Every desktop-class client reports
  // `vscode`, the IDE extension included, so without it the origin is a guess.
  if (!thread.originator) return "unknown";
  if (DESKTOP_ORIGINATORS.has(thread.originator)) return "desktop";
  return thread.source === "vscode" ? "ide" : "unknown";
}

// Codex reports unix seconds.
const toIsoDateTime = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

function toListing(thread: CodexListedThread): ExternalSessionListing {
  const preview = thread.preview.trim();
  const title = thread.name?.trim() || (preview.split("\n", 1)[0] ?? "").trim();
  const gitBranch = thread.gitInfo?.branch?.trim();
  return {
    sessionId: thread.id,
    title,
    ...(preview && preview !== title ? { firstPrompt: preview } : {}),
    cwd: thread.cwd.trim(),
    ...(gitBranch ? { gitBranch } : {}),
    createdAt: toIsoDateTime(thread.createdAt),
    updatedAt: toIsoDateTime(thread.updatedAt),
    origin: originOf(thread),
  };
}

/**
 * Keeps the threads a user could import: not already resumed by Lecturn, not
 * started by Lecturn, not ephemeral, not a subagent. Desktop apps and Lecturn
 * both report `source: "vscode"`, so only `originator` tells them apart.
 */
export function selectCodexExternalSessions(
  threads: ReadonlyArray<CodexListedThread>,
  knownThreadIds: ReadonlySet<string>,
): ReadonlyArray<ExternalSessionListing> {
  return threads
    .filter(
      (thread) =>
        !knownThreadIds.has(thread.id) &&
        thread.originator !== LECTURN_CODEX_CLIENT_NAME &&
        thread.ephemeral !== true &&
        !thread.parentThreadId &&
        !isSubAgentSource(thread.source) &&
        thread.cwd.trim().length > 0,
    )
    .map(toListing);
}

/**
 * Pages `thread/list`, newest first, until `limit + 1` importable threads are
 * in hand or Codex runs out. `truncated` also covers stopping at the scan cap
 * while Codex still had more.
 */
export const listCodexExternalThreads = Effect.fn("listCodexExternalThreads")(function* (
  client: CodexThreadListClient,
  input: {
    readonly cwd?: string | undefined;
    readonly searchTerm?: string | undefined;
    readonly limit: number;
    readonly knownThreadIds: ReadonlySet<string>;
  },
) {
  const sessions: ExternalSessionListing[] = [];
  let cursor: string | undefined;
  let scanned = 0;
  while (scanned < MAX_THREADS_SCANNED) {
    const response = yield* client.raw
      .request("thread/list", {
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.searchTerm !== undefined ? { searchTerm: input.searchTerm } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        limit: THREAD_LIST_PAGE_SIZE,
        sortKey: "updated_at",
        sortDirection: "desc",
      })
      .pipe(Effect.flatMap(decodeCodexThreadListPage));
    sessions.push(...selectCodexExternalSessions(response.data, input.knownThreadIds));
    scanned += response.data.length;
    cursor = response.nextCursor ?? undefined;
    // An empty page with a cursor would never reach the scan cap.
    if (cursor === undefined || sessions.length > input.limit || response.data.length === 0) break;
  }
  return {
    sessions: sessions.slice(0, input.limit),
    truncated: sessions.length > input.limit || cursor !== undefined,
  } satisfies ListExternalSessionsResult;
});

/**
 * Builds `ProviderInstance.listExternalSessions` for a Codex home: threads the
 * Codex CLI or desktop apps recorded there, minus Lecturn's own. `openClient`
 * is the instance's short-lived app-server; it is torn down after every call.
 */
export function makeCodexExternalSessionsLister<E>(options: {
  readonly instanceId: ProviderInstanceId;
  readonly openClient: Effect.Effect<CodexThreadListClient, E, Scope.Scope>;
}): NonNullable<ProviderInstance["listExternalSessions"]> {
  return (input) =>
    options.openClient.pipe(
      Effect.flatMap((client) =>
        listCodexExternalThreads(client, {
          cwd: input.cwd,
          searchTerm: input.searchTerm,
          limit: input.limit,
          knownThreadIds: new Set(
            input.knownResumeCursors.filter(isCodexResumeCursor).map((cursor) => cursor.threadId),
          ),
        }),
      ),
      Effect.scoped,
      Effect.timeout(THREAD_LIST_TIMEOUT),
      Effect.mapError(
        (cause) =>
          new ExternalSessionsListError({
            providerInstanceId: options.instanceId,
            reason: "unreadable",
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            cause,
          }),
      ),
    );
}
