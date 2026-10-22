/**
 * CopilotAdapterV2 — GitHub Copilot CLI (`copilot --acp`) on the generic ACP
 * adapter.
 *
 * Copilot speaks ACP v1: URL mode ids (`…/session-modes#plan|#agent`), a
 * session-wide `allow_all` switch, `session/set_model` with no advertised model
 * state, and underscore permission option ids (matched by kind). Plan
 * interaction maps to `#plan`, everything else to `#agent`; full access turns
 * `allow_all` on and Copilot is spawned with `--allow-all`. In plan mode
 * Copilot writes its plan to `plan.md` under its session-state directory; that
 * write surfaces as the proposed plan and renders as a plan step rather than a
 * project file change. A cancelled prompt's trailing reply is dropped until the
 * next prompt opens with `usage_update` (see `withCopilotCancelledStreamDiscard`).
 *
 * @module orchestration-v2/Adapters/CopilotAdapterV2
 */
// @effect-diagnostics nodeBuiltinImport:off - synchronous plan-file reads inside ACP callbacks
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import {
  GithubCopilotSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@lecturn/contracts";
import { HostProcessEnvironment } from "@lecturn/shared/hostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@lecturn/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ServerConfig from "../../config.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import {
  applyCopilotModelSelection,
  applyCopilotSessionConfiguration,
  copilotActionableErrorDetail,
  copilotHomeDir,
  COPILOT_PLAN_STEP_TITLE,
  extractCopilotPlanMarkdown,
  makeCopilotAcpRuntime,
  normalizeCopilotSessionStateEdit,
  withCopilotCancelledStreamDiscard,
} from "../../provider/acp/CopilotAcpSupport.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import {
  currentStaveMemoryResolver,
  staveMemoryAcpExtraMcpServers,
} from "../../provider/StaveMemoryMcp.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderContinuationRequests from "../ProviderContinuationRequests.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

export const COPILOT_PROVIDER = ProviderDriverKind.make("githubCopilot");
const DEFAULT_COPILOT_SETTINGS = Schema.decodeSync(GithubCopilotSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export const CopilotProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    // Copilot has no ACP session fork; forks of Copilot threads use portable handoffs.
    canForkThread: false,
    canForkFromTurn: false,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface CopilotAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: GithubCopilotSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly selfInvocation: SelfInvocation;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  /** Home directory `~/.copilot` resolves under when `COPILOT_HOME` is unset. */
  readonly homeDir?: string;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  /** Stave memory MCP servers for a session cwd. */
  readonly extraMcpServers?: Parameters<typeof makeAcpAdapterV2>[0]["extraMcpServers"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
}

function readTextFileSync(filePath: string): string | undefined {
  try {
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export function makeCopilotAcpAdapterFlavor(options: CopilotAdapterV2Options): AcpAdapterV2Flavor {
  const copilotHome = copilotHomeDir(
    options.path,
    options.environment,
    options.homeDir ?? NodeOS.homedir(),
  );
  return {
    driver: COPILOT_PROVIDER,
    runtimeHarness: "GitHub Copilot",
    capabilities: CopilotProviderCapabilitiesV2,
    // Copilot answers session/cancel by resolving the prompt as cancelled.
    interruptPromptOnCancel: false,
    supportsImagePrompts: true,
    // Without a plan.md write, the plan turn's final answer is the plan.
    planFromFinalAssistantMessage: true,
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy, processEnvironment, ...input }) =>
        makeCopilotAcpRuntime({
          ...input,
          copilotSettings: options.settings,
          environment:
            processEnvironment === undefined
              ? options.environment
              : { ...options.environment, ...processEnvironment },
          childProcessSpawner: options.childProcessSpawner,
          runtimeMode: runtimePolicy.runtimeMode,
          cancelBehavior: "wait-for-prompt",
        }).pipe(Effect.flatMap(withCopilotCancelledStreamDiscard))),
    // `auto` is a real Copilot model id. Copilot CLI (ACP v1) advertises no
    // model state, so the selection goes through session/set_model; an ACP v2
    // agent selects it through its model configuration option when it has one.
    applyModelSelection: ({ runtime, startResult, modelSelection }) =>
      startResult.initializeResult.protocolVersion === 1
        ? applyCopilotModelSelection({
            runtime,
            currentModelId: undefined,
            requestedModelId: modelSelection.model,
            mapError: (cause) => cause,
          })
        : runtime.getConfigOptions.pipe(
            Effect.flatMap((configOptions) =>
              configOptions.some((option) => option.category === "model")
                ? runtime.setModel(modelSelection.model).pipe(Effect.as(modelSelection.model))
                : Effect.succeed(undefined),
            ),
          ),
    configureSessionForPolicy: ({ runtime, runtimePolicy }) =>
      applyCopilotSessionConfiguration({
        runtime,
        runtimeMode: runtimePolicy.runtimeMode,
        interactionMode: runtimePolicy.interactionMode,
        mapError: ({ cause }) => cause,
      }),
    normalizeToolCall: (toolCall) =>
      normalizeCopilotSessionStateEdit(options.path, toolCall, copilotHome),
    extractProposedPlanMarkdown: (toolCall) =>
      extractCopilotPlanMarkdown(
        options.path,
        // Classify the raw write: normalization retitled it as a plan step.
        toolCall.title === COPILOT_PLAN_STEP_TITLE ? { ...toolCall, kind: "edit" } : toolCall,
        copilotHome,
        readTextFileSync,
      ),
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        ...(isAcpRequestError(cause)
          ? {
              message: copilotActionableErrorDetail(cause.errorMessage) ?? cause.errorMessage,
              code: String(cause.code),
              class: "provider_error",
            }
          : { class: "provider_error" }),
      }),
  };
}

export function makeCopilotAdapterV2(options: CopilotAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeCopilotAcpAdapterFlavor(options),
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
    ...(options.extraMcpServers === undefined ? {} : { extraMcpServers: options.extraMcpServers }),
  });
}

export type CopilotAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const CopilotAdapterV2Driver: ProviderAdapterDriver<
  GithubCopilotSettings,
  CopilotAdapterV2DriverEnv
> = {
  driverKind: COPILOT_PROVIDER,
  configSchema: GithubCopilotSettings,
  defaultConfig: (): GithubCopilotSettings => DEFAULT_COPILOT_SETTINGS,
  create: Effect.fn("CopilotAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<GithubCopilotSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const selfInvocation = yield* resolveSelfInvocation();
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const resolveStaveMemory = yield* currentStaveMemoryResolver;
      return makeCopilotAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        childProcessSpawner,
        crypto,
        fileSystem,
        path,
        idAllocator,
        serverConfig,
        selfInvocation,
        continuationRequests,
        extraMcpServers: staveMemoryAcpExtraMcpServers(resolveStaveMemory),
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: COPILOT_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: COPILOT_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create GitHub Copilot ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
