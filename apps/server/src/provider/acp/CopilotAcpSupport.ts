import {
  type GithubCopilotSettings,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@lecturn/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { collectSessionConfigOptionValues, findSessionConfigOption } from "./AcpRuntimeModel.ts";

/** `authenticate` with this method is a no-op when the CLI already has a GitHub login. */
export const COPILOT_AUTH_METHOD_ID = "copilot-login";

/** One-shot text generation: no questions back to the user and no GitHub MCP server boot. */
export const COPILOT_TEXT_GENERATION_SPAWN_ARGS = [
  "--acp",
  "--no-ask-user",
  "--disable-builtin-mcps",
] as const;

const COPILOT_MODE_CONFIG_ID = "mode";
const COPILOT_ALLOW_ALL_CONFIG_ID = "allow_all";

type CopilotAcpRuntimeSettings = Pick<GithubCopilotSettings, "binaryPath">;

export interface CopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly copilotSettings: CopilotAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  /** Replaces the runtime-mode arguments, e.g. {@link COPILOT_TEXT_GENERATION_SPAWN_ARGS}. */
  readonly args?: ReadonlyArray<string>;
}

/**
 * Copilot's permission flags per Lecturn runtime mode. Supervised and auto modes
 * surface every approval; Lecturn never starts Copilot in autopilot. Copilot's
 * ask-user questions have no ACP answer path, so they are always turned off.
 */
export function copilotAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "auto-accept-edits":
      return ["--acp", "--no-ask-user", "--allow-tool", "write"];
    case "full-access":
      return ["--acp", "--no-ask-user", "--allow-all"];
    default:
      return ["--acp", "--no-ask-user"];
  }
}

export function buildCopilotAcpSpawnInput(
  input: Pick<
    CopilotAcpRuntimeInput,
    "copilotSettings" | "cwd" | "environment" | "runtimeMode" | "args"
  >,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: input.copilotSettings?.binaryPath || "copilot",
    args: [...(input.args ?? copilotAcpSpawnArgs(input.runtimeMode))],
    cwd: input.cwd,
    ...(input.environment ? { env: input.environment } : {}),
  };
}

export const makeCopilotAcpRuntime = (
  input: CopilotAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCopilotAcpSpawnInput(input),
        authMethodId: COPILOT_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Sends `session/set_model` unless the requested model is the one last set in this
 * session. `auto` is a real Copilot model id. Returns the model the session runs on
 * afterwards (undefined until one has been set).
 */
export function applyCopilotModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requested = input.requestedModelId?.trim();
  if (!requested || requested === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(requested)
    .pipe(Effect.mapError(input.mapError), Effect.as(requested));
}

/**
 * Copilot's per-session state directory, where plan mode writes `plan.md`.
 * Honors `COPILOT_HOME` from the environment Copilot is spawned with.
 */
export function copilotSessionStateDir(
  path: Pick<Path.Path, "join">,
  environment: NodeJS.ProcessEnv,
  homeDir: string,
  sessionId: string,
): string {
  const copilotHome = environment.COPILOT_HOME?.trim() || path.join(homeDir, ".copilot");
  return path.join(copilotHome, "session-state", sessionId);
}

/**
 * True for a file-changing tool call (Copilot's `apply_patch` and friends) that only
 * touches Copilot's own session state, such as the plan-mode `plan.md`.
 */
export function isCopilotSessionStateEdit(
  path: Pick<Path.Path, "resolve" | "sep">,
  toolCall: { readonly kind?: string; readonly data: Record<string, unknown> },
  sessionStateDir: string,
): boolean {
  if (toolCall.kind !== "edit" && toolCall.kind !== "delete" && toolCall.kind !== "move") {
    return false;
  }
  const paths: string[] = [];
  const { rawInput, locations } = toolCall.data;
  if (typeof rawInput === "string") {
    for (const match of rawInput.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      paths.push(match[1]!.trim());
    }
  } else if (typeof rawInput === "object" && rawInput !== null) {
    for (const key of ["path", "file_path", "filePath"]) {
      const value = (rawInput as Record<string, unknown>)[key];
      if (typeof value === "string") paths.push(value);
    }
  }
  if (Array.isArray(locations)) {
    for (const location of locations) {
      if (typeof location?.path === "string") paths.push(location.path);
    }
  }
  const root = path.resolve(sessionStateDir) + path.sep;
  return paths.length > 0 && paths.every((filePath) => path.resolve(filePath).startsWith(root));
}

function modeFragment(modeId: string): string {
  const hashIndex = modeId.lastIndexOf("#");
  return (hashIndex < 0 ? modeId : modeId.slice(hashIndex + 1)).trim().toLowerCase();
}

/**
 * Copilot mode ids are URLs such as `…/session-modes#plan`. Plan interaction maps to
 * `#plan`, everything else to `#agent`. `#autopilot` is never selected.
 */
export function resolveCopilotModeId(
  availableModeIds: ReadonlyArray<string>,
  interactionMode: ProviderInteractionMode | undefined,
): string | undefined {
  const wanted = interactionMode === "plan" ? "plan" : "agent";
  return availableModeIds.find((modeId) => modeFragment(modeId) === wanted);
}

/**
 * Applies the interaction mode and, for full access, Copilot's session-wide
 * `allow_all` switch. Other runtime modes turn `allow_all` off so a resumed
 * full-access session does not keep bypassing approvals.
 */
export function applyCopilotSessionConfiguration<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getModeState" | "getConfigOptions" | "setMode" | "setConfigOption"
  >;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly method: "session/set_config_option";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const mapError = (cause: EffectAcpErrors.AcpError) =>
      input.mapError({ cause, method: "session/set_config_option" });
    const configOptions = yield* input.runtime.getConfigOptions;
    const allowAll = findSessionConfigOption(configOptions, COPILOT_ALLOW_ALL_CONFIG_ID);
    const allowAllValue = input.runtimeMode === "full-access" ? "on" : "off";
    if (allowAll && collectSessionConfigOptionValues(allowAll).includes(allowAllValue)) {
      yield* input.runtime
        .setConfigOption(COPILOT_ALLOW_ALL_CONFIG_ID, allowAllValue)
        .pipe(Effect.mapError(mapError));
    }

    const modeState = yield* input.runtime.getModeState;
    const modeOption = findSessionConfigOption(configOptions, COPILOT_MODE_CONFIG_ID);
    const modeIds =
      modeState?.availableModes.map((mode) => mode.id) ??
      (modeOption ? collectSessionConfigOptionValues(modeOption) : []);
    const modeId = resolveCopilotModeId(modeIds, input.interactionMode);
    if (modeId !== undefined) {
      yield* input.runtime.setMode(modeId).pipe(Effect.asVoid, Effect.mapError(mapError));
    }
  });
}

/**
 * Rewrites Copilot sign-in and policy failures into an actionable message.
 * Returns undefined for every other failure so the original detail is kept.
 */
export function copilotActionableErrorDetail(message: string): string | undefined {
  const text = message.toLowerCase();
  if (
    /\bpolicy\b/.test(text) &&
    /(disabled|not enabled|not allowed|blocked|denied|restrict)/.test(text)
  ) {
    return "GitHub Copilot CLI is disabled for this account. Ask your org admin to enable the Copilot CLI policy.";
  }
  if (
    /(not logged in|not signed in|not authenticated|unauthenticated|unauthorized|authentication required|authentication failed|login required|no github token|copilot login|\b401\b)/.test(
      text,
    )
  ) {
    return "GitHub Copilot is not signed in. Run `copilot login`, then retry.";
  }
  return undefined;
}
