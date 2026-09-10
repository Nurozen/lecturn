/**
 * staveRpcHandlers - the `stave.*` RPCs served over the WebSocket group.
 *
 * `stave.getStatus` is the LIVE counterpart of the static `capabilities.stave`
 * descriptor (deviation 5): it answers "is a binary runnable, does the config
 * exist, where are the roots, is marmot around, what failed last" without
 * ever running a mutating Stave verb (deviation 21). `stave.spaceStatus` runs
 * `stave space status <id>` for the space whose manifest sits at a workspace
 * root, cached server-wide for 15 seconds per root.
 *
 * The list reads (`listRepos|listSpaces|listSagas|memoryProviders`) run one
 * `--json` read verb each; `dryRun` asks `StaveOperations` for a plan; the
 * two stream RPCs (`runOperation`, `observeOperation`) hand the request to the
 * application-lifetime `StaveOperations` registry, so an operation outlives
 * the socket that started it.
 *
 * Gating: every RPC refuses with `StaveUnavailableError{reason:
 * "disabled_by_server"}` when `T3CODE_STAVE` is off; all but `getStatus`
 * further require `settings.stave.enabled` and a runnable binary. The status
 * RPC deliberately works without those so clients can show what is missing.
 *
 * `StaveRpcRuntime` holds the server-lifetime pieces (last failure, the
 * space-status cache); `makeStaveRpcHandlers` builds one handler record per
 * connection around the auth/tracing wrappers `ws.ts` already uses.
 *
 * @module staveRpcHandlers
 */
import {
  type EnvironmentAuthorizationError,
  type StaveDryRunInput,
  type StaveDryRunPlan,
  type StaveLastFailure,
  type StaveListSpacesInput,
  type StaveMemoryProvider,
  type StaveObserveOperationInput,
  type StaveRepoRow,
  type StaveRunOperationInput,
  type StaveOperation,
  type StaveMarmotStatus,
  type StaveSagaListRow,
  type StaveSagaStatus,
  type StaveSpaceListRow,
  type StaveSpaceStatus,
  type StaveStatus,
  StaveCommandError,
  StaveNotSpaceError,
  StaveUnavailableError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { StaveLifecycleRepository } from "../persistence/Services/StaveLifecycleRepository.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { StaveBinary, type StaveBinaryError } from "./StaveBinary.ts";
import { StaveCli } from "./StaveCli.ts";
import { StaveConfigReader, type StaveConfigSnapshot } from "./StaveConfigReader.ts";
import type { StaveError } from "./StaveError.ts";
import { scanStaveMembership } from "./StaveMembership.ts";
import { StaveReadCache } from "./StaveReadCache.ts";
import { StaveOperations } from "./StaveOperations.ts";
import type {
  StaveMemoryProviders,
  StaveReposList,
  StaveSagaList,
  StaveSagaStatus as StaveSagaStatusJson,
  StaveSpaceList,
  StaveSpaceStatus as StaveSpaceStatusJson,
} from "./staveJson.ts";
import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";

/** How long one `space status` answer is reused for a root before Stave is asked again. */
export const STAVE_SPACE_STATUS_CACHE_TTL = Duration.seconds(15);
const STAVE_SPACE_STATUS_CACHE_CAPACITY = 256;

/** Provider row consulted when the config names no memory provider. */
const DEFAULT_MEMORY_PROVIDER = "marmot";

const NO_MARMOT: StaveMarmotStatus = { available: false, version: null };

// ── Pure mappings ──────────────────────────────────────────────

/** `runnableError.code` for the two ways the settings-independent walk can fail. */
export function runnableErrorCode(error: StaveBinaryError): string {
  switch (error._tag) {
    case "StaveBinaryNotFound":
      return "binary_missing";
    case "StaveBinaryNotExecutable":
      return "binary_not_executable";
  }
}

export function toStaveCommandError(error: StaveError): StaveCommandError {
  return new StaveCommandError({ verb: error.verb, code: error.code, message: error.message });
}

/**
 * Marmot availability from `memory providers`: the row for the configured
 * provider (default `marmot`), else the provider Stave marks as default.
 */
export function marmotStatusFromProviders(
  rows: StaveMemoryProviders,
  configuredProvider: string | undefined,
): StaveMarmotStatus {
  const wanted = configuredProvider ?? DEFAULT_MEMORY_PROVIDER;
  const row = rows.find((candidate) => candidate.name === wanted) ?? rows.find((c) => c.default);
  if (row === undefined) {
    return NO_MARMOT;
  }
  return { available: row.available, version: row.version ?? null };
}

export function rootsFromSnapshot(snapshot: StaveConfigSnapshot): StaveStatus["roots"] {
  if (
    snapshot.root === undefined ||
    snapshot.bareReposDir === undefined ||
    snapshot.agentWorkDir === undefined
  ) {
    return null;
  }
  return {
    root: snapshot.root,
    bareReposDir: snapshot.bareReposDir,
    agentWorkDir: snapshot.agentWorkDir,
  };
}

const optionalString = <K extends string>(key: K, value: string | undefined) =>
  value === undefined ? {} : ({ [key]: value } as { readonly [P in K]: string });

/** camelCase wire shape of `space status --json`, minus the manifest clients already hold. */
export function toSpaceStatusDto(json: StaveSpaceStatusJson): StaveSpaceStatus {
  return {
    spaceId: json.spaceId,
    spacePath: json.spacePath,
    ...optionalString("kind", json.manifest.kind),
    createdAt: json.manifest.createdAt,
    repos: json.repos.map((repo) => ({
      name: repo.name,
      mode: repo.mode,
      path: repo.path,
      ...optionalString("branch", repo.branch),
      ...optionalString("base", repo.base),
      ...optionalString("ref", repo.ref),
      exists: repo.exists,
      dirty: repo.dirty,
      ...optionalString("dirtyOutput", repo.dirtyOutput),
      ahead: repo.ahead,
      behind: repo.behind,
      ...optionalString("driftError", repo.driftError),
      ...optionalString("referenceWarn", repo.referenceWarn),
    })),
    memories: json.memories.map((memory) => ({
      name: memory.name,
      provider: memory.provider,
      id: memory.id,
      owned: memory.owned,
      ...optionalString("state", memory.state),
    })),
  };
}

/** `repos list --json` rows already carry the wire shape; the copy pins the DTO type. */
export function toRepoRows(rows: StaveReposList): ReadonlyArray<StaveRepoRow> {
  return rows.map((row) => ({
    name: row.name,
    url: row.url,
    bareRepoPath: row.bareRepoPath,
    ...optionalString("defaultBranch", row.defaultBranch),
    ...optionalString("description", row.description),
    tetherCount: row.tetherCount,
  }));
}

/** `space list [--archived] --json` rows; v0.4 identity fields pass through. */
export function toSpaceRows(rows: StaveSpaceList): ReadonlyArray<StaveSpaceListRow> {
  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    ...optionalString("kind", row.kind),
    ...optionalString("createdAt", row.createdAt),
    isSaga: row.isSaga,
    ...optionalString("memberOf", row.memberOf),
    repos: row.repos.map((repo) => ({ name: repo.name, mode: repo.mode })),
    archived: row.archived,
    ...optionalString("error", row.error),
    logicalId: row.logicalId,
    ...optionalString("archiveBasename", row.archiveBasename),
    ...optionalString("manifestCreatedAt", row.manifestCreatedAt),
    manifestVersion: row.manifestVersion,
    memories: row.memories.map((memory) => ({
      name: memory.name,
      provider: memory.provider,
      id: memory.id,
      owned: memory.owned,
    })),
  }));
}

export function toSagaRows(rows: StaveSagaList): ReadonlyArray<StaveSagaListRow> {
  return rows.map((row) => ({
    id: row.id,
    ...optionalString("kind", row.kind),
    isSaga: row.isSaga,
    members: [...row.members],
    ...optionalString("memberOf", row.memberOf),
    ...optionalString("error", row.error),
    path: row.path,
    logicalId: row.logicalId,
  }));
}

export function toProviderRows(rows: StaveMemoryProviders): ReadonlyArray<StaveMemoryProvider> {
  return rows.map((row) => ({
    name: row.name,
    ...optionalString("binary", row.binary),
    default: row.default,
    available: row.available,
    ...optionalString("version", row.version),
    capabilities: [...row.capabilities],
    ...optionalString("error", row.error),
  }));
}

export function toSagaStatusDto(json: StaveSagaStatusJson): StaveSagaStatus {
  return json;
}

// ── Server-lifetime runtime ───────────────────────────────────

export interface StaveRpcRuntimeShape {
  /** Most recent failed `StaveCli` call, for the diagnostics block. */
  readonly lastFailure: Effect.Effect<Option.Option<StaveLastFailure>>;
  /** Remember a failed `StaveCli` call; every handler taps its CLI errors through here. */
  readonly recordFailure: (error: StaveError) => Effect.Effect<void>;
  /** `space status` for the space rooted at `workspaceRoot`, cached per root for the TTL. */
  readonly sagaStatus: (
    sagaRoot: string,
  ) => Effect.Effect<StaveSagaStatus, StaveNotSpaceError | StaveCommandError>;
  readonly spaceStatus: (
    workspaceRoot: string,
  ) => Effect.Effect<StaveSpaceStatus, StaveNotSpaceError | StaveCommandError>;
}

export class StaveRpcRuntime extends Context.Service<StaveRpcRuntime, StaveRpcRuntimeShape>()(
  "t3/stave/staveRpcHandlers/StaveRpcRuntime",
) {}

export interface StaveRpcRuntimeOptions {
  readonly spaceStatusTtl?: Duration.Input;
}

export const makeRuntime = Effect.fn("StaveRpcRuntime.make")(function* (
  options: StaveRpcRuntimeOptions = {},
) {
  const cli = yield* StaveCli;
  const reader = yield* StaveWorkspaceReader;
  const invalidation = yield* Effect.serviceOption(StaveReadCache);
  let seenGeneration = -1;
  const lastFailureRef = yield* Ref.make(Option.none<StaveLastFailure>());

  const recordFailure = (error: StaveError) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        Ref.set(
          lastFailureRef,
          Option.some({
            at: DateTime.formatIso(now),
            verb: error.verb,
            code: error.code,
            message: error.message,
          }),
        ),
      ),
    );

  const lookupSpaceStatus = Effect.fn("StaveRpcRuntime.lookupSpaceStatus")(function* (
    workspaceRoot: string,
  ) {
    const info = yield* reader.load(workspaceRoot);
    if (Option.isNone(info)) {
      return yield* new StaveNotSpaceError({
        workspaceRoot,
        message: `No Stave space manifest was found at '${workspaceRoot}'.`,
      });
    }
    const json = yield* cli
      .spaceStatus(info.value.spaceId)
      .pipe(Effect.tapError(recordFailure), Effect.mapError(toStaveCommandError));
    return toSpaceStatusDto(json);
  });

  const ttl = options.spaceStatusTtl ?? STAVE_SPACE_STATUS_CACHE_TTL;
  const cache = yield* Cache.makeWith(lookupSpaceStatus, {
    capacity: STAVE_SPACE_STATUS_CACHE_CAPACITY,
    // Failures are not remembered: the next call asks Stave again.
    timeToLive: Exit.match({ onSuccess: () => ttl, onFailure: () => Duration.zero }),
  });

  const sagaCache = yield* Cache.makeWith(
    Effect.fn("StaveRpcRuntime.lookupSagaStatus")(function* (sagaRoot: string) {
      const info = yield* reader.load(sagaRoot);
      if (Option.isNone(info) || !info.value.isSaga) {
        return yield* new StaveNotSpaceError({
          workspaceRoot: sagaRoot,
          message: `No Stave saga manifest was found at '${sagaRoot}'.`,
        });
      }
      if (info.value.state !== "live") {
        return yield* new StaveCommandError({
          verb: "saga status",
          code: "archived_project",
          message: "Restore the saga before reading its live status.",
        });
      }
      return yield* cli
        .sagaStatus(info.value.spaceId)
        .pipe(
          Effect.tapError(recordFailure),
          Effect.mapError(toStaveCommandError),
          Effect.map(toSagaStatusDto),
        );
    }),
    {
      capacity: STAVE_SPACE_STATUS_CACHE_CAPACITY,
      timeToLive: Exit.match({ onSuccess: () => ttl, onFailure: () => Duration.zero }),
    },
  );
  const refreshGeneration = Effect.gen(function* () {
    if (Option.isNone(invalidation)) return;
    const generation = yield* invalidation.value.generation;
    if (generation === seenGeneration) return;
    yield* Cache.invalidateAll(cache);
    yield* Cache.invalidateAll(sagaCache);
    seenGeneration = generation;
  });

  return StaveRpcRuntime.of({
    sagaStatus: (sagaRoot) =>
      refreshGeneration.pipe(Effect.andThen(Cache.get(sagaCache, sagaRoot))),
    lastFailure: Ref.get(lastFailureRef),
    recordFailure,
    spaceStatus: (workspaceRoot) =>
      Effect.gen(function* () {
        yield* refreshGeneration;
        const status = yield* Cache.get(cache, workspaceRoot);
        return {
          ...status,
          ...(yield* scanStaveMembership(status.spaceId).pipe(
            Effect.provideService(StaveCli, cli),
          )),
        };
      }),
  });
});

export const runtimeLayer = Layer.effect(StaveRpcRuntime, makeRuntime());

// ── Per-connection handlers ───────────────────────────────────

/** The auth + tracing closures `makeWsRpcLayer` wraps every unary handler in. */
export interface StaveRpcWrappers {
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly observeRpcStream: <A, E, R>(
    method: string,
    stream: Stream.Stream<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Stream.Stream<A, E | EnvironmentAuthorizationError, R>;
}

const TRACE_ATTRIBUTES = { "rpc.aggregate": "stave" } as const;

export const makeStaveRpcHandlers = Effect.fn("makeStaveRpcHandlers")(function* (
  wrappers: StaveRpcWrappers,
) {
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const binary = yield* StaveBinary;
  const cli = yield* StaveCli;
  const configReader = yield* StaveConfigReader;
  const runtime = yield* StaveRpcRuntime;
  const operations = yield* StaveOperations;
  const lifecycle = yield* Effect.serviceOption(StaveLifecycleRepository);

  // `T3CODE_STAVE=false` is the unbypassable kill switch: the capability is
  // absent AND every stave RPC refuses, like thread forking.
  const requireKillSwitchOn: Effect.Effect<void, StaveUnavailableError> = config.staveEnabled
    ? Effect.void
    : Effect.fail(
        new StaveUnavailableError({
          reason: "disabled_by_server",
          message: "The Stave integration is disabled on this server.",
        }),
      );

  const probeMarmot = (snapshot: StaveConfigSnapshot) =>
    Effect.suspend(() => cli.memoryProviders).pipe(
      Effect.tapError(runtime.recordFailure),
      Effect.map((rows) => marmotStatusFromProviders(rows, snapshot.memory?.provider)),
      Effect.orElseSucceed(() => NO_MARMOT),
    );

  const getStatus = Effect.gen(function* () {
    yield* requireKillSwitchOn;
    const probe = yield* binary.resolveRunnable.pipe(
      Effect.match({
        onFailure: (error) => ({
          runnable: null,
          runnableError: { code: runnableErrorCode(error), message: error.message },
        }),
        onSuccess: (resolution) => ({ runnable: resolution, runnableError: null }),
      }),
    );
    const snapshot = yield* configReader.load;
    // Read verbs construct Stave's service, which needs the config on disk;
    // without a runnable binary or a config there is nothing to ask.
    const marmot =
      probe.runnable !== null && snapshot.exists ? yield* probeMarmot(snapshot) : NO_MARMOT;
    const lastFailure = yield* runtime.lastFailure;
    return {
      runnable: probe.runnable,
      runnableError: probe.runnableError,
      configPath: snapshot.configPath,
      configExists: snapshot.exists,
      roots: rootsFromSnapshot(snapshot),
      marmot,
      lastFailure: Option.getOrNull(lastFailure),
      pendingCleanups: Option.isNone(lifecycle)
        ? []
        : yield* lifecycle.value.listDeletedCleanups().pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                projectId: row.projectId,
                workspaceRoot: row.workspaceRoot,
                spaceId: row.spaceId,
                manifestCreatedAt: row.manifestCreatedAt,
                disposition: row.disposition,
                refusalCode: row.refusalCode,
                refusalMessage: row.refusalMessage,
                scheduledAt: row.scheduledAt,
              })),
            ),
            Effect.orElseSucceed(() => []),
          ),
    } satisfies StaveStatus;
  });

  const requireEnabled = Effect.gen(function* () {
    yield* requireKillSwitchOn;
    const settings = yield* serverSettings.getSettings;
    if (!settings.stave.enabled) {
      return yield* new StaveUnavailableError({
        reason: "disabled_in_settings",
        message: "The Stave integration is turned off in server settings.",
      });
    }
    yield* binary.resolveRunnable.pipe(
      Effect.mapError(
        (error) => new StaveUnavailableError({ reason: "binary_missing", message: error.message }),
      ),
    );
  });

  const spaceStatus = (workspaceRoot: string) =>
    requireEnabled.pipe(Effect.flatMap(() => runtime.spaceStatus(workspaceRoot)));

  /** One gated read verb, its failure remembered for diagnostics and mapped to the wire error. */
  const gatedRead = <A>(read: Effect.Effect<A, StaveError>) =>
    requireEnabled.pipe(
      Effect.flatMap(() =>
        read.pipe(Effect.tapError(runtime.recordFailure), Effect.mapError(toStaveCommandError)),
      ),
    );

  const listRepos = gatedRead(Effect.suspend(() => cli.reposList).pipe(Effect.map(toRepoRows)));
  const listSpaces = (input: StaveListSpacesInput) =>
    gatedRead(
      Effect.gen(function* () {
        const live = yield* cli.spaceList();
        const archived = input.includeArchived ? yield* cli.spaceList({ archived: true }) : [];
        return toSpaceRows([...live, ...archived]);
      }),
    );
  const listSagas = gatedRead(Effect.suspend(() => cli.sagaList).pipe(Effect.map(toSagaRows)));
  const memoryProviders = gatedRead(
    Effect.suspend(() => cli.memoryProviders).pipe(Effect.map(toProviderRows)),
  );
  const metadataAction = (operation: StaveOperation) =>
    operation.kind === "lifecycleAction" &&
    (operation.action === "keep" || operation.action === "dismiss");
  const dryRun = (input: StaveDryRunInput) =>
    (metadataAction(input.operation)
      ? requireKillSwitchOn.pipe(
          Effect.andThen(
            operations.dryRun(input.operation).pipe(Effect.mapError(toStaveCommandError)),
          ),
        )
      : gatedRead(operations.dryRun(input.operation))
    ).pipe(Effect.map((plan): StaveDryRunPlan => ({ dryRun: true, plan: plan.plan })));

  const runOperation = (input: StaveRunOperationInput) =>
    Stream.unwrap(
      (metadataAction(input.operation)
        ? requireKillSwitchOn
        : requireEnabled.pipe(Effect.asVoid)
      ).pipe(Effect.map(() => operations.run(input))),
    );
  const observeOperation = (input: StaveObserveOperationInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* requireKillSwitchOn;
        const summary = yield* operations.summary(input.operationId);
        if (Option.isNone(summary) || summary.value.kind !== "lifecycleAction")
          yield* requireEnabled;
        return operations.observe(input);
      }),
    );

  return {
    [WS_METHODS.staveGetStatus]: (_input: Record<string, never>) =>
      wrappers.observeRpcEffect(WS_METHODS.staveGetStatus, getStatus, TRACE_ATTRIBUTES),
    [WS_METHODS.staveSpaceStatus]: (input: { readonly workspaceRoot: string }) =>
      wrappers.observeRpcEffect(
        WS_METHODS.staveSpaceStatus,
        spaceStatus(input.workspaceRoot),
        TRACE_ATTRIBUTES,
      ),
    [WS_METHODS.staveSagaStatus]: (input: { readonly sagaRoot: string }) =>
      wrappers.observeRpcEffect(
        WS_METHODS.staveSagaStatus,
        requireEnabled.pipe(Effect.andThen(runtime.sagaStatus(input.sagaRoot))),
        TRACE_ATTRIBUTES,
      ),
    [WS_METHODS.staveListRepos]: (_input: Record<string, never>) =>
      wrappers.observeRpcEffect(WS_METHODS.staveListRepos, listRepos, TRACE_ATTRIBUTES),
    [WS_METHODS.staveListSpaces]: (input: StaveListSpacesInput) =>
      wrappers.observeRpcEffect(WS_METHODS.staveListSpaces, listSpaces(input), TRACE_ATTRIBUTES),
    [WS_METHODS.staveListSagas]: (_input: Record<string, never>) =>
      wrappers.observeRpcEffect(WS_METHODS.staveListSagas, listSagas, TRACE_ATTRIBUTES),
    [WS_METHODS.staveMemoryProviders]: (_input: Record<string, never>) =>
      wrappers.observeRpcEffect(WS_METHODS.staveMemoryProviders, memoryProviders, TRACE_ATTRIBUTES),
    [WS_METHODS.staveDryRun]: (input: StaveDryRunInput) =>
      wrappers.observeRpcEffect(WS_METHODS.staveDryRun, dryRun(input), TRACE_ATTRIBUTES),
    [WS_METHODS.staveRunOperation]: (input: StaveRunOperationInput) =>
      wrappers.observeRpcStream(
        WS_METHODS.staveRunOperation,
        runOperation(input),
        TRACE_ATTRIBUTES,
      ),
    [WS_METHODS.staveObserveOperation]: (input: StaveObserveOperationInput) =>
      wrappers.observeRpcStream(
        WS_METHODS.staveObserveOperation,
        observeOperation(input),
        TRACE_ATTRIBUTES,
      ),
  };
});
