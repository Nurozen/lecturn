/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is cached per instance and installed CLI version so accounts
 * remain isolated and provider upgrades discover their new models.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind } from "@lecturn/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import {
  createClaudeAdapterV2,
  type ClaudeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeScopedLimitNames } from "../Layers/claudeUsageLimits.ts";
import * as ClaudeResetCredits from "../Layers/claudeResetCredits.ts";
import * as ResetCreditCoordinator from "../Layers/resetCreditCoordinator.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
} from "../Layers/ClaudeProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import * as ModelManifest from "../ModelManifest.ts";
import {
  mergeClaudeRuntimeModelCatalog,
  resolveClaudeModelCatalog,
} from "../ClaudeModelCatalog.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeClaudeExternalSessionImporter } from "./ClaudeExternalSessionImport.ts";
import {
  claudeExternalSessionsConfigDir,
  makeClaudeExternalSessionsLister,
} from "./ClaudeExternalSessions.ts";
import {
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";
import { makeClaudeCapabilitiesCache } from "./ClaudeCapabilitiesCache.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
  | ClaudeAdapterV2DriverEnv
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ModelManifest.ModelManifest
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService;

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* ServerConfig.ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const modelManifest = yield* ModelManifest.ModelManifest;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      } satisfies ClaudeSettings;
      const capabilitiesCache = yield* makeClaudeCapabilitiesCache(
        probeClaudeCapabilities(effectiveConfig, processEnv, cwd).pipe(
          Effect.provideService(Path.Path, path),
        ),
      );
      // Snapshots and dispatch resolve the same per-instance runtime metadata.
      const modelCatalog = modelManifest.current.pipe(
        Effect.map((manifest) =>
          mergeClaudeRuntimeModelCatalog(
            resolveClaudeModelCatalog(manifest),
            capabilitiesCache.currentModels,
          ),
        ),
      );
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(
        effectiveConfig,
        processEnv,
      );
      const configDir = yield* resolveClaudeHomePath(effectiveConfig, processEnv);
      const accountConfigPath = yield* ClaudeResetCredits.claudeAccountConfigPath(
        effectiveConfig.homePath.trim() || processEnv.CLAUDE_CONFIG_DIR?.trim()
          ? configDir
          : undefined,
      );
      // External sessions are only listable from the server process's own
      // Claude home, so a custom-home instance reports the capability off.
      const externalSessionsConfigDir = claudeExternalSessionsConfigDir(
        yield* makeClaudeEnvironment(effectiveConfig, processEnv),
      );
      const stampInstanceIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey,
      });
      const stampIdentity = (draft: ServerProviderDraft) => ({
        ...stampInstanceIdentity(draft),
        externalSessions: externalSessionsConfigDir === undefined ? "unsupported" : "supported",
      });

      const scopedLimitNames = yield* makeClaudeScopedLimitNames;
      const orchestrationAdapter = yield* createClaudeAdapterV2(
        {
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config,
        },
        { scopedLimitNames, onUsageLimits: (update) => snapshot.applyUsageLimits(update) },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Claude orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeClaudeTextGeneration(
        effectiveConfig,
        processEnv,
        modelCatalog,
      );

      // Start the TTL-gated refresh without delaying provider readiness. The
      // next check observes a remote manifest after the background fetch lands.
      const checkProvider = modelManifest.refreshInBackground.pipe(
        Effect.andThen(
          modelManifest.current.pipe(
            Effect.flatMap((manifest) =>
              checkClaudeProviderStatus(
                effectiveConfig,
                (_settings, version) => capabilitiesCache.get(version ?? null),
                processEnv,
                cwd,
                resolveClaudeModelCatalog(manifest),
                scopedLimitNames,
                () => capabilitiesCache.currentModels,
                (version) =>
                  ClaudeResetCredits.readClaudeResetCredits(configDir, version).pipe(
                    Effect.provideService(HttpClient.HttpClient, httpClient),
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.provideService(Path.Path, path),
                  ),
              ),
            ),
            Effect.map(stampIdentity),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        resolveMaintenance,
        discovery: {
          waitForShell: !/[\\/]/.test(effectiveConfig.binaryPath?.trim() ?? ""),
          refreshEnvironment: () =>
            Object.assign(processEnv, mergeProviderInstanceEnvironment(environment)),
        },
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          modelManifest.current.pipe(
            Effect.flatMap((manifest) =>
              makePendingClaudeProvider(settings.provider, resolveClaudeModelCatalog(manifest)),
            ),
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      // Same rules as Codex: serialised on the config directory that holds the
      // login, one request id kept until Claude answers (a cooldown or rate
      // limit is an answer), then a re-probe.
      const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = () =>
        Effect.gen(function* () {
          const current = yield* snapshot.getSnapshot;
          const grantId = current.usageLimits?.resetCredits?.nextCreditId;
          if (!grantId || !current.version) return "noCredit" as const;
          const version = current.version;
          return yield* resetCreditCoordinator.redeem(
            configDir,
            (requestId) =>
              ClaudeResetCredits.consumeClaudeResetCredit({
                configDir,
                accountConfigPath,
                version,
                grantId,
                requestId,
              }),
            ClaudeResetCredits.isSettledClaudeResetCreditFailure,
          );
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail:
                  cause._tag === "ClaudeResetCreditError"
                    ? cause.message
                    : "Claude could not redeem the reset.",
                cause,
              }),
          ),
          // Re-probe after any answer, but only a reset claims the limits
          // changed, so only a reset reports an unconfirmed refresh.
          Effect.tap((outcome) =>
            Effect.gen(function* () {
              const before = (yield* snapshot.getSnapshot).usageLimits?.checkedAt;
              yield* capabilitiesCache.invalidate;
              const refreshed = yield* snapshot.refresh;
              const after = refreshed.usageLimits?.checkedAt;
              if (
                outcome === "reset" &&
                (after === undefined ||
                  after === before ||
                  refreshed.usageLimits?.unavailable?.reason === "probeFailed")
              ) {
                return yield* new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail:
                    "The reset was applied, but Claude could not confirm the new limits. Refresh to check.",
                });
              }
            }),
          ),
        );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd: (cwd: string) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : Effect.all([
                snapshot.getSnapshot,
                discoverClaudeSkills(effectiveConfig, cwd, processEnv),
              ]).pipe(
                Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              ),
        refreshModels: () => capabilitiesCache.invalidate,
        ...(externalSessionsConfigDir === undefined
          ? {}
          : {
              listExternalSessions: makeClaudeExternalSessionsLister({
                instanceId,
                configDir: externalSessionsConfigDir,
              }),
              importExternalSession: makeClaudeExternalSessionImporter({
                instanceId,
                configDir: externalSessionsConfigDir,
              }),
            }),
        orchestrationAdapter,
        textGeneration,
        consumeResetCredit,
      } satisfies ProviderInstance;
    }),
};
