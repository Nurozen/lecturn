import * as Effect from "effect/Effect";

import type { ServerInstallation } from "@lecturn/contracts";
import { HostProcessArguments, HostProcessExecutablePath } from "@lecturn/shared/hostProcess";

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

/**
 * `lecturn <subcommand>` as root, for setup a person runs once on the host. `sudo`
 * resets PATH on most distributions, which drops a user-installed Node (nvm,
 * fnm, a tarball) and with it a global `lecturn`, so the command carries
 * PATH through unless Node is on root's PATH too.
 */
export const resolveRootCliCommand = (subcommand: string) =>
  Effect.gen(function* () {
    const command = yield* resolveCliCommand(subcommand);
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
