import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type { ServerInstallation } from "@lecturn/contracts";
import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
} from "@lecturn/shared/hostProcess";
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
  Effect.map(HostProcessArguments, (processArguments) =>
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
 * The launcher a person can type to run this install when `lecturn` is not on
 * PATH: the desktop app's `lecturn` shim, which the app and the shim itself
 * name in `LECTURN_CLI_PATH`, or a standalone binary's own path. Script
 * installs (a repo checkout) have no single launcher and keep plain `lecturn`.
 */
const resolveInstallLauncher = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const shim = (yield* HostProcessEnvironment).LECTURN_CLI_PATH?.trim();
  if (shim && (yield* fs.exists(shim).pipe(Effect.orElseSucceed(() => false)))) {
    return Option.some(shim);
  }
  return (yield* HostProcessIsExecutable)
    ? Option.some(yield* HostProcessExecutablePath)
    : Option.none<string>();
});

/**
 * `lecturn <subcommand>` for a person to run on this host: `lecturn` when it is
 * on PATH, or else the absolute path of the launcher for this install, such as
 * the one the desktop app installs.
 */
const resolveHostCliCommand = (subcommand: string) =>
  Effect.gen(function* () {
    const command = yield* resolveCliCommand(subcommand);
    if (command !== `lecturn ${subcommand}`) return { command, launcher: false };
    if (yield* isCommandAvailable("lecturn")) return { command, launcher: false };
    const launcher = yield* resolveInstallLauncher;
    return Option.isSome(launcher)
      ? { command: `${shellWord(launcher.value)} ${subcommand}`, launcher: true }
      : { command, launcher: false };
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
    const executablePath = yield* HostProcessExecutablePath;
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
