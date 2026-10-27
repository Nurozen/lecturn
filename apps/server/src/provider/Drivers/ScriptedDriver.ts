/**
 * Test-only `scripted` provider. It ships in the server build so end-to-end
 * runs can drive a packaged server, but is registered only with
 * `LECTURN_TEST_PROVIDERS=1`.
 *
 * @module provider/Drivers/ScriptedDriver
 */
import {
  makeProviderSettingsSchema,
  type ServerProviderModel,
  TextGenerationError,
} from "@lecturn/contracts";
import * as HostProcess from "@lecturn/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@lecturn/provider-core/server/ProviderHost";
import {
  type AnyProviderDriver,
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@lecturn/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@lecturn/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@lecturn/provider-core/server/instanceIdentity";
import { makeManagedServerProvider } from "@lecturn/provider-core/server/managedProvider";
import { buildServerProvider } from "@lecturn/provider-core/server/snapshotProbe";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@lecturn/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@lecturn/provider-core/server/textGeneration";

import {
  makeScriptedAdapterV2,
  SCRIPTED_PROVIDER,
} from "../../orchestration-v2/Adapters/ScriptedAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";

const TEST_PROVIDERS_ENV = "LECTURN_TEST_PROVIDERS";

export const ScriptedSettings = makeProviderSettingsSchema({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ScriptedSettings = typeof ScriptedSettings.Type;
const decodeScriptedSettings = Schema.decodeSync(ScriptedSettings);

const SCRIPTED_PRESENTATION = {
  displayName: "Scripted (test)",
  showInteractionModeToggle: false,
  // Every mode, so RuntimePolicy never downgrades a thread (Full access stays Full access).
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
} as const;

// The adapter ignores effort; it is offered so a composer over this provider draws the controls
// real providers have (model | effort | access), so tests over it see the real layout.
const SCRIPTED_MODELS = [
  {
    slug: "scripted",
    name: "Scripted",
    isCustom: false,
    isDefault: true,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
          ],
        },
      ],
    },
  },
] satisfies ReadonlyArray<ServerProviderModel>;

export type ScriptedDriverEnv =
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost;

const unsupportedTextGeneration = (operation: string) =>
  Effect.fail(
    new TextGenerationError({ operation, detail: "The scripted provider writes no text." }),
  );

const scriptedTextGeneration: ProviderTextGeneration = {
  generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
  generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
  generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
  generateWorkflowSummary: () => unsupportedTextGeneration("generateWorkflowSummary"),
  generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
  generateReviewGuide: () => unsupportedTextGeneration("generateReviewGuide"),
};

export const ScriptedDriver: ProviderDriver<ScriptedSettings, ScriptedDriverEnv> = {
  driverKind: SCRIPTED_PROVIDER,
  metadata: { displayName: "Scripted (test)", hasDefaultInstance: false },
  configSchema: ScriptedSettings,
  defaultConfig: () => decodeScriptedSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const processEnvironment = yield* mergeProviderInstanceEnvironment(
        environment,
        yield* HostProcess.Environment,
      );
      const effectiveConfig = { ...config, enabled } satisfies ScriptedSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: SCRIPTED_PROVIDER,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: SCRIPTED_PROVIDER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const readySnapshot = Effect.gen(function* () {
        return stampIdentity(
          buildServerProvider({
            presentation: SCRIPTED_PRESENTATION,
            enabled,
            checkedAt: DateTime.formatIso(yield* DateTime.now),
            models: SCRIPTED_MODELS,
            probe: {
              installed: true,
              version: null,
              status: "ready",
              auth: { status: "unknown" },
            },
          }),
        );
      });
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ScriptedSettings>>(
        {
          resolveMaintenance: () =>
            Effect.succeed({ provider: SCRIPTED_PROVIDER, packageName: null, update: null }),
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: () => readySnapshot,
          checkProvider: readySnapshot,
          refreshOnInterval: false,
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: SCRIPTED_PROVIDER,
              instanceId,
              detail: "Failed to build the scripted provider snapshot.",
              cause,
            }),
        ),
      );
      const orchestrationAdapter = yield* makeScriptedAdapterV2({
        instanceId,
        environment: processEnvironment,
      });
      return {
        instanceId,
        driverKind: SCRIPTED_PROVIDER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration: scriptedTextGeneration,
      } satisfies ProviderInstance;
    }),
};

/** The registry's driver list: the built-ins, plus `scripted` only when test providers are on. */
export function withTestProviderDrivers<R>(
  drivers: ReadonlyArray<AnyProviderDriver<R>>,
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<AnyProviderDriver<R | ScriptedDriverEnv>> {
  return environment[TEST_PROVIDERS_ENV] === "1" ? [...drivers, ScriptedDriver] : drivers;
}
