import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ContextualEvidence,
  ContextualRetrieveRequest,
  ContextualRetrieveResult,
  ContextualSource,
  ContextualSourceConfiguration,
  ContextualSourcePolicy,
} from "./contextual.ts";

export const EXTENSIONS_HELPER_PROTOCOL_VERSION = 1;
export const EXTENSIONS_HELPER_MAX_LINE_BYTES = 1048576;
const id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const sourceIds = Schema.Array(id).check(
  Schema.isMaxLength(256),
  Schema.makeFilter((v) => new Set(v).size === v.length),
);
export const ExtensionsHelperOperation = Schema.Literals([
  "extensions.describe",
  "contextual.sources.list",
  "contextual.sources.configure",
  "contextual.capture.setState",
  "contextual.capture.status",
  "contextual.retrieve",
  "contextual.evidence.read",
  "contextual.data.export",
  "contextual.data.forget",
  "operation.cancel",
]);
export const ExtensionsHelperLimits = Schema.Struct({
  maxLineBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: EXTENSIONS_HELPER_MAX_LINE_BYTES }),
  ),
  maxCandidates: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 })),
  maxConcurrentOperations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  maxProgressNotificationsPerSecond: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 10 }),
  ),
});
export const ExtensionsHelperDescribeRequest = Schema.Record(Schema.String, Schema.Never);
export const ExtensionsHelperDescribeResult = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  buildVersion: id,
  minimumHostVersion: id,
  features: Schema.Array(Schema.Literal("contextual-slack")).check(Schema.isMaxLength(1)),
  platforms: Schema.Array(
    Schema.Literals([
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "linux-arm64",
      "win32-x64",
      "win32-arm64",
    ]),
  ).check(
    Schema.isMaxLength(6),
    Schema.makeFilter((v) => new Set(v).size === v.length),
  ),
  formats: Schema.Array(
    Schema.Struct({ id, version: id, support: Schema.Literals(["supported", "unsupported"]) }),
  ).check(Schema.isMaxLength(64)),
  limits: ExtensionsHelperLimits,
});
export const ContextualSourcesListRequest = Schema.Struct({
  cursor: Schema.optionalKey(id),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
});
export const ContextualSourcesListResult = Schema.Struct({
  sources: Schema.Array(ContextualSource).check(
    Schema.isMaxLength(50),
    Schema.makeFilter((v) => new Set(v.map((s) => s.id)).size === v.length),
  ),
  nextCursor: Schema.NullOr(id),
  policy: ContextualSourcePolicy,
  sourceGeneration: counter,
});
export const ContextualSourcesConfigureRequest = ContextualSourceConfiguration;
export const ContextualSourcesConfigureResult = Schema.Struct({
  policy: ContextualSourcePolicy,
  sourceGeneration: counter,
});
export const ContextualCaptureSetStateRequest = Schema.Struct({
  state: Schema.Literals(["running", "paused"]),
  expectedGeneration: counter,
  fundingGeneration: counter,
  eligibilityValidUntil: Schema.NullOr(IsoDateTime),
}).check(Schema.makeFilter((v) => v.state !== "running" || v.eligibilityValidUntil !== null));
export const ContextualCaptureStatusRequest = Schema.Record(Schema.String, Schema.Never);
export const ContextualCaptureStatusResult = Schema.Struct({
  state: Schema.Literals(["running", "paused", "unavailable"]),
  reason: Schema.Literals([
    "requested",
    "ready",
    "funding-required",
    "eligibility-expired",
    "storage-limit",
    "revoked",
    "unsupported-format",
    "source-unavailable",
    "helper-unavailable",
  ]),
  generation: counter,
  sourceGeneration: counter,
  purgeGeneration: counter,
  receiptId: id,
  observedAt: IsoDateTime,
  capturedRecords: counter,
  coverage: Schema.Literals(["partial", "complete-for-observed-cache", "unknown"]),
});
export const ContextualEvidenceReadRequest = Schema.Struct({
  evidenceId: id,
  sourceId: id,
  expectedSourceRevision: counter,
  expectedPurgeGeneration: counter,
  expectedExchangeRevision: Schema.optional(counter),
  expectedExchangeFingerprint: Schema.optional(text(256)),
}).check(
  Schema.makeFilter(
    (v) =>
      (v.expectedExchangeRevision === undefined) === (v.expectedExchangeFingerprint === undefined),
  ),
);
export const ContextualEvidenceReadResult = Schema.Struct({
  evidence: ContextualEvidence,
  purgeGeneration: counter,
});
export const ContextualDataSelection = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("sources"),
    sourceIds: sourceIds.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    kind: Schema.Literal("items"),
    sourceId: id,
    occurrenceIds: sourceIds.check(Schema.isMinLength(1)),
  }),
]);
export const ContextualDataExportRequest = Schema.Struct({
  actionId: id,
  selection: ContextualDataSelection,
  expectedSourceGeneration: counter,
  expectedPurgeGeneration: counter,
});
export const ContextualDataForgetRequest = Schema.Struct({
  actionId: id,
  selection: ContextualDataSelection,
  expectedSourceGeneration: counter,
  expectedPurgeGeneration: counter,
});
export const ContextualDataJobReceipt = Schema.Struct({
  jobId: id,
  actionId: id,
  operation: Schema.Literals(["export", "forget"]),
  state: Schema.Literals(["accepted", "running", "completed", "canceled", "failed"]),
  sourceGeneration: counter,
  purgeGeneration: counter,
  artifactId: Schema.NullOr(id),
  affectedRecords: counter,
  updatedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (v) => v.artifactId === null || (v.operation === "export" && v.state === "completed"),
  ),
);
export const ExtensionsHelperCancelRequest = Schema.Struct({
  requestId: id,
  jobId: Schema.NullOr(id),
});
export const ExtensionsHelperCancelResult = Schema.Struct({
  requestId: id,
  jobId: Schema.NullOr(id),
  state: Schema.Literals(["canceled", "already-completed", "not-found"]),
});
export const ExtensionsHelperError = Schema.Struct({
  code: Schema.Literals([
    "invalid-request",
    "unsupported-version",
    "unsupported-operation",
    "unsupported-format",
    "forbidden",
    "not-found",
    "stale-generation",
    "source-unavailable",
    "busy",
    "deadline-exceeded",
    "canceled",
    "internal",
  ]),
  message: text(1000),
  retryable: Schema.Boolean,
});
const requestBase = { protocolVersion: Schema.Literal(1), id, deadlineAt: IsoDateTime };
const responseBase = { protocolVersion: Schema.Literal(1), id };
export const ExtensionsHelperRequest = Schema.Union([
  Schema.Struct({
    ...requestBase,
    operation: Schema.Literal("extensions.describe"),
    payload: ExtensionsHelperDescribeRequest,
  }),
  Schema.Struct({
    ...requestBase,
    operation: Schema.Literal("contextual.sources.list"),
    payload: ContextualSourcesListRequest,
  }),
  Schema.Struct({
    ...requestBase,
    operation: Schema.Literal("contextual.sources.configure"),
    payload: ContextualSourcesConfigureRequest,
  }),
  Schema.Struct({
    ...requestBase,
    operation: Schema.Literal("contextual.capture.setState"),
    payload: ContextualCaptureSetStateRequest,
  }),
  Schema.Struct({
    ...requestBase,
    operation: Schema.Literal("contextual.capture.status"),
    payload: ContextualCaptureStatusRequest,
  }),
  Schema.Struct({
    ...requestBase,
    operation: Schema.Literal("contextual.retrieve"),
    payload: ContextualRetrieveRequest,
  }),
  Schema.Struct({
    ...requestBase,
    operation: Schema.Literal("contextual.evidence.read"),
    payload: ContextualEvidenceReadRequest,
  }),
  Schema.Struct({
    ...requestBase,
    operation: Schema.Literal("contextual.data.export"),
    payload: ContextualDataExportRequest,
  }),
  Schema.Struct({
    ...requestBase,
    operation: Schema.Literal("contextual.data.forget"),
    payload: ContextualDataForgetRequest,
  }),
  Schema.Struct({
    ...requestBase,
    operation: Schema.Literal("operation.cancel"),
    payload: ExtensionsHelperCancelRequest,
  }),
]).check(
  Schema.makeFilter(
    (v) => new TextEncoder().encode(JSON.stringify(v)).length <= EXTENSIONS_HELPER_MAX_LINE_BYTES,
  ),
);
export const ExtensionsHelperSuccess = Schema.Union([
  Schema.Struct({
    ...responseBase,
    status: Schema.Literal("success"),
    operation: Schema.Literal("extensions.describe"),
    result: ExtensionsHelperDescribeResult,
  }),
  Schema.Struct({
    ...responseBase,
    status: Schema.Literal("success"),
    operation: Schema.Literal("contextual.sources.list"),
    result: ContextualSourcesListResult,
  }),
  Schema.Struct({
    ...responseBase,
    status: Schema.Literal("success"),
    operation: Schema.Literal("contextual.sources.configure"),
    result: ContextualSourcesConfigureResult,
  }),
  Schema.Struct({
    ...responseBase,
    status: Schema.Literal("success"),
    operation: Schema.Literal("contextual.capture.setState"),
    result: ContextualCaptureStatusResult,
  }),
  Schema.Struct({
    ...responseBase,
    status: Schema.Literal("success"),
    operation: Schema.Literal("contextual.capture.status"),
    result: ContextualCaptureStatusResult,
  }),
  Schema.Struct({
    ...responseBase,
    status: Schema.Literal("success"),
    operation: Schema.Literal("contextual.retrieve"),
    result: ContextualRetrieveResult,
  }),
  Schema.Struct({
    ...responseBase,
    status: Schema.Literal("success"),
    operation: Schema.Literal("contextual.evidence.read"),
    result: ContextualEvidenceReadResult,
  }),
  Schema.Struct({
    ...responseBase,
    status: Schema.Literal("success"),
    operation: Schema.Literal("contextual.data.export"),
    result: ContextualDataJobReceipt.check(Schema.makeFilter((v) => v.operation === "export")),
  }),
  Schema.Struct({
    ...responseBase,
    status: Schema.Literal("success"),
    operation: Schema.Literal("contextual.data.forget"),
    result: ContextualDataJobReceipt.check(Schema.makeFilter((v) => v.operation === "forget")),
  }),
  Schema.Struct({
    ...responseBase,
    status: Schema.Literal("success"),
    operation: Schema.Literal("operation.cancel"),
    result: ExtensionsHelperCancelResult,
  }),
]);
export const ExtensionsHelperFailure = Schema.Struct({
  ...responseBase,
  status: Schema.Literal("error"),
  operation: ExtensionsHelperOperation,
  error: ExtensionsHelperError,
});
export const ExtensionsHelperProgress = Schema.Struct({
  ...responseBase,
  status: Schema.Literal("progress"),
  operation: ExtensionsHelperOperation,
  jobId: Schema.NullOr(id),
  phase: Schema.Literals(["queued", "reading", "indexing", "exporting", "purging", "canceling"]),
  completed: counter,
  total: Schema.NullOr(counter),
}).check(Schema.makeFilter((v) => v.total === null || v.completed <= v.total));
export const ExtensionsHelperResponse = Schema.Union([
  ExtensionsHelperSuccess,
  ExtensionsHelperFailure,
  ExtensionsHelperProgress,
]).check(
  Schema.makeFilter(
    (v) => new TextEncoder().encode(JSON.stringify(v)).length <= EXTENSIONS_HELPER_MAX_LINE_BYTES,
  ),
);

export type ExtensionsHelperOperation = typeof ExtensionsHelperOperation.Type;
export type ExtensionsHelperLimits = typeof ExtensionsHelperLimits.Type;
export type ExtensionsHelperDescribeRequest = typeof ExtensionsHelperDescribeRequest.Type;
export type ExtensionsHelperDescribeResult = typeof ExtensionsHelperDescribeResult.Type;
export type ContextualSourcesListRequest = typeof ContextualSourcesListRequest.Type;
export type ContextualSourcesListResult = typeof ContextualSourcesListResult.Type;
export type ContextualSourcesConfigureRequest = typeof ContextualSourcesConfigureRequest.Type;
export type ContextualSourcesConfigureResult = typeof ContextualSourcesConfigureResult.Type;
export type ContextualCaptureSetStateRequest = typeof ContextualCaptureSetStateRequest.Type;
export type ContextualCaptureStatusRequest = typeof ContextualCaptureStatusRequest.Type;
export type ContextualCaptureStatusResult = typeof ContextualCaptureStatusResult.Type;
export type ContextualEvidenceReadRequest = typeof ContextualEvidenceReadRequest.Type;
export type ContextualEvidenceReadResult = typeof ContextualEvidenceReadResult.Type;
export type ContextualDataSelection = typeof ContextualDataSelection.Type;
export type ContextualDataExportRequest = typeof ContextualDataExportRequest.Type;
export type ContextualDataForgetRequest = typeof ContextualDataForgetRequest.Type;
export type ContextualDataJobReceipt = typeof ContextualDataJobReceipt.Type;
export type ExtensionsHelperCancelRequest = typeof ExtensionsHelperCancelRequest.Type;
export type ExtensionsHelperCancelResult = typeof ExtensionsHelperCancelResult.Type;
export type ExtensionsHelperError = typeof ExtensionsHelperError.Type;
export type ExtensionsHelperRequest = typeof ExtensionsHelperRequest.Type;
export type ExtensionsHelperSuccess = typeof ExtensionsHelperSuccess.Type;
export type ExtensionsHelperFailure = typeof ExtensionsHelperFailure.Type;
export type ExtensionsHelperProgress = typeof ExtensionsHelperProgress.Type;
export type ExtensionsHelperResponse = typeof ExtensionsHelperResponse.Type;
