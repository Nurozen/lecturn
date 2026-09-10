import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expandHomePath } from "../../pathExpansion.ts";
import type { ProcessRunner } from "../../processRunner.ts";
import { codexExecLaunchArgs } from "./codexLaunchArgs.ts";

interface CodexLaunchContext {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly launchArgs?: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly appServerArgs?: ReadonlyArray<string>;
}

/** Shared by the native session and its read-only MCP configuration inventory. */
export const codexSpawnEnvironment = (
  options: Pick<CodexLaunchContext, "homePath" | "environment">,
) => {
  const home = options.homePath ? expandHomePath(options.homePath) : undefined;
  return {
    env: { ...options.environment, ...(home ? { CODEX_HOME: home } : {}) },
    extendEnv: options.environment === undefined,
  };
};

const Inventory = Schema.Array(Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1)) }));
const decodeInventory = Schema.decodeUnknownEffect(Schema.fromJsonString(Inventory));

export class CodexMcpInventoryError extends Schema.TaggedErrorClass<CodexMcpInventoryError>()(
  "CodexMcpInventoryError",
  { reason: Schema.Literals(["process", "timeout", "output", "invalid_response"]) },
) {
  override get message(): string {
    return `Cannot safely configure Stave memory: Codex MCP inventory failed (${this.reason}). Check the Codex binary, launch arguments and home settings; the configured CLI must support 'mcp list --json'.`;
  }
}

/** Uses Codex's own config layering; never logs or retains the returned environment values. */
export const hasCanonicalMarmotServer = Effect.fn("hasCanonicalMarmotServer")(function* (
  options: CodexLaunchContext,
  runner: ProcessRunner["Service"],
) {
  const output = yield* runner
    .run({
      command: options.binaryPath,
      args: [
        ...codexExecLaunchArgs(options.launchArgs),
        ...(options.appServerArgs ?? []),
        "mcp",
        "list",
        "--json",
      ],
      cwd: options.cwd,
      ...codexSpawnEnvironment(options),
      stdin: "",
      timeout: "10 seconds",
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 1024 * 1024,
    })
    .pipe(Effect.mapError(() => new CodexMcpInventoryError({ reason: "process" })));
  if (output.timedOut) return yield* new CodexMcpInventoryError({ reason: "timeout" });
  if (output.code !== 0 || output.stdoutTruncated || output.stdoutInvalidUtf8)
    return yield* new CodexMcpInventoryError({ reason: "output" });
  const inventory = yield* decodeInventory(output.stdout).pipe(
    Effect.mapError(() => new CodexMcpInventoryError({ reason: "invalid_response" })),
  );
  return inventory.some((server) => server.name === "context-marmot");
});
