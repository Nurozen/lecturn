/**
 * Lists and imports provider sessions created outside Lecturn for one
 * provider instance.
 *
 * The per-provider work lives on `ProviderInstance.listExternalSessions` and
 * `ProviderInstance.importExternalSession`; this module resolves the instance,
 * hands the lister every resume cursor Lecturn owns so it can hide them, and
 * shapes the result for the wire.
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

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "./Services/ProviderSessionDirectory.ts";

const EXTERNAL_SESSION_TEXT_MAX_LENGTH = 200;

function capText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > EXTERNAL_SESSION_TEXT_MAX_LENGTH
    ? `${trimmed.slice(0, EXTERNAL_SESSION_TEXT_MAX_LENGTH - 1).trimEnd()}…`
    : trimmed;
}

export const listExternalSessions = Effect.fn("listExternalSessions")(function* (
  input: ExternalSessionsListInput,
) {
  const instances = yield* ProviderInstanceRegistry;
  const directory = yield* ProviderSessionDirectory;
  const projections = yield* ProjectionSnapshotQuery;
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

  const bindings = yield* directory
    .listBindings()
    .pipe(Effect.mapError((cause) => fail("unreadable", cause)));
  // An imported thread has no binding until its first send, so its fork would
  // otherwise be listed and could be imported again.
  const importSources = yield* projections
    .listThreadImportSources()
    .pipe(Effect.mapError((cause) => fail("unreadable", cause)));
  // Not narrowed to this instance: the session store belongs to the provider
  // home, and instances sharing a home would otherwise list each other's.
  const knownResumeCursors = [...bindings, ...importSources]
    .map((owned) => owned.resumeCursor)
    .filter((resumeCursor) => resumeCursor !== undefined && resumeCursor !== null);

  const listed = yield* instance.listExternalSessions({
    cwd: input.cwd,
    searchTerm: input.searchTerm || undefined,
    limit: input.limit,
    knownResumeCursors,
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
