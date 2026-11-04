/**
 * Lecturn: the Grok launch a Squire home or probe runs in.
 *
 * `grok agent stdio` loads the user's `GROK_HOME` (config MCP servers, hooks,
 * skills, AGENTS.md, rules, memory) and, through `HOME`, Claude's, Cursor's,
 * and Codex's files. A marked thread therefore runs with its own empty
 * `GROK_HOME` and `HOME` per instance, holding only the config and agent
 * profile written here. The login is read in place through
 * `GROK_AUTH_PATH`: a copy would split a refresh-token rotation between two
 * files.
 *
 * The agent profile is the tool control. Its `tools` allowlist keeps only
 * Grok's always-on MCP meta-tools (`search_tool`, `use_tool`), which reach
 * the servers the session attached: Lecturn's alone on a home, none on a
 * probe. Grok falls back to every tool when no allowlist entry resolves
 * (checked on 1.0.70), so the profile also names each native tool in
 * `disallowedTools`. Checked live against grok 1.0.70.
 */
import { expandHomePath } from "@lecturn/provider-core/server/pathExpansion";
import type { ProviderInstanceId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Grok 1.0.70's native tools, removed even if the allowlist stops resolving. */
export const GROK_SQUIRE_DISALLOWED_TOOLS = [
  "run_terminal_command",
  "read_file",
  "search_replace",
  "write",
  "list_dir",
  "grep",
  "kill_command_or_subagent",
  "todo_write",
  "get_command_or_subagent_output",
  "wait_commands_or_subagents",
  "spawn_subagent",
  "scheduler_create",
  "scheduler_delete",
  "scheduler_list",
  "monitor",
  "workflow",
  "enter_plan_mode",
  "exit_plan_mode",
  "ask_user_question",
  "send_feedback",
  "web_search",
  "web_fetch",
  "image_gen",
  "image_edit",
  "image_to_video",
  "reference_to_video",
  "Agent",
] as const;

export const GROK_SQUIRE_AGENT_PROFILE = `---
name: lecturn-squire
description: A Lecturn Squire. It acts only through the Lecturn tools its session attaches.
tools: search_tool, use_tool
disallowedTools: ${GROK_SQUIRE_DISALLOWED_TOOLS.join(", ")}
agents_md: false
---
You are a Lecturn Squire. Your instructions arrive with each message.
`;

/**
 * Everything else a session could load. `HOME` is empty, so the compat
 * switches are a second fence; `ignore = ["/"]` hides bundled skills too.
 */
export const GROK_SQUIRE_CONFIG_TOML = `# Written by Lecturn for Squire threads; rewritten on every Squire launch.
disable_web_search = true

[cli]
auto_update = false
use_leader = false

[subagents]
enabled = false

[workflows]
enabled = false

[memory]
enabled = false

[memory_v2]
enabled = false

[managed_mcps]
enabled = false
gateway_tools_enabled = false

[skills]
ignore = ["/"]

[features]
write_file = false
web_fetch = false
backend_tools = false
lsp_tools = false
video_gen = false

[compat.claude]
agents = false
hooks = false
mcps = false
rules = false
skills = false

[compat.cursor]
agents = false
hooks = false
mcps = false
rules = false
skills = false

[compat.codex]
hooks = false
skills = false
`;

/** Organization policy Grok applies over any `GROK_HOME`, which a Squire cannot fence. */
const GROK_MANAGED_POLICY_PATHS = [
  "/etc/grok/requirements.toml",
  "/etc/grok/managed_config.toml",
  "/Library/Managed Preferences/ai.x.grok.plist",
] as const;

/** Read from the instance environment; a Squire launch must not inherit them. */
const STRIPPED_ENV = ["GROK_CONFIG", "GROK_CONFIG_PATH", "GROK_AGENT", "GROK_AUTH_PATH"] as const;

export class GrokSquireHomeError extends Schema.TaggedError<GrokSquireHomeError>()(
  "GrokSquireHomeError",
  {
    squireRootPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not prepare the Squire Grok home '${this.squireRootPath}': ${this.detail}`;
  }
}

export interface GrokSquireLaunch {
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
}

const grokSourceHomePath = (
  path: Path.Path,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): string => {
  const configured = environment.GROK_HOME?.trim();
  return path.resolve(
    configured ? expandHomePath(configured, homeDirectory) : path.join(homeDirectory, ".grok"),
  );
};

const grokSquireRootPath = (
  path: Path.Path,
  stateDir: string,
  instanceId: ProviderInstanceId,
): string => path.join(stateDir, "providers", "grok", instanceId, "squire");

// Exact versions, not a minimum: the profile denies the native tools this
// release has by name, so a later release may add one it does not cover.
export const GROK_SQUIRE_VERIFIED_VERSIONS: ReadonlyArray<string> = ["1.0.70"];
export const GROK_SQUIRE_UNVERIFIED_VERSION =
  "This Grok version hasn't been verified for Squires yet.";

export const makeGrokSquireHome = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly homeDirectory: string;
  readonly managedPolicyPaths?: ReadonlyArray<string>;
  /** The installed CLI's version, read on every check so an update is seen; null when unreadable. */
  readonly cliVersion: (environment: NodeJS.ProcessEnv) => Effect.Effect<string | null>;
}) => {
  const { fileSystem, path } = input;
  const squireRootPath = grokSquireRootPath(path, input.stateDir, input.instanceId);
  const grokHomePath = path.join(squireRootPath, "grok-home");
  const homePath = path.join(squireRootPath, "home");
  const profilePath = path.join(grokHomePath, "lecturn-squire.md");
  const fail = (detail: string) => (cause: unknown) =>
    new GrokSquireHomeError({ squireRootPath, detail, cause });
  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.mapError(fail(`could not look for '${target}'.`)));

  // Why a Squire cannot run on this launch, or null.
  const gap = (environment: NodeJS.ProcessEnv) =>
    Effect.gen(function* () {
      for (const policyPath of input.managedPolicyPaths ?? GROK_MANAGED_POLICY_PATHS) {
        if (yield* exists(policyPath)) {
          return `Grok runs under an organization policy on this computer (${policyPath}), so a Squire cannot keep its tools isolated.`;
        }
      }
      const version = yield* input.cliVersion(environment);
      if (version === null || !GROK_SQUIRE_VERIFIED_VERSIONS.includes(version)) {
        return GROK_SQUIRE_UNVERIFIED_VERSION;
      }
      if (environment.XAI_API_KEY?.trim()) return null;
      const authPath = path.join(
        grokSourceHomePath(path, environment, input.homeDirectory),
        "auth.json",
      );
      return (yield* exists(authPath))
        ? null
        : `A Squire uses the Grok sign-in saved in ${authPath}, and there is none. Run \`grok login\`, then try again.`;
    });

  return {
    squireRootPath,
    readiness: (environment: NodeJS.ProcessEnv) =>
      // An unreadable path surfaces on open, with its cause.
      gap(environment).pipe(Effect.catchTags({ GrokSquireHomeError: () => Effect.succeed(null) })),
    prepare: (environment: NodeJS.ProcessEnv) =>
      Effect.gen(function* () {
        const reason = yield* gap(environment);
        if (reason !== null) {
          return yield* new GrokSquireHomeError({ squireRootPath, detail: reason });
        }
        for (const directory of [grokHomePath, homePath]) {
          yield* fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(Effect.mapError(fail(`could not create '${directory}'.`)));
        }
        yield* fileSystem
          .writeFileString(path.join(grokHomePath, "config.toml"), GROK_SQUIRE_CONFIG_TOML)
          .pipe(Effect.mapError(fail("could not write config.toml.")));
        yield* fileSystem
          .writeFileString(profilePath, GROK_SQUIRE_AGENT_PROFILE)
          .pipe(Effect.mapError(fail("could not write the agent profile.")));
        const sourceAuthPath = path.join(
          grokSourceHomePath(path, environment, input.homeDirectory),
          "auth.json",
        );
        const hasSourceAuth = yield* exists(sourceAuthPath);
        const inherited = Object.fromEntries(
          Object.entries(environment).filter(
            ([name]) => !(STRIPPED_ENV as ReadonlyArray<string>).includes(name),
          ),
        );
        return {
          args: [
            "--permission-mode",
            "default",
            "agent",
            "--no-leader",
            "--agent-profile",
            profilePath,
            "stdio",
          ],
          environment: {
            ...inherited,
            GROK_HOME: grokHomePath,
            HOME: homePath,
            ...(hasSourceAuth ? { GROK_AUTH_PATH: sourceAuthPath } : {}),
          },
        } satisfies GrokSquireLaunch;
      }),
  };
};

export type GrokSquireHome = ReturnType<typeof makeGrokSquireHome>;
