/**
 * Lists and imports provider sessions created outside Lecturn for one
 * provider instance.
 *
 * The per-provider work lives on `ProviderInstance.listExternalSessions` and
 * `ProviderInstance.importExternalSession`; this module resolves the instance,
 * hands the lister every provider-native session id Lecturn owns so it can
 * hide them, and shapes the result for the wire.
 *
 * @module provider/externalSessions
 */
import {
  ExternalSessionImportError,
  ExternalSessionsListError,
  type ExternalSessionsListInput,
  type ExternalSessionsListResult,
  type ProviderInstanceId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";

const EXTERNAL_SESSION_TEXT_MAX_LENGTH = 200;

function capText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > EXTERNAL_SESSION_TEXT_MAX_LENGTH
    ? `${trimmed.slice(0, EXTERNAL_SESSION_TEXT_MAX_LENGTH - 1).trimEnd()}…`
    : trimmed;
}

/**
 * Native ids a legacy (pre-orchestration-v2) resume cursor names: Claude
 * cursors carry `resume`/`sessionId`, Codex cursors `threadId`. Extra ids are
 * harmless; the set only hides sessions.
 */
export function nativeSessionIdsFromLegacyCursor(cursor: unknown): ReadonlyArray<string> {
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return [];
  const record = cursor as Record<string, unknown>;
  return ["resume", "sessionId", "threadId"].flatMap((key) => {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [];
  });
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Every provider-native session id Lecturn owns: the native thread refs of
 * orchestration provider threads (an imported thread binds its fork there),
 * plus the cursors of legacy provider sessions and not-yet-sent legacy imports
 * that came over in the copied database. Legacy tables may be absent.
 */
const readKnownNativeSessionIds = Effect.fn("readKnownNativeSessionIds")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const nativeRows = yield* sql<{ readonly nativeId: string | null }>`
    SELECT DISTINCT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS "nativeId"
    FROM orchestration_v2_projection_provider_threads
  `;
  const legacyCursors = yield* sql<{ readonly cursor: string | null }>`
    SELECT resume_cursor_json AS "cursor"
    FROM provider_session_runtime
    WHERE resume_cursor_json IS NOT NULL
  `.pipe(Effect.orElseSucceed(() => []));
  const legacyImports = yield* sql<{ readonly cursor: string | null }>`
    SELECT json_extract(import_source_json, '$.resumeCursor') AS "cursor"
    FROM projection_threads
    WHERE import_source_json IS NOT NULL
  `.pipe(Effect.orElseSucceed(() => []));
  const ids = new Set<string>();
  for (const row of nativeRows) {
    if (typeof row.nativeId === "string" && row.nativeId.length > 0) ids.add(row.nativeId);
  }
  for (const row of [...legacyCursors, ...legacyImports]) {
    for (const id of nativeSessionIdsFromLegacyCursor(parseJson(row.cursor))) ids.add(id);
  }
  return ids as ReadonlySet<string>;
});

export const listExternalSessions = Effect.fn("listExternalSessions")(function* (
  input: ExternalSessionsListInput,
) {
  const instances = yield* ProviderInstanceRegistry;
  const fail = (reason: ExternalSessionsListError["reason"], cause?: unknown) =>
    new ExternalSessionsListError({
      providerInstanceId: input.providerInstanceId,
      reason,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });

  const instance = yield* instances.getInstance(input.providerInstanceId);
  if (instance === undefined || !instance.enabled) {
    return yield* fail("provider-unavailable");
  }
  if (instance.listExternalSessions === undefined) {
    return yield* fail("provider-unsupported");
  }

  // Not narrowed to this instance: the session store belongs to the provider
  // home, and instances sharing a home would otherwise list each other's.
  const knownNativeSessionIds = yield* readKnownNativeSessionIds().pipe(
    Effect.mapError((cause) => fail("unreadable", cause)),
  );

  const listed = yield* instance.listExternalSessions({
    cwd: input.cwd,
    searchTerm: input.searchTerm || undefined,
    limit: input.limit,
    knownNativeSessionIds,
  });

  return {
    sessions: listed.sessions.slice(0, input.limit).map((session) => ({
      ...session,
      providerInstanceId: instance.instanceId,
      driverKind: instance.driverKind,
      title: capText(session.title),
      ...(session.firstPrompt !== undefined ? { firstPrompt: capText(session.firstPrompt) } : {}),
    })),
    truncated: listed.truncated || listed.sessions.length > input.limit,
  } satisfies ExternalSessionsListResult;
});

/**
 * Forks one external session natively and reads its history. The caller owns
 * every validation that must precede the fork: a session forked here stays on
 * disk even if the import is later rejected.
 *
 * Titles are capped here, once, like listed ones: `title` is the session's own
 * and `threadTitle` the imported thread's (the caller's choice when given).
 * Both ride on every thread shell.
 */
export const importExternalSession = Effect.fn("importExternalSession")(function* (input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionId: string;
  readonly cwd: string;
  readonly title?: string | undefined;
}) {
  const instances = yield* ProviderInstanceRegistry;
  const fail = (reason: ExternalSessionImportError["reason"]) =>
    new ExternalSessionImportError({
      providerInstanceId: input.providerInstanceId,
      sessionId: input.sessionId,
      reason,
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
  const title = capText(imported.title);
  return {
    ...imported,
    title,
    threadTitle: capText(input.title ?? "") || title || "Imported session",
    driverKind: instance.driverKind,
  };
});
