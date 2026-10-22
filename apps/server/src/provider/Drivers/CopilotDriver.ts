/**
 * CopilotDriver — `ProviderDriver` for the GitHub Copilot CLI (`copilot --acp`).
 *
 * @module provider/Drivers/CopilotDriver
 */
import { GithubCopilotSettings, ProviderDriverKind } from "@lecturn/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import {
  CopilotAdapterV2Driver,
  type CopilotAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/CopilotAdapterV2.ts";
import { StaveMemoryWiring } from "../../stave/StaveMemoryWiring.ts";
import { makeCopilotTextGeneration } from "../../textGeneration/CopilotTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
  COPILOT_DETECTION_TIMEOUT_MS,
  enrichCopilotSnapshot,
} from "../CopilotProvider.ts";
import * as ProviderEventLoggers from "@lecturn/provider-core/server/ProviderEventLoggers";
import { makeManagedServerProvider } from "@lecturn/provider-core/server/managedProvider";
import * as ProviderHost from "@lecturn/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@lecturn/provider-core/server/ProviderLatestVersions";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@lecturn/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@lecturn/provider-core/server/instanceEnvironment";
import {
  isNodePackageManagerCommandPath,
  makeCachedProviderMaintenanceResolution,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@lecturn/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@lecturn/provider-core/server/snapshotSettings";
import { withInstanceIdentity } from "@lecturn/provider-core/server/instanceIdentity";

const decodeCopilotSettings = Schema.decodeSync(GithubCopilotSettings);

const DRIVER_KIND = ProviderDriverKind.make("githubCopilot");
const COPILOT_NPM_PACKAGE = "@github/copilot";

const COPILOT_PACKAGE_MAINTENANCE = {
  provider: DRIVER_KIND,
  npmPackageName: COPILOT_NPM_PACKAGE,
  nativeUpdate: null,
};

/**
 * npm, bun, pnpm, and Vite+ installs update through their package manager, and
 * only once that manager is proven to own the executable. Every other install
 * (Homebrew cask, WinGet, the install script) updates itself with
 * `copilot update`. The npm package name stays set either way so the registry
 * version check still works.
 */
export const COPILOT_UPDATE_RESOLVER: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) => {
    if (
      context === null ||
      [context.resolvedCommandPath, context.realCommandPath].some(isNodePackageManagerCommandPath)
    ) {
      return resolvePackageManagedProviderMaintenance(COPILOT_PACKAGE_MAINTENANCE, context);
    }
    return Effect.succeed(
      makeProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: COPILOT_NPM_PACKAGE,
        updateExecutable: context.resolvedCommandPath,
        updateArgs: ["update"],
        updateLockKey: "copilot-native",
        platform: context.platform,
      }),
    );
  },
};

export type CopilotDriverEnv =
  | StaveMemoryWiring
  | CopilotAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost
  | ProviderLatestVersions.ProviderLatestVersions
  | ServerConfig.ServerConfig;

export const CopilotDriver: ProviderDriver<GithubCopilotSettings, CopilotDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "GitHub Copilot",
    supportsMultipleInstances: true,
  },
  configSchema: GithubCopilotSettings,
  defaultConfig: (): GithubCopilotSettings => decodeCopilotSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies GithubCopilotSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(COPILOT_UPDATE_RESOLVER, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );

      const staveMemoryWiring = yield* StaveMemoryWiring;
      const orchestrationAdapter = yield* CopilotAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build GitHub Copilot orchestration adapter.",
              cause,
            }),
        ),
        Effect.provideService(StaveMemoryWiring, staveMemoryWiring),
      );
      const textGeneration = yield* makeCopilotTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkCopilotProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<GithubCopilotSettings>
      >({
        resolveMaintenance,
        discovery: {
          waitForShell: !/[\\/]/.test(effectiveConfig.binaryPath?.trim() ?? ""),
          refreshEnvironment: () =>
            mergeProviderInstanceEnvironment(environment).pipe(
              Effect.map((next) => {
                Object.assign(processEnv, next);
              }),
            ),
        },
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialCopilotProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        detectionTimeout: COPILOT_DETECTION_TIMEOUT_MS,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichCopilotSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
                httpClient,
                latestVersions,
              }),
            ),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build GitHub Copilot snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
