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
import * as HostProcess from "@lecturn/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@lecturn/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "effect-acp/errors";

import { withAgentDeviceEnvironment } from "@lecturn/provider-core/server/mcpSession";
import { makeAcpNativeLoggerFactory } from "@lecturn/provider-acp/server/nativeLogging";
import type * as AcpSessionRuntime from "@lecturn/provider-acp/server/AcpSessionRuntime";
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
import * as ProviderEventLoggers from "@lecturn/provider-core/server/ProviderEventLoggers";
import { mergeProviderInstanceEnvironment } from "@lecturn/provider-core/server/instanceEnvironment";
import {
  currentStaveMemoryResolver,
  staveMemoryAcpExtraMcpServers,
} from "@lecturn/provider-core/server/staveMemory";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@lecturn/provider-core/server/ProviderContinuationRequests";
import * as ProviderHost from "@lecturn/provider-core/server/ProviderHost";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@lecturn/provider-core/server/adapterDriver";
import { makeProviderFailure } from "@lecturn/provider-core/server/failure";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@lecturn/provider-acp/server/adapter";

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
  readonly selfInvocation: SelfInvocation;
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
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
}

/** The services the Copilot flavor launches its runtime and reads plan files with. */
export interface CopilotFlavorServices {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly path: Path.Path;
}

function readTextFileSync(filePath: string): string | undefined {
  try {
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export function makeCopilotAcpAdapterFlavor(
  options: CopilotAdapterV2Options & CopilotFlavorServices,
): AcpAdapterV2Flavor {
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
      (({ runtimePolicy, processEnvironment, agentDeviceEnvironment, ...input }) =>
        makeCopilotAcpRuntime({
          ...input,
          copilotSettings: options.settings,
          environment: withAgentDeviceEnvironment(
            processEnvironment === undefined
              ? options.environment
              : { ...options.environment, ...processEnvironment },
            { agentDeviceEnvironment },
          ),
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

export const makeCopilotAdapterV2 = Effect.fn("makeCopilotAdapterV2")(function* (
  options: CopilotAdapterV2Options,
) {
  const services: CopilotFlavorServices = {
    childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    path: yield* Path.Path,
  };
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeCopilotAcpAdapterFlavor({ ...options, ...services }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
    ...(options.extraMcpServers === undefined ? {} : { extraMcpServers: options.extraMcpServers }),
  });
});

export type CopilotAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const CopilotAdapterV2Driver: ProviderAdapterDriver<
  GithubCopilotSettings,
  CopilotAdapterV2DriverEnv
> = {
  driverKind: COPILOT_PROVIDER,
  configSchema: GithubCopilotSettings,
  defaultConfig: (): GithubCopilotSettings => DEFAULT_COPILOT_SETTINGS,
  create: Effect.fn("CopilotAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<GithubCopilotSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const resolveStaveMemory = yield* currentStaveMemoryResolver;
      return yield* makeCopilotAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        homeDir: yield* HostProcess.HomeDirectory,
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
