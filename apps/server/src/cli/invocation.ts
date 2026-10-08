import * as Effect from "effect/Effect";

import { HostProcessArguments } from "@lecturn/shared/hostProcess";

import packageJson from "../../package.json" with { type: "json" };

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
