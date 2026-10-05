import * as NodeCrypto from "node:crypto";
import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@lecturn/shared/shell";
import { privateTextGenerationError } from "./TextGenerationUtils.ts";

const ConfigSnapshot = Schema.Struct({
  config: Schema.Struct({
    mcp_servers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  layers: Schema.Array(
    Schema.Struct({
      name: Schema.Struct({
        type: Schema.String,
        file: Schema.optionalKey(Schema.String),
        dotCodexFolder: Schema.optionalKey(Schema.String),
      }),
      disabledReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

const decodeConfigSnapshot = Schema.decodeUnknownEffect(ConfigSnapshot);
const decodeMcpNames = Schema.decodeUnknownEffect(
  Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))),
);
const decodeModelCatalog = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      models: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const encodeCatalog = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Read configuration without creating a thread or asking MCP servers for auth status. */
export const prepareCodexInferenceIsolation = Effect.fn("prepareCodexInferenceIsolation")(
  function* (input: {
    binary: string;
    args: ReadonlyArray<string>;
    env: NodeJS.ProcessEnv;
    cwd: string;
    operation: string;
    model: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const snapshot = yield* Effect.gen(function* () {
      const spawn = yield* resolveSpawnCommand(input.binary, [...input.args, "app-server"], {
        env: input.env,
      });
      const child = yield* spawner.spawn(
        ChildProcess.make(spawn.command, spawn.args, {
          cwd: input.cwd,
          env: input.env,
          shell: spawn.shell,
        }),
      );
      return yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        const initialized = yield* client.request("initialize", {
          clientInfo: { name: "lecturn-inference-config", version: "1.0" },
          capabilities: { experimentalApi: true },
        });
        const raw = yield* client.raw.request("config/read", {
          cwd: input.cwd,
          includeLayers: true,
        });
        return {
          ...(yield* decodeConfigSnapshot(raw)),
          verifiedVersion: ["0.155.1", "0.156.1"].some((version) =>
            initialized.userAgent.startsWith(`lecturn-inference-config/${version} `),
          ),
        };
      }).pipe(Effect.provide(CodexClient.layerChildProcess(child)));
    }).pipe(
      Effect.scoped,
      Effect.timeout("15 seconds"),
      Effect.mapError(() =>
        privateTextGenerationError(
          input.operation,
          "Could not verify isolated Codex configuration.",
        ),
      ),
    );

    if (!snapshot.verifiedVersion) {
      return yield* privateTextGenerationError(
        input.operation,
        "Isolated background writing is verified for Codex 0.155.1 and 0.156.1. This installation requires verification.",
      );
    }

    const files: string[] = [];
    for (const layer of snapshot.layers) {
      if (layer.disabledReason || layer.name.type === "sessionFlags") continue;
      if (layer.name.file) files.push(layer.name.file);
      else if (layer.name.type === "project" && layer.name.dotCodexFolder) {
        files.push(`${layer.name.dotCodexFolder}/config.toml`);
      } else {
        return yield* privateTextGenerationError(
          input.operation,
          "This managed Codex configuration cannot be isolated for background writing.",
        );
      }
    }
    const fingerprint = Effect.forEach([...new Set(files)], (file) =>
      fs.readFile(file).pipe(
        Effect.map((bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex")),
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed("absent")
            : Effect.fail(
                privateTextGenerationError(
                  input.operation,
                  "Could not verify isolated Codex configuration.",
                ),
              ),
        ),
      ),
    );
    const before = yield* fingerprint;
    // ShellTool does not control ApplyPatch. Preserve the selected model's full
    // catalog metadata while removing its native tool declarations for this run.
    const catalogPath = yield* Effect.gen(function* () {
      const spawn = yield* resolveSpawnCommand(input.binary, [...input.args, "debug", "models"], {
        env: input.env,
      });
      const child = yield* spawner.spawn(
        ChildProcess.make(spawn.command, spawn.args, {
          cwd: input.cwd,
          env: input.env,
          shell: spawn.shell,
        }),
      );
      const [stdout, , code] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          ),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return yield* privateTextGenerationError(
          input.operation,
          "Could not verify Codex model tool capabilities.",
        );
      const catalog = yield* decodeModelCatalog(stdout);
      const model = catalog.models.find((model) => model.slug === input.model);
      if (!model)
        return yield* privateTextGenerationError(
          input.operation,
          "The selected Codex model has no verified tool capability metadata.",
        );
      const content = yield* encodeCatalog({
        models: [
          {
            ...model,
            shell_type: "disabled",
            apply_patch_tool_type: null,
            experimental_supported_tools: [],
            supports_search_tool: false,
            tool_mode: "direct",
          },
        ],
      });
      const file = yield* fs.makeTempFileScoped({
        prefix: "lecturn-inference-model-",
        suffix: ".json",
      });
      yield* fs.writeFileString(file, content);
      return file;
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError(() =>
        privateTextGenerationError(
          input.operation,
          "Could not verify Codex model tool capabilities.",
        ),
      ),
    );
    const verify = fingerprint.pipe(
      Effect.flatMap((after) =>
        after.every((hash, index) => hash === before[index])
          ? Effect.void
          : Effect.fail(
              privateTextGenerationError(
                input.operation,
                "Codex configuration changed during background writing. Retry the operation.",
              ),
            ),
      ),
    );
    const catalogOverride = yield* encodeCatalog(catalogPath).pipe(
      Effect.mapError(() =>
        privateTextGenerationError(
          input.operation,
          "Could not isolate Codex model tool capabilities.",
        ),
      ),
    );
    return {
      args: [
        ...(yield* decodeMcpNames(Object.keys(snapshot.config.mcp_servers ?? {})).pipe(
          Effect.mapError(() =>
            privateTextGenerationError(
              input.operation,
              "This Codex MCP server name cannot be isolated for background writing.",
            ),
          ),
        )).flatMap((name) => ["--config", `mcp_servers.${name}.enabled=false`]),
        "--config",
        `model_catalog_json=${catalogOverride}`,
      ],
      verify,
    };
  },
);
