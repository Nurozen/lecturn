import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  ContextualDataJobReceipt,
  ExtensionsHelperRequest,
  ExtensionsHelperResponse,
} from "./extensionsHelper.ts";
const decodeUnknownSyncExtensionsHelperResponse =
  Schema.decodeUnknownSync(ExtensionsHelperResponse);
const encodeSyncExtensionsHelperRequest = Schema.encodeSync(ExtensionsHelperRequest);
const encodeSyncExtensionsHelperResponse = Schema.encodeSync(ExtensionsHelperResponse);
const isContextualDataJobReceipt = Schema.is(ContextualDataJobReceipt);
const isExtensionsHelperResponse = Schema.is(ExtensionsHelperResponse);
const now = "2026-09-25T00:00:00.000Z";
const base = { protocolVersion: 1, id: "request", deadlineAt: now };
const strictRequest = Schema.decodeUnknownSync(ExtensionsHelperRequest, {
  onExcessProperty: "error",
});

describe("helper protocol conformance", () => {
  it("round trips discovery independently of funding and rejects stale protocol versions", () => {
    const request = { ...base, operation: "extensions.describe", payload: {} };
    expect(encodeSyncExtensionsHelperRequest(strictRequest(request))).toEqual(request);
    expect(() => strictRequest({ ...request, protocolVersion: 0 })).toThrow();
    const response = {
      protocolVersion: 1,
      id: "request",
      status: "success",
      operation: "extensions.describe",
      result: {
        protocolVersion: 1,
        buildVersion: "0.1.0",
        minimumHostVersion: "0.0.50",
        features: ["contextual-slack"],
        platforms: ["darwin-arm64"],
        formats: [{ id: "synthetic", version: "1", support: "supported" }],
        limits: {
          maxLineBytes: 1048576,
          maxCandidates: 24,
          maxConcurrentOperations: 2,
          maxProgressNotificationsPerSecond: 2,
        },
      },
    };
    const decoded = decodeUnknownSyncExtensionsHelperResponse(response);
    expect(encodeSyncExtensionsHelperResponse(decoded)).toEqual(response);
  });
  it("accepts explicit typed operation payloads and rejects arbitrary execution or model options", () => {
    for (const [operation, payload] of [
      ["contextual.sources.list", { limit: 20 }],
      [
        "contextual.sources.configure",
        {
          expectedRevision: 0,
          policy: {
            allowedSourceIds: ["source"],
            allowDirectMessages: false,
            allowGroupDirectMessages: false,
            unknownConversationPolicy: "exclude",
            draftsPolicy: "exclude",
            revision: 1,
          },
        },
      ],
      [
        "contextual.capture.setState",
        {
          state: "paused",
          expectedGeneration: 1,
          fundingGeneration: 1,
          eligibilityValidUntil: null,
        },
      ],
      ["contextual.capture.status", {}],
      [
        "contextual.evidence.read",
        {
          evidenceId: "e",
          sourceId: "source",
          expectedSourceRevision: 1,
          expectedPurgeGeneration: 1,
        },
      ],
      [
        "contextual.data.export",
        {
          actionId: "a",
          selection: { kind: "sources", sourceIds: ["s"] },
          expectedSourceGeneration: 1,
          expectedPurgeGeneration: 1,
        },
      ],
      [
        "contextual.data.forget",
        {
          actionId: "a",
          selection: { kind: "items", sourceId: "s", occurrenceIds: ["o"] },
          expectedSourceGeneration: 1,
          expectedPurgeGeneration: 1,
        },
      ],
      ["operation.cancel", { requestId: "other-request", jobId: null }],
    ])
      expect(() => strictRequest({ ...base, operation, payload })).not.toThrow();
    expect(() =>
      strictRequest({ ...base, operation: "execute", payload: { command: "anything" } }),
    ).toThrow();
    expect(() =>
      strictRequest({
        ...base,
        operation: "extensions.describe",
        payload: { executablePath: "/tmp/helper", prompt: "anything" },
      }),
    ).toThrow();
    expect(() =>
      strictRequest({
        ...base,
        operation: "contextual.capture.setState",
        payload: {
          state: "running",
          expectedGeneration: 1,
          fundingGeneration: 1,
          eligibilityValidUntil: null,
        },
      }),
    ).toThrow();
  });
  it("keeps cancellation scoped and validates progress totals and response operation", () => {
    const progress = {
      protocolVersion: 1,
      id: "request",
      status: "progress",
      operation: "contextual.data.forget",
      jobId: "job",
      phase: "purging",
      completed: 5,
      total: 10,
    };
    expect(isExtensionsHelperResponse(progress)).toBe(true);
    expect(isExtensionsHelperResponse({ ...progress, completed: 11 })).toBe(false);
    const cancellation = {
      protocolVersion: 1,
      id: "request",
      status: "success",
      operation: "operation.cancel",
      result: { requestId: "target", jobId: null, state: "canceled" },
    };
    expect(isExtensionsHelperResponse(cancellation)).toBe(true);
    expect(
      isExtensionsHelperResponse({
        ...cancellation,
        operation: "contextual.evidence.read",
      }),
    ).toBe(false);
  });
  it("does not claim an exported artifact before completion or for forgetting", () => {
    const receipt = {
      jobId: "job",
      actionId: "action",
      operation: "export",
      state: "completed",
      sourceGeneration: 1,
      purgeGeneration: 1,
      artifactId: "artifact",
      affectedRecords: 1,
      updatedAt: now,
    };
    expect(isContextualDataJobReceipt(receipt)).toBe(true);
    expect(isContextualDataJobReceipt({ ...receipt, state: "running" })).toBe(false);
    expect(isContextualDataJobReceipt({ ...receipt, operation: "forget" })).toBe(false);
  });
});
