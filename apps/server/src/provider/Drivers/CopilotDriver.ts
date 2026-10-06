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
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { StaveMemoryWiring } from "../../stave/StaveMemoryWiring.ts";
import { makeCopilotTextGeneration } from "../../textGeneration/CopilotTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCopilotAdapter } from "../Layers/CopilotAdapter.ts";
import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
  COPILOT_DETECTION_TIMEOUT_MS,
  enrichCopilotSnapshot,
} from "../Layers/CopilotProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  isNodePackageManagerCommandPath,
  makeCachedProviderMaintenanceResolution,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

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
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

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
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
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

      const adapter = yield* makeCopilotAdapter(effectiveConfig, {
        staveMemoryWiring: yield* StaveMemoryWiring,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeCopilotTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkCopilotProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<GithubCopilotSettings>
      >({
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
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
