import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Wiring from "./StaveMemoryWiring.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const manifest =
  "version: 2\nid: demo\nmemories:\n  - name: notes\n    provider: marmot\n    id: den-secret\n";
const harness = <A, E>(
  body: (
    root: string,
    fs: FileSystem.FileSystem,
    wiring: Wiring.StaveMemoryWiring["Service"],
  ) => Effect.Effect<A, E, Path.Path>,
  enabled = true,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const wiring = yield* Wiring.make().pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(root, root),
          ServerSettings.layerTest({ stave: { enabled } }),
        ),
      ),
    );
    return yield* body(root, fs, wiring);
  }).pipe(Effect.provide(NodeServices.layer));

describe("StaveMemoryWiring", () => {
  it.effect("reads one generated entry without changing files or unrelated MCP entries", () =>
    harness((root, fs, wiring) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const config = {
          command: path.join(root, 'marmot "quoted" 雪'),
          args: ["serve", "--den", "den-secret"],
          env: { MARMOT_HOME: path.join(root, "private home") },
        };
        const document = yield* encodeJson({
          mcpServers: { unrelated: { url: "https://example.test" }, "context-marmot": config },
        });
        yield* fs.writeFileString(path.join(root, ".stave.yaml"), manifest);
        yield* fs.writeFileString(path.join(root, ".mcp.json"), document);
        const before = (yield* fs.readDirectory(root)).sort();
        expect(yield* wiring.resolve(root)).toEqual({ state: "configured", config });
        expect(yield* fs.readFileString(path.join(root, ".stave.yaml"))).toBe(manifest);
        expect(yield* fs.readFileString(path.join(root, ".mcp.json"))).toBe(document);
        expect((yield* fs.readDirectory(root)).sort()).toEqual(before);
      }),
    ),
  );
  it.effect("ignores non-Stave roots, ancestors, archived spaces, and detached memory", () =>
    harness((root, fs, wiring) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(yield* wiring.resolve(root)).toEqual({ state: "absent" });
        yield* fs.writeFileString(path.join(root, ".stave.yaml"), manifest);
        const nested = path.join(root, "nested");
        yield* fs.makeDirectory(nested);
        expect(yield* wiring.resolve(nested)).toEqual({ state: "absent" });
        const archived = path.join(root, ".archive", "demo");
        yield* fs.makeDirectory(archived, { recursive: true });
        yield* fs.writeFileString(path.join(archived, ".stave.yaml"), manifest);
        expect(yield* wiring.resolve(archived)).toEqual({ state: "absent" });
        yield* fs.writeFileString(path.join(root, ".stave.yaml"), "id: demo\nmemories: []\n");
        expect(yield* wiring.resolve(root)).toEqual({ state: "absent" });
      }),
    ),
  );
  it.effect("reports missing and malformed entries without exposing config in diagnostics", () =>
    harness((root, fs, wiring) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* fs.writeFileString(path.join(root, ".stave.yaml"), manifest);
        expect(yield* wiring.resolve(root)).toEqual({
          state: "unavailable",
          code: "missing_config",
        });
        for (const document of [
          "bad json",
          yield* encodeJson({
            mcpServers: { "context-marmot": { command: "relative", args: [] } },
          }),
          yield* encodeJson({
            mcpServers: { "context-marmot": { command: "/binary", args: [], env: { SECRET: 17 } } },
          }),
        ]) {
          yield* fs.writeFileString(path.join(root, ".mcp.json"), document);
          expect(yield* wiring.resolve(root)).toEqual({
            state: "unavailable",
            code: "invalid_config",
          });
        }
      }),
    ),
  );
  it.effect("disabled integration returns absent before reading a manifest", () =>
    harness(
      (root, fs, wiring) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(`${root}/.stave.yaml`, manifest);
          expect(yield* wiring.resolve(root)).toEqual({ state: "absent" });
        }),
      false,
    ),
  );
});
