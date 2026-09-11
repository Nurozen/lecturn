/** Reads only the exact space root generated MCP entry; never writes provider configuration. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { readManifest, mapManifestToProjectInfo } from "./StaveWorkspaceReader.ts";

const McpConfig = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1)),
  args: Schema.Array(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const McpDocument = Schema.Struct({
  mcpServers: Schema.Struct({ "context-marmot": McpConfig }),
});
const decodeMcpDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(McpDocument));
export type StaveMemoryConfig = typeof McpConfig.Type;
export type StaveMemoryResolution =
  | { readonly state: "absent" }
  | { readonly state: "configured"; readonly config: StaveMemoryConfig }
  | { readonly state: "unavailable"; readonly code: "missing_config" | "invalid_config" };
export class StaveMemoryWiring extends Context.Service<
  StaveMemoryWiring,
  {
    readonly resolve: (cwd: string) => Effect.Effect<StaveMemoryResolution>;
  }
>()("lecturn/stave/StaveMemoryWiring") {}

export const make = Effect.fn("StaveMemoryWiring.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettingsService;
  const config = yield* ServerConfig;
  const resolve = Effect.fn("StaveMemoryWiring.resolve")(function* (
    cwd: string,
  ): Effect.fn.Return<StaveMemoryResolution> {
    if (!config.staveEnabled) return { state: "absent" };
    const enabled = yield* settings.getSettings.pipe(
      Effect.map((value) => value.stave.enabled),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) return { state: "absent" };
    const manifest = yield* readManifest(cwd).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    if (Option.isNone(manifest)) return { state: "absent" };
    const info = mapManifestToProjectInfo({
      manifest: manifest.value,
      location: {
        workspaceRoot: cwd,
        parentBasename: path.basename(path.dirname(cwd)),
        basename: path.basename(cwd),
      },
      resolveRepoPath: (repo) => path.resolve(cwd, repo),
    });
    if (
      info === null ||
      info.state !== "live" ||
      !info.memories.some((memory) => memory.provider === "marmot")
    )
      return { state: "absent" };
    const raw = yield* fs.readFileString(path.join(cwd, ".mcp.json")).pipe(Effect.option);
    if (Option.isNone(raw)) return { state: "unavailable", code: "missing_config" };
    const decoded = yield* decodeMcpDocument(raw.value).pipe(Effect.option);
    if (Option.isNone(decoded)) return { state: "unavailable", code: "invalid_config" };
    const entry = decoded.value.mcpServers["context-marmot"];
    if (!path.isAbsolute(entry.command) || entry.command.includes("\0"))
      return { state: "unavailable", code: "invalid_config" };
    return { state: "configured", config: entry };
  });
  return StaveMemoryWiring.of({ resolve });
});
export const layer = Layer.effect(StaveMemoryWiring, make());
export const noop = StaveMemoryWiring.of({ resolve: () => Effect.succeed({ state: "absent" }) });
export const layerNoop = Layer.succeed(StaveMemoryWiring, noop);
