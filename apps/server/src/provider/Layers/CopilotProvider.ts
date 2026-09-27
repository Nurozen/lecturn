import * as NodeOS from "node:os";

import {
  type GithubCopilotSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@lecturn/contracts";
import { causeErrorTag } from "@lecturn/shared/observability";
import { createModelCapabilities } from "@lecturn/shared/model";
import { fromLenientJson } from "@lecturn/shared/schemaJson";
import { resolveSpawnCommand } from "@lecturn/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { COPILOT_AUTH_METHOD_ID, makeCopilotAcpRuntime } from "../acp/CopilotAcpSupport.ts";

export const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  conversationFork: "unsupported",
  externalSessions: "unsupported",
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
/**
 * The probe runs `--version`, then `help config` alongside the ACP auth handshake,
 * so its outer limit covers the version probe plus the slower of the other two.
 */
export const COPILOT_DETECTION_TIMEOUT_MS =
  VERSION_PROBE_TIMEOUT_MS + AUTH_PROBE_TIMEOUT_MS + 5_000;

/** ACP's `auth_required` code, which Copilot returns from `authenticate` without a usable login. */
const ACP_AUTH_REQUIRED_CODE = -32000;

/** `auto` lets Copilot pick the model per request; it is the default selection. */
const COPILOT_AUTO_MODEL_ENTRY: ServerProviderModel = {
  slug: "auto",
  name: "Auto",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_CAPABILITIES,
};

function copilotModels(
  customModels: ReadonlyArray<string> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [COPILOT_AUTO_MODEL_ENTRY, ...discovered.filter((model) => model.slug !== "auto")],
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

/**
 * Reads the model ids listed under the `model` key of `copilot help config`:
 *
 *       `model`: AI model to use for Copilot CLI; ...
 *         - "claude-sonnet-5"
 *         - "gpt-5-mini"
 *
 *       `contextTier`: ...
 */
export function parseCopilotHelpConfigModels(output: string): ReadonlyArray<ServerProviderModel> {
  const models: ServerProviderModel[] = [];
  const seen = new Set<string>();
  let inModelSection = false;
  for (const line of output.split(/\r?\n/)) {
    const key = line.match(/^\s*`([^`]+)`:/)?.[1];
    if (key !== undefined) {
      inModelSection = key === "model";
      continue;
    }
    if (!inModelSection) {
      continue;
    }
    const slug = line.match(/^\s+-\s+"([^"]+)"\s*$/)?.[1]?.trim();
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({ slug, name: slug, isCustom: false, capabilities: EMPTY_CAPABILITIES });
  }
  return models;
}

const CopilotConfigFile = fromLenientJson(
  Schema.Struct({
    lastLoggedInUser: Schema.optional(Schema.Struct({ login: Schema.optional(Schema.String) })),
  }),
);
const decodeCopilotConfigFile = Schema.decodeUnknownOption(CopilotConfigFile);

/** Login recorded in Copilot's `config.json` (JSON with `//` comments), if any. */
export function parseCopilotConfigLogin(raw: string): string | undefined {
  return (
    Option.getOrUndefined(decodeCopilotConfigFile(raw))?.lastLoggedInUser?.login?.trim() ||
    undefined
  );
}

/** Login recorded in `${COPILOT_HOME:-~/.copilot}/config.json`, used only as a label. */
const readCopilotConfigLogin = Effect.fn("readCopilotConfigLogin")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.COPILOT_HOME?.trim()
    ? environment.COPILOT_HOME.trim()
    : path.join(
        environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir(),
        ".copilot",
      );
  const raw = yield* fileSystem
    .readFileString(path.join(home, "config.json"))
    .pipe(Effect.orElseSucceed(() => ""));
  return parseCopilotConfigLogin(raw);
});

/**
 * Asks the CLI itself: `initialize` then `authenticate` in one short-lived `copilot --acp`
 * process that is closed right after. Neither request opens a session. Environment tokens
 * and `config.json` are not trusted on their own because Copilot falls back to its keychain
 * login. An `auth_required` answer is "unauthenticated"; any other failure or a timeout is
 * "unknown".
 */
export const resolveCopilotAuth = Effect.fn("resolveCopilotAuth")(function* (
  settings: GithubCopilotSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderAuth,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const handshake = yield* Effect.gen(function* () {
    const acp = yield* makeCopilotAcpRuntime({
      copilotSettings: settings,
      environment,
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "lecturn-provider-probe", version: "0.0.0" },
    });
    yield* acp.initialize();
    yield* acp.request("authenticate", { methodId: COPILOT_AUTH_METHOD_ID });
  }).pipe(Effect.scoped, Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.exit);

  if (Exit.isSuccess(handshake) && Option.isSome(handshake.value)) {
    const login = yield* readCopilotConfigLogin(environment);
    return login
      ? { status: "authenticated", type: "github", label: `GitHub @${login}` }
      : { status: "authenticated", type: "github" };
  }
  const error = Exit.isFailure(handshake) ? Cause.findErrorOption(handshake.cause) : Option.none();
  if (
    Option.isSome(error) &&
    error.value._tag === "AcpRequestError" &&
    error.value.code === ACP_AUTH_REQUIRED_CODE
  ) {
    return { status: "unauthenticated" };
  }
  yield* Effect.logWarning("GitHub Copilot ACP auth probe failed or timed out.", {
    errorTag: Exit.isFailure(handshake) ? causeErrorTag(handshake.cause) : "Timeout",
  });
  return { status: "unknown" };
});

export function buildInitialCopilotProviderSnapshot(
  settings: GithubCopilotSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: copilotModels(settings.customModels),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking GitHub Copilot CLI availability..."
          : "GitHub Copilot is disabled in Lecturn settings.",
      },
    });
  });
}

const runCopilotCliCommand = (
  settings: GithubCopilotSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "copilot";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  settings: GithubCopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = copilotModels(settings.customModels);
  const build = (
    probe: Parameters<typeof buildServerProvider>[0]["probe"],
    models = fallbackModels,
  ) =>
    buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe,
    });

  if (!settings.enabled) {
    return build({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "GitHub Copilot is disabled in Lecturn settings.",
    });
  }

  const versionResult = yield* runCopilotCliCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    yield* Effect.logWarning("GitHub Copilot CLI health check failed.", {
      errorTag: versionResult.failure._tag,
    });
    return build({
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
        : "Failed to execute GitHub Copilot CLI health check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return build({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "GitHub Copilot CLI is installed but timed out while running `copilot --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("GitHub Copilot CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return build({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "GitHub Copilot CLI is installed but failed to run.",
    });
  }

  // `help config` lists the models this CLI build accepts without starting the agent.
  const [helpResult, auth] = yield* Effect.all(
    [
      runCopilotCliCommand(settings, ["help", "config"], environment).pipe(
        Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
        Effect.result,
      ),
      resolveCopilotAuth(settings, environment),
    ],
    { concurrency: "unbounded" },
  );
  const helpOutput =
    Result.isSuccess(helpResult) &&
    Option.isSome(helpResult.success) &&
    helpResult.success.value.code === 0
      ? helpResult.success.value.stdout
      : undefined;
  if (helpOutput === undefined) {
    yield* Effect.logWarning("GitHub Copilot CLI model listing failed or timed out.", {
      errorTag: Result.isFailure(helpResult)
        ? helpResult.failure._tag
        : Option.isNone(helpResult.success)
          ? "Timeout"
          : `ExitCode${helpResult.success.value.code}`,
    });
  }
  const models = copilotModels(
    settings.customModels,
    helpOutput === undefined ? [] : parseCopilotHelpConfigModels(helpOutput),
  );

  if (auth.status === "unauthenticated") {
    return build(
      {
        installed: true,
        version,
        status: "error",
        auth,
        message: "GitHub Copilot is not signed in. Run `copilot login`, then retry.",
      },
      models,
    );
  }
  return build({ installed: true, version, status: "ready", auth }, models);
});

export const enrichCopilotSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("GitHub Copilot version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
