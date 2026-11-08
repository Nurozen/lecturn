import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type { ServerInstallation } from "@lecturn/contracts";
import * as HostProcess from "@lecturn/shared/HostProcess";
import { isCommandAvailable } from "@lecturn/shared/shell";

import packageJson from "../../package.json" with { type: "json" };

/**
 * Lecturn has no public npm distribution yet, so every install stays unknown:
 * clients must not suggest an update that could download the upstream app or an
 * unrelated package with the same name.
 */
export const resolveServerInstallation: Effect.Effect<ServerInstallation | null> =
  Effect.succeed(null);

/**
 * The Node entry script of a build run from source, or the path of a standalone
 * executable, which has none. Lecturn ships no npm launcher, so upstream's
 * launcher path never applies here.
 */
export const resolveEntryPath = Effect.gen(function* () {
  if (yield* HostProcess.IsExecutable) return yield* HostProcess.ExecutablePath;
  return (yield* HostProcess.Arguments)[1] ?? "";
});

/**
 * Render a `lecturn <subcommand>` suggestion. Lecturn has no public npm
 * distribution yet, so every launch style suggests the plain binary; the entry
 * path and version are accepted only for call-site compatibility.
 */
export function formatCliCommand(input: {
  readonly subcommand: string;
  readonly entryPath: string;
  readonly version: string;
}): string {
  // Never suggest a command that could download the upstream app or an
  // unrelated package with the same name.
  return `lecturn ${input.subcommand}`;
}

export const resolveCliCommand = (subcommand: string) =>
  Effect.map(HostProcess.Arguments, (processArguments) =>
    formatCliCommand({
      subcommand,
      entryPath: processArguments[1] ?? "",
      version: packageJson.version,
    }),
  );

const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

/** PowerShell also treats typographic quotes as delimiters; escape them and suppress expansion. */
const powershellWord = (value: string) =>
  `"${value
    .replaceAll("`", "``")
    .replaceAll("$", "`$")
    .replace(/["\u201C\u201D\u201E]/g, "$&$&")}"`;

const hostShellWord = (platform: NodeJS.Platform, value: string) =>
  platform === "win32" ? powershellWord(value) : shellWord(value);

/** Script installs have no single launcher; desktop shims and standalone binaries do. */
const resolveInstallLauncher = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const shim = (yield* HostProcess.Environment).LECTURN_CLI_PATH?.trim();
  if (shim && (yield* fs.exists(shim).pipe(Effect.orElseSucceed(() => false)))) {
    return Option.some(shim);
  }
  return (yield* HostProcess.IsExecutable)
    ? Option.some(yield* HostProcess.ExecutablePath)
    : Option.none<string>();
});

/**
 * `lecturn <subcommand> <args>` for a person to run on this host: `lecturn`
 * when it is on PATH, or else the absolute path of the launcher for this
 * install, such as the one the desktop app installs. `args` are quoted for the
 * host's shell: POSIX, or PowerShell on Windows.
 */
export const resolveHostCliCommand = Effect.fn("invocation.resolveHostCliCommand")(function* (
  subcommand: string,
  args: ReadonlyArray<string> = [],
) {
  const platform = yield* HostProcess.Platform;
  const withArgs = (prefix: string) =>
    [prefix, ...args.map((arg) => hostShellWord(platform, arg))].join(" ");
  const command = yield* resolveCliCommand(subcommand);
  if (command !== `lecturn ${subcommand}`) return { command: withArgs(command), launcher: false };
  if (yield* isCommandAvailable("lecturn")) return { command: withArgs(command), launcher: false };
  const launcher = yield* resolveInstallLauncher;
  if (Option.isNone(launcher)) return { command: withArgs(command), launcher: false };
  // PowerShell runs a quoted path only through the call operator.
  const quoted = hostShellWord(platform, launcher.value);
  const call = platform === "win32" ? `& ${quoted}` : quoted;
  return { command: withArgs(`${call} ${subcommand}`), launcher: true };
});

/**
 * `sudo` resets PATH on most distributions, which drops a user-installed Node
 * (nvm, fnm, a tarball) and with it a global `lecturn`, so the command carries
 * PATH through unless Node is on root's PATH too. An absolute launcher needs
 * neither.
 */
export const resolveRootCliCommand = Effect.fn("invocation.resolveRootCliCommand")(function* (
  subcommand: string,
) {
  const { command, launcher } = yield* resolveHostCliCommand(subcommand);
  if (launcher) return `sudo ${command}`;
  const executablePath = yield* HostProcess.ExecutablePath;
  const systemNode = ROOT_PATH_DIRECTORIES.some((directory) =>
    executablePath.startsWith(`${directory}/`),
  );
  return systemNode ? `sudo ${command}` : `sudo env "PATH=$PATH" ${command}`;
});

const ROOT_PATH_DIRECTORIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];
