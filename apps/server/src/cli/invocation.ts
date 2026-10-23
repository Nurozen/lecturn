import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type { ServerInstallation } from "@lecturn/contracts";
import * as HostProcess from "@lecturn/shared/HostProcess";
import { isCommandAvailable } from "@lecturn/shared/shell";

import packageJson from "../../package.json" with { type: "json" };

/**
 * Upstream proves npm-global and package-runner (`npx`, `pnpm dlx`, `bunx`)
 * ownership so clients can suggest a manual update command. Lecturn has no
 * public npm distribution yet, so every install stays unknown: clients must not
 * suggest an update that could download the upstream app or an unrelated
 * package with the same name.
 */
export const resolveServerInstallation: Effect.Effect<ServerInstallation | null> =
  Effect.succeed(null);

/**
 * Render a `lecturn <subcommand>` suggestion. Upstream derives a package
 * runner (`npx`, `pnpm dlx`, `bunx`) and channel tag from the entry path and
 * version so copy/pasting matches the launching command. Lecturn has no public
 * npm distribution yet, so every launch style suggests the plain binary and the
 * entry path and version are accepted only for call-site compatibility.
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

/** `formatCliCommand` against this process's real entry path and version. */
export const resolveCliCommand = (subcommand: string) =>
  Effect.map(HostProcess.Arguments, (processArguments) =>
    formatCliCommand({
      subcommand,
      entryPath: processArguments[1] ?? "",
      version: packageJson.version,
    }),
  );

/** Quotes `value` for a POSIX shell when it needs it. */
const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * Quotes `value` for PowerShell, the default Windows terminal. Always quoted,
 * so a path reads the same whether or not it holds a space. Inside double
 * quotes `"` and its typographic forms (which also end the string) double,
 * and `$` and the backtick are escaped so nothing expands.
 */
const powershellWord = (value: string) =>
  `"${value
    .replaceAll("`", "``")
    .replaceAll("$", "`$")
    .replace(/["\u201C\u201D\u201E]/g, "$&$&")}"`;

/** Quotes a word for the host's shell: POSIX, or PowerShell on Windows. */
const hostShellWord = (platform: NodeJS.Platform, value: string) =>
  platform === "win32" ? powershellWord(value) : shellWord(value);

/**
 * The launcher a person can type to run this install when `lecturn` is not on
 * PATH: the desktop app's `lecturn` shim, which the app and the shim itself
 * name in `LECTURN_CLI_PATH`, or a standalone binary's own path. Script
 * installs (a repo checkout) have no single launcher and keep plain `lecturn`.
 */
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
export const resolveHostCliCommand = (subcommand: string, args: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const withArgs = (prefix: string) =>
      [prefix, ...args.map((arg) => hostShellWord(platform, arg))].join(" ");
    const command = yield* resolveCliCommand(subcommand);
    if (command !== `lecturn ${subcommand}`) return { command: withArgs(command), launcher: false };
    if (yield* isCommandAvailable("lecturn"))
      return { command: withArgs(command), launcher: false };
    const launcher = yield* resolveInstallLauncher;
    if (Option.isNone(launcher)) return { command: withArgs(command), launcher: false };
    // PowerShell runs a quoted path only through the call operator.
    const quoted = hostShellWord(platform, launcher.value);
    const call = platform === "win32" ? `& ${quoted}` : quoted;
    return { command: withArgs(`${call} ${subcommand}`), launcher: true };
  });

/**
 * `lecturn <subcommand>` as root, for setup a person runs once on the host. `sudo`
 * resets PATH on most distributions, which drops a user-installed Node (nvm,
 * fnm, a tarball) and with it a global `lecturn`, so the command carries
 * PATH through unless Node is on root's PATH too. An absolute launcher needs
 * neither.
 */
export const resolveRootCliCommand = (subcommand: string) =>
  Effect.gen(function* () {
    const { command, launcher } = yield* resolveHostCliCommand(subcommand);
    if (launcher) return `sudo ${command}`;
    const executablePath = yield* HostProcess.ExecutablePath;
    const systemNode = ROOT_PATH_DIRECTORIES.some((directory) =>
      executablePath.startsWith(`${directory}/`),
    );
    return systemNode ? `sudo ${command}` : `sudo env "PATH=$PATH" ${command}`;
  });

/** Debian and Ubuntu's sudo `secure_path`, minus snap. */
const ROOT_PATH_DIRECTORIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];
