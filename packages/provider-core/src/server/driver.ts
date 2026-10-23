/**
 * There are intentionally no per-driver Context tags because tags are
 * singleton-per-runtime and we need many instances of the same driver.
 */
import type {
  ExternalSessionImportError,
  ExternalSessionsListError,
  ExternalSessionSummary,
  IsoDateTime,
  ProviderConsumeResetCreditOutcome,
  AcpRegistryListSessionsResult,
  AcpRegistryListProvidersResult,
  AcpRegistryOperationError,
  AcpRegistrySetProviderInput,
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderWorkspaceSnapshot,
  ToolLifecycleItemType,
} from "@lecturn/contracts";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type * as ProviderAdapter from "./ProviderAdapter.ts";
import type { ProviderAuthController } from "./auth.ts";
import type { ProviderDriverError } from "./errors.ts";
import type { ManagedServerProvider } from "./snapshot.ts";
import type { ProviderTextGeneration } from "./textGeneration.ts";
import type { ProviderUsageReader } from "./usage.ts";

export interface ProviderDriverMetadata {
  readonly displayName: string;
  /**
   * Defaults to `true`. Set to `false` for drivers that wrap a global
   * resource (e.g. a single desktop app socket) — the registry then
   * rejects multi-instance configurations with a clear error.
   */
  readonly supportsMultipleInstances?: boolean;
  readonly hasDefaultInstance?: boolean;
}

export type ProviderWorkspaceSnapshot = ServerProvider &
  Pick<ServerProviderWorkspaceSnapshot, "slashCommandsPending">;

/**
 * One session a provider's own tooling created outside Lecturn. The service
 * layer stamps `providerInstanceId` / `driverKind` and caps the text fields,
 * so listers only report what they read.
 */
export type ExternalSessionListing = Omit<
  ExternalSessionSummary,
  "providerInstanceId" | "driverKind"
>;

export interface ListExternalSessionsInput {
  readonly cwd?: string | undefined;
  readonly searchTerm?: string | undefined;
  readonly limit: number;
  /**
   * Every provider-native session/thread id Lecturn already owns, across all
   * instances and providers, since instances can share a home: the native ids
   * of orchestration provider threads (imported forks included) plus the ids
   * legacy resume cursors named. The lister hides the sessions they name.
   */
  readonly knownNativeSessionIds: ReadonlySet<string>;
}

export interface ListExternalSessionsResult {
  /** Newest first, at most `limit` entries. */
  readonly sessions: ReadonlyArray<ExternalSessionListing>;
  /** True when more matching sessions exist than were returned. */
  readonly truncated: boolean;
}

export interface ImportExternalSessionInput {
  /** The external session to fork, as reported by `listExternalSessions`. */
  readonly sessionId: string;
  /** The importing thread's effective cwd (its worktree, else the project root). */
  readonly cwd: string;
}

/** Work-log tone of an imported activity row (the V1 thread activity tones). */
export type ImportedTranscriptActivityTone = "info" | "tool" | "approval" | "error";

/**
 * One row of an external session's history, provider-neutral and
 * summary-level: activities name the work that happened and never carry tool
 * inputs or outputs.
 */
export type ImportedTranscriptEntry =
  | {
      readonly kind: "message";
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly createdAt: IsoDateTime;
    }
  | {
      readonly kind: "activity";
      readonly tone: ImportedTranscriptActivityTone;
      /** The thread activity's kind, e.g. `tool.completed`. */
      readonly activityKind: string;
      readonly summary: string;
      /** Picks the work-log icon; absent renders as generic work. */
      readonly itemType?: ToolLifecycleItemType | undefined;
      /** One short line, e.g. the command or file path. */
      readonly detail?: string | undefined;
      readonly createdAt: IsoDateTime;
    };

export interface ImportedExternalSession {
  /**
   * Provider-native id of the FORK cut from the external session (Claude
   * session id, Codex thread id). The imported thread's provider thread binds
   * it as a strong `nativeThreadRef`, so the V2 adapter resumes the fork; the
   * original session is never resumed.
   */
  readonly nativeThreadId: string;
  readonly title: string;
  /** The external session's own cwd, which may differ from the input cwd. */
  readonly cwd: string;
  /** Chronological. */
  readonly transcript: ReadonlyArray<ImportedTranscriptEntry>;
}

export interface ProviderInstance {
  readonly instanceId: ProviderInstanceId;
  /** Registry-captured effective configuration identity, stable across restarts. */
  readonly configurationFingerprint?: string;
  readonly driverKind: ProviderDriverKind;
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly snapshot: ManagedServerProvider;
  readonly snapshotForCwd?: (
    cwd: string,
  ) => Effect.Effect<ProviderWorkspaceSnapshot, ProviderDriverError>;
  readonly refreshModels?: () => Effect.Effect<void, ProviderDriverError>;
  /** Invalidate Lecturn-owned discovery caches before an explicit provider refresh. */
  readonly invalidateCaches?: Effect.Effect<void>;
  readonly consumeResetCredit?: () => Effect.Effect<
    ProviderConsumeResetCreditOutcome,
    ProviderDriverError
  >;
  /**
   * List sessions created outside Lecturn (provider CLI / desktop app) so they
   * can be imported. Reads the instance's own session store, which is why it
   * lives here rather than on the adapter. Absent means unsupported; a driver
   * that sets it must also report `externalSessions: "supported"` in its
   * presentation.
   */
  readonly listExternalSessions?: (
    input: ListExternalSessionsInput,
  ) => Effect.Effect<ListExternalSessionsResult, ExternalSessionsListError>;
  /**
   * Natively fork one external session and read its history, so a new thread
   * can continue it without touching the original. The fork is a local
   * operation: no auth, no model call. Absent means unsupported; a driver that
   * sets it must also set `listExternalSessions`.
   */
  readonly importExternalSession?: (
    input: ImportExternalSessionInput,
  ) => Effect.Effect<ImportedExternalSession, ExternalSessionImportError>;
  readonly orchestrationAdapter: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly textGeneration: ProviderTextGeneration;
  readonly auth?: ProviderAuthController;
  readonly acpSessionManagement?: {
    readonly listSessions: (input: {
      readonly cwd: string;
      readonly cursor?: string;
    }) => Effect.Effect<AcpRegistryListSessionsResult, AcpRegistryOperationError>;
    readonly logout: (cwd: string) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly deleteSession: (input: {
      readonly cwd: string;
      readonly sessionId: string;
    }) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly listProviders: (
      cwd: string,
    ) => Effect.Effect<AcpRegistryListProvidersResult, AcpRegistryOperationError>;
    readonly setProvider: (
      input: Omit<AcpRegistrySetProviderInput, "instanceId" | "projectId"> & {
        readonly cwd: string;
      },
    ) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly disableProvider: (input: {
      readonly cwd: string;
      readonly providerId: string;
    }) => Effect.Effect<void, AcpRegistryOperationError>;
  };
}

export interface ProviderContinuationIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly continuationKey: string;
}

export function defaultProviderContinuationIdentity(input: {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}): ProviderContinuationIdentity {
  return {
    driverKind: input.driverKind,
    continuationKey: `${input.driverKind}:instance:${input.instanceId}`,
  };
}

export interface ProviderDriverCreateInput<Config> {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly environment: ProviderInstanceEnvironment;
  readonly enabled: boolean;
  readonly config: Config;
}

/**
 * Two calls to `create` with different `instanceId` / `config` MUST yield
 * instances with no shared mutable state.
 */
export interface ProviderDriver<Config, R = never, UsageR = never> {
  readonly driverKind: ProviderDriverKind;
  readonly metadata: ProviderDriverMetadata;
  /**
   * Using `Codec` rather than `Schema` pins `DecodingServices = never` — if
   * we used `Schema<Config>`, the erased `any` in `AnyProviderDriver` would
   * widen `DecodingServices` to `unknown` and poison the R channel of every
   * caller of `decodeUnknownEffect`.
   */
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  /**
   * Failures become unavailable shadow snapshots — the driver MUST NOT throw
   * defects.
   */
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderInstance, ProviderDriverError, R | Scope.Scope>;
  readonly usage?: ProviderUsageReader<Config, UsageR>;
}

export type AnyProviderDriver<R = never, UsageR = unknown> = ProviderDriver<any, R, UsageR>;

export type ProviderUsageReaderEnv<Driver> =
  Driver extends ProviderDriver<any, any, infer UsageR> ? UsageR : never;
