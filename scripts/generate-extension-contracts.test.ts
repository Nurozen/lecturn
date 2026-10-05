import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import { RelayApi } from "../packages/contracts/src/relay.ts";
import { WsRpcGroup } from "../packages/contracts/src/rpc.ts";
import * as Contextual from "../packages/contracts/src/contextual.ts";
import { ContextualRpcs } from "../packages/contracts/src/contextualRpc.ts";
import * as Extensions from "../packages/contracts/src/extensions.ts";
import * as Helper from "../packages/contracts/src/extensionsHelper.ts";
import {
  contractConformanceFixtures,
  generateExtensionContractCatalog,
  generateExtensionContractCatalogCli,
  serializeCatalogJson,
  sha256,
} from "./generate-extension-contracts.ts";
const source = {
  sourceCommit: "a".repeat(40),
  sourceDirty: true,
  sourceFileDigests: { "synthetic.ts": "b".repeat(64) },
};
const artifacts = generateExtensionContractCatalog(source);
const manifestSchema = Schema.Struct({
  catalogVersion: Schema.Number,
  source: Schema.Struct({ sourceCommit: Schema.String, sourceDirty: Schema.Boolean }),
  checksums: Schema.Record(Schema.String, Schema.String),
});
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(manifestSchema));
const operationsSchema = Schema.Struct({
  rpc: Schema.Array(
    Schema.Struct({
      operation: Schema.String,
      scope: Schema.String,
      streaming: Schema.Boolean,
      successSchema: Schema.String,
      streamErrorSchema: Schema.optionalKey(Schema.String),
    }),
  ),
  declaredRpc: Schema.Array(Schema.Struct({ operation: Schema.String, mounted: Schema.Boolean })),
  helper: Schema.Array(Schema.Struct({ operation: Schema.String })),
  http: Schema.Struct({
    coverageGaps: Schema.Array(Schema.Struct({ area: Schema.String, status: Schema.String })),
  }),
});
const decodeOperations = Schema.decodeUnknownSync(Schema.fromJsonString(operationsSchema));
const modules: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  contextual: Contextual,
  extensions: Extensions,
  extensionsHelper: Helper,
};

describe("extension contract catalog", () => {
  it("generates byte-identical catalogs independently of metadata key insertion order", () => {
    expect(
      generateExtensionContractCatalog({
        sourceFileDigests: source.sourceFileDigests,
        sourceDirty: true,
        sourceCommit: source.sourceCommit,
      }),
    ).toEqual(artifacts);
    expect(serializeCatalogJson({ b: { d: 2, c: 1 }, a: [2, 1] })).toBe(
      serializeCatalogJson({ a: [2, 1], b: { c: 1, d: 2 } }),
    );
  });
  it("checksums every payload and separately authenticates the manifest", () => {
    const manifest = decodeManifest(artifacts["manifest.json"]);
    expect(manifest.catalogVersion).toBe(1);
    expect(manifest.source.sourceDirty).toBe(true);
    expect(manifest.source.sourceCommit).toBe(source.sourceCommit);
    expect(Object.keys(manifest.checksums).length).toBe(Object.keys(artifacts).length - 2);
    for (const [path, digest] of Object.entries(manifest.checksums)) {
      expect(sha256(artifacts[path]!)).toBe(digest);
      expect(sha256(`${artifacts[path]}changed`)).not.toBe(digest);
    }
    expect(artifacts["manifest.sha256"]).toBe(
      `${sha256(artifacts["manifest.json"]!)}  manifest.json\n`,
    );
    expect(() =>
      generateExtensionContractCatalog({ ...source, sourceCommit: "mutable-main" }),
    ).toThrow();
  });
  it("derives mounted OpenAPI and complete RPC inventory including stream schemas and scopes", () => {
    expect(artifacts["http/openapi.json"]).toBe(serializeCatalogJson(OpenApi.fromApi(RelayApi)));
    const operations = decodeOperations(artifacts["operations.json"]);
    expect(operations.rpc.map((rpc) => rpc.operation).sort()).toEqual(
      [...WsRpcGroup.requests.keys()].sort(),
    );
    expect(operations.rpc.every((rpc) => rpc.scope.length > 0)).toBe(true);
    for (const rpc of operations.rpc.filter((operation) => operation.streaming)) {
      expect(rpc.streamErrorSchema).toBeDefined();
      expect(artifacts[rpc.streamErrorSchema!]).toBeDefined();
      expect(artifacts[rpc.successSchema]).toContain('"$schema"');
    }
    expect(operations.declaredRpc.map((rpc) => rpc.operation).sort()).toEqual(
      ContextualRpcs.filter((rpc) => !WsRpcGroup.requests.has(rpc._tag))
        .map((rpc) => rpc._tag)
        .sort(),
    );
    expect(operations.declaredRpc.every((rpc) => rpc.mounted === false)).toBe(true);
    expect(
      artifacts["schemas/extensionsEvaluator/ExtensionEvaluatorRequest.schema.json"],
    ).toBeDefined();
    expect(operations.helper).toHaveLength(10);
    expect(operations.http.coverageGaps.map((gap) => gap.area).sort()).toEqual([
      "billing",
      "extensions",
      "legacy-decisions",
      "teams",
    ]);
    expect(
      operations.http.coverageGaps.every((gap) => gap.status === "not-coverage-certified"),
    ).toBe(true);
  });
  it("ships executable native conformance cases for omitted runtime semantics", () => {
    const examples = contractConformanceFixtures();
    expect(examples.some((example) => !example.valid)).toBe(true);
    for (const example of examples) {
      const schema = modules[example.module]![example.schema];
      expect(Schema.isSchema(schema)).toBe(true);
      if (Schema.isSchema(schema)) expect(Schema.is(schema)(example.value)).toBe(example.valid);
    }
    expect(artifacts["runtime-constraints.json"]).toContain("makeFilter");
    expect(artifacts["runtime-constraints.json"]).toContain(
      "packages/contracts/src/contextual.test.ts",
    );
    expect(artifacts["conformance.json"]).toContain("utf16-not-byte-coordinates");
  });
  it("requires an explicit output directory before touching the filesystem", async () => {
    await expect(generateExtensionContractCatalogCli([])).rejects.toThrow("--out-dir");
    await expect(generateExtensionContractCatalogCli(["--out-dir", ""])).rejects.toThrow(
      "--out-dir",
    );
  });
});
