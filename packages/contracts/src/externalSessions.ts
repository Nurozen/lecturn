import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const EXTERNAL_SESSIONS_LIST_MAX_LIMIT = 100;
const EXTERNAL_SESSIONS_CWD_MAX_LENGTH = 512;
const EXTERNAL_SESSIONS_SEARCH_TERM_MAX_LENGTH = 256;

export const ExternalSessionOrigin = Schema.Literals(["cli", "desktop", "ide", "unknown"]);
export type ExternalSessionOrigin = typeof ExternalSessionOrigin.Type;

/**
 * One provider session that was created outside Lecturn (a provider CLI or
 * desktop app) and can be offered for import. `title` and `firstPrompt` are
 * trimmed and capped by the server before they cross the wire.
 */
export const ExternalSessionSummary = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  // Provider-native id: a Claude session uuid or a Codex thread id.
  sessionId: TrimmedNonEmptyString,
  title: TrimmedString,
  firstPrompt: Schema.optional(TrimmedString),
  cwd: TrimmedNonEmptyString,
  gitBranch: Schema.optional(TrimmedNonEmptyString),
  createdAt: Schema.optional(IsoDateTime),
  updatedAt: IsoDateTime,
  sizeBytes: Schema.optional(NonNegativeInt),
  origin: Schema.optional(ExternalSessionOrigin),
});
export type ExternalSessionSummary = typeof ExternalSessionSummary.Type;

export const ExternalSessionsListInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  // Absent cwd lists sessions from every directory the provider knows about.
  cwd: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(EXTERNAL_SESSIONS_CWD_MAX_LENGTH)),
  ),
  searchTerm: Schema.optional(
    TrimmedString.check(Schema.isMaxLength(EXTERNAL_SESSIONS_SEARCH_TERM_MAX_LENGTH)),
  ),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(EXTERNAL_SESSIONS_LIST_MAX_LIMIT)),
});
export type ExternalSessionsListInput = typeof ExternalSessionsListInput.Type;

export const ExternalSessionsListResult = Schema.Struct({
  sessions: Schema.Array(ExternalSessionSummary),
  truncated: Schema.Boolean,
});
export type ExternalSessionsListResult = typeof ExternalSessionsListResult.Type;

export const ExternalSessionsListFailure = Schema.Literals([
  // The provider has no notion of sessions created outside Lecturn.
  "provider-unsupported",
  // The instance is unknown to this server, or disabled.
  "provider-unavailable",
  // The provider's session store exists but could not be read.
  "unreadable",
]);
export type ExternalSessionsListFailure = typeof ExternalSessionsListFailure.Type;

export class ExternalSessionsListError extends Schema.TaggedErrorClass<ExternalSessionsListError>()(
  "ExternalSessionsListError",
  {
    providerInstanceId: ProviderInstanceId,
    reason: ExternalSessionsListFailure,
    cwd: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const cwd = this.cwd === undefined ? "" : ` in '${this.cwd}'`;
    return `Failed to list external sessions for provider '${this.providerInstanceId}'${cwd} (${this.reason}).`;
  }
}

export const ExternalSessionImportFailure = Schema.Literals([
  // Thread forking is switched off on this server; imports run on a fork.
  "forking-disabled",
  // The provider cannot import sessions created outside Lecturn.
  "provider-unsupported",
  // The instance is unknown to this server, or disabled.
  "provider-unavailable",
  // The provider's session store no longer holds the session.
  "session-not-found",
  // The session exists but could not be read or forked.
  "unreadable",
  // The session holds no messages to import.
  "empty-session",
]);
export type ExternalSessionImportFailure = typeof ExternalSessionImportFailure.Type;

export class ExternalSessionImportError extends Schema.TaggedErrorClass<ExternalSessionImportError>()(
  "ExternalSessionImportError",
  {
    providerInstanceId: ProviderInstanceId,
    sessionId: TrimmedNonEmptyString,
    reason: ExternalSessionImportFailure,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to import external session '${this.sessionId}' from provider '${this.providerInstanceId}' (${this.reason}).`;
  }
}
