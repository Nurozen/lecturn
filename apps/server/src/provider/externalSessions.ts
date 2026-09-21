/**
 * Lists provider sessions created outside Lecturn for one provider instance.
 *
 * The per-provider work lives on `ProviderInstance.listExternalSessions`; this
 * module resolves the instance, hands the lister every resume cursor Lecturn
 * owns so it can hide them, and shapes the result for the wire.
 *
 * @module provider/externalSessions
 */
import {
  ExternalSessionsListError,
  type ExternalSessionsListInput,
  type ExternalSessionsListResult,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";

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
  // Not narrowed to this instance: the session store belongs to the provider
  // home, and instances sharing a home would otherwise list each other's.
  const knownResumeCursors = bindings
    .filter((binding) => binding.resumeCursor !== undefined && binding.resumeCursor !== null)
    .map((binding) => binding.resumeCursor);

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
