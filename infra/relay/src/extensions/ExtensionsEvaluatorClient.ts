import { Effect, Schema } from "effect";
import {
  ExtensionEvaluatorResponse,
  ExtensionEvaluatorCleanupResult,
  type ExtensionFeatureId,
} from "@lecturn/contracts";
import { decisionError } from "../decisions/DecisionsAccess.ts";

export interface ExtensionEvaluatorBinding {
  fetch(request: Request): Promise<Response>;
}
export interface ExtensionEvaluatorIdentity {
  readonly environmentId: string;
  readonly attemptId: string;
  readonly featureId: ExtensionFeatureId;
  readonly policyVersion: string;
  readonly model: "extensions-v1";
  readonly requestFingerprint: string;
  readonly admissibilityEpoch: number;
}
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeResponse = Schema.decodeUnknownEffect(ExtensionEvaluatorResponse);
const decodeCleanup = Schema.decodeUnknownEffect(ExtensionEvaluatorCleanupResult);
const unavailable = () =>
  decisionError("unavailable", "Extensions evaluation is temporarily unavailable");
async function readBindingJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok) throw new Error("Evaluator transport rejected request");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new Error("Evaluator response too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Evaluator returned no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) throw new Error("Evaluator response too large");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
/** Only an injected native service binding can dispatch. There is deliberately no URL fallback. */
export const makeExtensionsEvaluatorClient = (
  binding: Effect.Effect<ExtensionEvaluatorBinding | undefined>,
  timeoutMs: number,
) => {
  const send = Effect.fn("ExtensionsEvaluator.send")(function* (
    path: "/evaluate" | "/status" | "/cleanup",
    body: unknown,
    maxBytes: number,
  ) {
    const service = yield* binding;
    if (!service || typeof service.fetch !== "function") return yield* unavailable();
    return yield* Effect.tryPromise({
      try: async (signal) =>
        readBindingJson(
          await service.fetch(
            new Request(`https://extensions.internal${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeJson(body),
              signal,
            }),
          ),
          maxBytes,
        ),
      catch: unavailable,
    }).pipe(Effect.timeout(`${timeoutMs} millis`), Effect.mapError(unavailable));
  }, Effect.withTracerEnabled(false));
  const call = Effect.fn("ExtensionsEvaluator.call")(function* (
    path: "/evaluate" | "/status",
    identity: ExtensionEvaluatorIdentity,
    request?: unknown,
  ) {
    const result = yield* send(
      path,
      { ...identity, ...(request === undefined ? {} : { request }) },
      128 * 1024,
    ).pipe(Effect.flatMap(decodeResponse), Effect.mapError(unavailable));
    if (
      result.attemptId !== identity.attemptId ||
      (result.status === "completed" && result.result.policyVersion !== identity.policyVersion)
    )
      return yield* unavailable();
    return result;
  }, Effect.withTracerEnabled(false));
  return {
    available: Effect.map(binding, (value) => typeof value?.fetch === "function"),
    evaluate: (identity: ExtensionEvaluatorIdentity, request: unknown) =>
      call("/evaluate", identity, request),
    status: (identity: ExtensionEvaluatorIdentity) => call("/status", identity),
    cleanup: (
      environmentId: string,
      minimumAdmissibilityEpoch: number,
      expireResultsBefore: string,
    ) =>
      send(
        "/cleanup",
        { environmentId, minimumAdmissibilityEpoch, expireResultsBefore },
        1024,
      ).pipe(Effect.flatMap(decodeCleanup), Effect.mapError(unavailable), Effect.asVoid),
  };
};
