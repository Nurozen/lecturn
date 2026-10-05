#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone catalog publication CLI records Git source identity and writes generated artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";
import * as ContextualRpc from "../packages/contracts/src/contextualRpc.ts";
import * as ThreadDecisions from "../packages/contracts/src/threadDecisions.ts";
import * as Provider from "../packages/contracts/src/provider.ts";
import * as Contextual from "../packages/contracts/src/contextual.ts";
import * as Extensions from "../packages/contracts/src/extensions.ts";
import * as Evaluator from "../packages/contracts/src/extensionsEvaluator.ts";
import * as Helper from "../packages/contracts/src/extensionsHelper.ts";
import * as LegacyDecisions from "../packages/contracts/src/relayDecisions.ts";
import { RelayApi } from "../packages/contracts/src/relay.ts";
import { WsRpcGroup } from "../packages/contracts/src/rpc.ts";
import { requiredScopeForRpcMethod } from "../apps/server/src/auth/RpcAuthorization.ts";

export const CATALOG_VERSION = 1;
export const CONTRACT_SOURCE_FILES = [
  "packages/contracts/src/extensionsEvaluator.ts",
  "packages/contracts/src/contextualRpc.ts",
  "packages/contracts/src/threadDecisions.ts",
  "packages/contracts/src/provider.ts",
  "packages/contracts/src/environment.ts",
  "packages/contracts/src/orchestration.ts",
  "packages/contracts/src/contextual.ts",
  "packages/contracts/src/extensions.ts",
  "packages/contracts/src/extensionsHelper.ts",
  "packages/contracts/src/relayDecisions.ts",
  "packages/contracts/src/relay.ts",
  "packages/contracts/src/rpc.ts",
  "apps/server/src/auth/RpcAuthorization.ts",
  "scripts/generate-extension-contracts.ts",
] as const;
const MODULES = {
  contextualRpc: ContextualRpc,
  threadDecisions: ThreadDecisions,
  provider: Provider,
  contextual: Contextual,
  extensions: Extensions,
  extensionsEvaluator: Evaluator,
  extensionsHelper: Helper,
  relayDecisions: LegacyDecisions,
};
const metadataSchema = Schema.Struct({
  sourceCommit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  sourceDirty: Schema.Boolean,
  sourceFileDigests: Schema.Record(
    Schema.String,
    Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  ),
});
const decodeMetadata = Schema.decodeUnknownSync(metadataSchema);
export type CatalogSource = typeof metadataSchema.Type;

export function sha256(content: string): string {
  return NodeCrypto.createHash("sha256").update(content).digest("hex");
}
/** Stable object-key ordering, without timestamps or machine-specific absolute paths. */
export function serializeCatalogJson(value: unknown): string {
  return `${JSON.stringify(value, (_, item: unknown) => (Predicate.isObject(item) && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item), 2)}\n`;
}
function schemaDocument(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    $defs: document.definitions,
  };
}
const RUNTIME_CONSTRAINTS = [
  {
    id: "exact-evidence",
    schemas: ["ContextualEvidence", "ContextualLiveEvidence", "DecisionEvidence"],
    rule: "Quotes use half-open JavaScript UTF-16 offsets; end-start must equal quote.length. Native byte offsets must be converted. Validate hashes and exact original text against authorized source revisions.",
  },
  {
    id: "identity",
    schemas: [
      "ContextualEvaluationRequest",
      "ContextualRetrieveResult",
      "ContextualPacket",
      "ContextualConflict",
    ],
    rule: "Reject duplicate candidate, target, evidence and semantic-guidance identities where the Effect schema requires uniqueness; conflict span IDs must exist on the correct claim side.",
  },
  {
    id: "request-budget",
    schemas: [
      "ContextualEvaluationRequest",
      "ContextualConflictCheckRequest",
      "ContextualEquivalenceCheckRequest",
    ],
    rule: "At most 8 targets/pairs per request and 48000 serialized UTF-16 request characters, including task context; funding generation equals the task fence. Run accounting additionally enforces 6 attempts and 12 pairs across requests.",
  },
  {
    id: "delivery",
    schemas: ["ContextualDeliveryReceipt", "ContextualPacket", "ContextualPreparation"],
    rule: "Actual request evidence inclusion is distinct from acceptance. Unknown acceptance may retain inclusion with no supplied IDs; supply requires acceptance plus native turn/receipt identities. Steered/skipped dispatch cannot include automatic evidence. Packet at most 2 groups and 1500 measured/conservatively bounded tokens.",
  },
  {
    id: "revision-fences",
    schemas: [
      "ContextualSourceConfiguration",
      "ContextualTaskSnapshot",
      "ContextualConflictResolution",
    ],
    rule: "Policy updates require expectedRevision+1. Consumers transactionally compare current settings, source scope, exclusion, purge, funding, participant and context revisions against request fences. No timeout resolves a human conflict choice.",
  },
  {
    id: "shared-allowance",
    schemas: ["ExtensionAllowance"],
    rule: "Feature-attributed used and reserved totals equal shared pool totals; remaining allowance is reconciled against limit and usage. Consent remains feature-specific.",
  },
  {
    id: "helper-frame",
    schemas: ["ExtensionsHelperRequest", "ExtensionsHelperResponse"],
    rule: "Protocol major 1 only; maximum 1048576 UTF-8 bytes per NDJSON line. Reject oversize frames before parsing; schema checks decoded serialization as defense in depth. Progress totals, operation/result pairing and export artifact lifecycle are validated.",
  },
  {
    id: "equivalence",
    schemas: ["ContextualEquivalenceCheckRequest", "ContextualDecisionGroup"],
    rule: "Distinct Decision IDs and matching environment/project are required. Grouping preserves occurrence attribution, evidence, review state, comments and edits; services additionally compare expected revisions and reject incompatible membership.",
  },
] as const;
const HELPER_DESCRIPTIONS: Record<
  Helper.ExtensionsHelperOperation,
  { description: string; authority: string }
> = {
  "extensions.describe": {
    description:
      "Installed protocol, platform, format and limit capabilities; no paid eligibility.",
    authority: "host-internal",
  },
  "contextual.sources.list": {
    description: "Paginated discovery and configured source policy.",
    authority: "host-admin",
  },
  "contextual.sources.configure": {
    description: "Explicit source policy update with expected revision.",
    authority: "host-admin",
  },
  "contextual.capture.setState": {
    description: "Start/pause receipt-backed local collection.",
    authority: "host-admin",
  },
  "contextual.capture.status": {
    description: "Collection health and source/purge generation.",
    authority: "host-admin",
  },
  "contextual.retrieve": {
    description: "Bounded authorized candidates for submitted task fences.",
    authority: "host-internal",
  },
  "contextual.evidence.read": {
    description:
      "Read an exact permitted evidence revision; attached evidence requires thread read access, raw archive requires admin.",
    authority: "host-internal; host enforces attached-thread-read or archive-admin",
  },
  "contextual.data.export": {
    description:
      "Export selected data into supervisor-configured owner-only artifact storage; return opaque artifact ID.",
    authority: "host-admin",
  },
  "contextual.data.forget": {
    description: "Purge selected data and suppress recapture with generation checks.",
    authority: "host-admin",
  },
  "operation.cancel": {
    description: "Cancel one owned request/job without stopping other modules.",
    authority: "same authority as target operation",
  },
};

export function contractConformanceFixtures() {
  const allowance = {
    poolId: "shared",
    basis: "subscription",
    windowStart: "2026-09-01T00:00:00.000Z",
    windowEnd: "2026-10-01T00:00:00.000Z",
    limitInputTokens: 100,
    usedInputTokens: 20,
    reservedInputTokens: 10,
    remainingInputTokens: 70,
    byFeature: [
      { featureId: "decisions", usedInputTokens: 20, reservedInputTokens: 0 },
      { featureId: "contextual", usedInputTokens: 0, reservedInputTokens: 10 },
    ],
  };
  const request = {
    protocolVersion: 1,
    id: "synthetic-request",
    deadlineAt: "2026-09-25T00:00:00.000Z",
    operation: "extensions.describe",
    payload: {},
  };
  const evidence = {
    id: "synthetic-evidence",
    sourceKind: "thread-message",
    threadId: "synthetic-thread",
    messageId: "synthetic-message",
    messageRole: "user",
    sourceHash: "synthetic-hash",
    sourceRevision: 1,
    quote: "Use 🚀",
    start: 0,
    end: 6,
    coordinateSystem: "utf16",
  };
  return [
    {
      id: "helper-describe-valid",
      module: "extensionsHelper",
      schema: "ExtensionsHelperRequest",
      valid: true,
      value: request,
    },
    {
      id: "helper-stale-version",
      module: "extensionsHelper",
      schema: "ExtensionsHelperRequest",
      valid: false,
      value: { ...request, protocolVersion: 0 },
    },
    {
      id: "helper-no-executable",
      module: "extensionsHelper",
      schema: "ExtensionsHelperRequest",
      valid: false,
      value: { ...request, payload: { executablePath: "/synthetic/not-executed" } },
    },
    {
      id: "utf16-surrogate-pair",
      module: "contextual",
      schema: "ContextualLiveEvidence",
      valid: true,
      value: evidence,
    },
    {
      id: "utf16-not-byte-coordinates",
      module: "contextual",
      schema: "ContextualLiveEvidence",
      valid: false,
      value: { ...evidence, end: 8 },
    },
    {
      id: "shared-allowance-valid",
      module: "extensions",
      schema: "ExtensionAllowance",
      valid: true,
      value: allowance,
    },
    {
      id: "shared-allowance-wrong-feature-total",
      module: "extensions",
      schema: "ExtensionAllowance",
      valid: false,
      value: { ...allowance, byFeature: [] },
    },
  ];
}

/** Pure catalog generation. Callers provide source identity; this function performs no I/O. */
export function generateExtensionContractCatalog(
  sourceInput: CatalogSource,
): Readonly<Record<string, string>> {
  const source = decodeMetadata(sourceInput);
  const files: Record<string, string> = {};
  const inventory: Array<{ module: string; name: string; file: string }> = [];
  for (const [module, exports] of Object.entries(MODULES)) {
    for (const [name, exported] of Object.entries(exports)) {
      if (!Schema.isSchema(exported)) continue;
      const file = `schemas/${module}/${name}.schema.json`;
      files[file] = serializeCatalogJson(schemaDocument(exported));
      inventory.push({ module, name, file });
    }
  }
  const mountedRpcNames = new Set(WsRpcGroup.requests.keys());
  const declaredRpcs = ContextualRpc.ContextualRpcs.filter((rpc) => !mountedRpcNames.has(rpc._tag));
  const rpcOperations = [...WsRpcGroup.requests.values(), ...declaredRpcs]
    .map((rpc) => {
      const prefix = `schemas/rpc/${encodeURIComponent(rpc._tag)}`;
      const streamed = RpcSchema.isStreamSchema(rpc.successSchema);
      files[`${prefix}.payload.schema.json`] = serializeCatalogJson(
        schemaDocument(rpc.payloadSchema),
      );
      files[`${prefix}.success.schema.json`] = serializeCatalogJson(
        schemaDocument(streamed ? rpc.successSchema.success : rpc.successSchema),
      );
      files[`${prefix}.error.schema.json`] = serializeCatalogJson(schemaDocument(rpc.errorSchema));
      if (streamed)
        files[`${prefix}.stream-error.schema.json`] = serializeCatalogJson(
          schemaDocument(rpc.successSchema.error),
        );
      return {
        operation: rpc._tag,
        scope: mountedRpcNames.has(rpc._tag)
          ? requiredScopeForRpcMethod(rpc._tag)
          : ContextualRpc.CONTEXTUAL_RPC_SCOPES[
              rpc._tag as keyof typeof ContextualRpc.CONTEXTUAL_RPC_SCOPES
            ],
        mounted: mountedRpcNames.has(rpc._tag),
        streaming: streamed,
        payloadSchema: `${prefix}.payload.schema.json`,
        successSchema: `${prefix}.success.schema.json`,
        errorSchema: `${prefix}.error.schema.json`,
        ...(streamed ? { streamErrorSchema: `${prefix}.stream-error.schema.json` } : {}),
      };
    })
    .sort((a, b) => (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0));
  const openapi = OpenApi.fromApi(RelayApi);
  files["http/openapi.json"] = serializeCatalogJson(openapi);
  const gapPrefixes = {
    billing: "/v1/billing",
    teams: "/v1/teams",
    "legacy-decisions": "/v1/decisions",
    extensions: "/v1/extensions",
  };
  const gaps = Object.entries(gapPrefixes).map(([area, prefix]) => ({
    area,
    prefix,
    status: "not-coverage-certified",
    typedPaths: Object.keys(openapi.paths)
      .filter((path) => path.startsWith(prefix))
      .sort(),
    reason:
      "Typed paths are exported where available. This generated manifest does not certify exhaustive mounted-handler coverage; consult the corresponding route tests.",
  }));
  files["operations.json"] = serializeCatalogJson({
    helper: Object.entries(HELPER_DESCRIPTIONS).map(([operation, metadata]) => ({
      operation,
      ...metadata,
    })),
    rpc: rpcOperations.filter((rpc) => rpc.mounted),
    declaredRpc: rpcOperations.filter((rpc) => !rpc.mounted),
    http: { source: "RelayApi", openapi: "http/openapi.json", coverageGaps: gaps },
  });
  files["runtime-constraints.json"] = serializeCatalogJson({
    warning:
      "JSON Schema is structural only. Effect makeFilter predicates and stateful authorization/generation checks are not preserved. Native consumers must execute equivalent runtime checks and conformance fixtures.",
    constraints: RUNTIME_CONSTRAINTS,
    implementationFixtures: [
      "packages/contracts/src/contextual.test.ts",
      "packages/contracts/src/extensions.test.ts",
      "packages/contracts/src/extensionsHelper.test.ts",
      "packages/contracts/src/threadDecisions.test.ts",
    ],
  });
  const examples = contractConformanceFixtures();
  for (const example of examples) {
    const schema = inventory.find(
      (item) => item.module === example.module && item.name === example.schema,
    );
    if (schema === undefined)
      throw new Error(`Unknown conformance schema ${example.module}/${example.schema}`);
    const moduleExports: Readonly<Record<string, unknown>> =
      MODULES[example.module as keyof typeof MODULES];
    const definition = moduleExports[example.schema];
    if (!Schema.isSchema(definition) || Schema.is(definition)(example.value) !== example.valid)
      throw new Error(`Conformance fixture drift: ${example.id}`);
  }
  files["conformance.json"] = serializeCatalogJson({
    instructions:
      "Run fixtures against full native/runtime validators, not only generated JSON Schema; valid=false cases include cross-field constraints.",
    examples,
  });
  files["schemas/index.json"] = serializeCatalogJson(
    inventory.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
  );
  const manifest = {
    catalogVersion: CATALOG_VERSION,
    contractVersion: "1",
    source,
    compatibility: {
      helperProtocolMajor: Helper.EXTENSIONS_HELPER_PROTOCOL_VERSION,
      contextualPolicy: "contextual-v1",
      equivalencePolicy: "decisions-equivalence-v1",
      host: "Requires the exact source schema digests in this manifest; no wider host-version compatibility has been certified.",
    },
    checksumAlgorithm: "sha256",
    checksums: Object.fromEntries(
      Object.entries(files)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([file, content]) => [file, sha256(content)]),
    ),
    manifestChecksum: "manifest.sha256 (external sidecar; manifest does not checksum itself)",
    publicationStatus: "local-staging-only",
    scope: "Public contracts only; no private evaluator prompts, source data or credentials.",
  };
  files["manifest.json"] = serializeCatalogJson(manifest);
  files["manifest.sha256"] = `${sha256(files["manifest.json"])}  manifest.json\n`;
  return files;
}

export async function generateExtensionContractCatalogCli(
  args: ReadonlyArray<string>,
): Promise<void> {
  if (args.length !== 2 || args[0] !== "--out-dir" || !args[1])
    throw new Error("Usage: node scripts/generate-extension-contracts.ts --out-dir <directory>");
  const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const outDir = NodePath.resolve(args[1]);
  const existing = await NodeFSP.readdir(outDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (existing.length)
    throw new Error(
      "Contract catalog output must be a fresh empty directory; stale schema files must never be published.",
    );
  const sourceCommit = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const sourceDirty =
    NodeChildProcess.execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0;
  const sourceFileDigests = Object.fromEntries(
    await Promise.all(
      CONTRACT_SOURCE_FILES.map(async (file) => [
        file,
        sha256(await NodeFSP.readFile(NodePath.resolve(root, file), "utf8")),
      ]),
    ),
  );
  const files = generateExtensionContractCatalog({ sourceCommit, sourceDirty, sourceFileDigests });
  for (const [file, content] of Object.entries(files)) {
    const output = NodePath.resolve(outDir, file);
    await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
    await NodeFSP.writeFile(output, content);
  }
  process.stdout.write(`Generated ${Object.keys(files).length} contract artifacts in ${outDir}\n`);
}
if (import.meta.main) await generateExtensionContractCatalogCli(process.argv.slice(2));
