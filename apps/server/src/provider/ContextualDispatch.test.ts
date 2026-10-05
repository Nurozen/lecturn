import * as Data from "effect/Data";
import {
  ContextualDeliveryReceipt,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@lecturn/contracts";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
class ReceiptWriteError extends Data.TaggedError("ReceiptWriteError") {}
const encodeContextualTestJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
import {
  contextualEvidenceFits,
  prepareContextualDispatch,
  renderContextualEvidence,
} from "./ContextualDispatch.ts";
const instanceId = ProviderInstanceId.make("test");
const evidence = {
  preparationId: "prep",
  packetId: "packet",
  dispatchId: "dispatch",
  submissionId: "submission",
  providerInstanceId: instanceId,
  providerContextEpoch: "epoch",
  providerContextId: "native",
  text: "Source text",
  evidenceIds: ["source-1"],
};
const input = { threadId: ThreadId.make("thread"), contextualEvidence: evidence };
const decode = Schema.decodeUnknownSync(ContextualDeliveryReceipt);
it.effect(
  "contextual receipts reconcile unknown inclusion with native acceptance using one identity",
  () =>
    Effect.gen(function* () {
      const observed: ContextualDeliveryReceipt[] = [];
      const dispatch = prepareContextualDispatch(
        {
          ...input,
          onContextualReceipt: (r) =>
            Effect.sync(() => {
              observed.push(r);
            }),
        },
        "fresh",
        instanceId,
        "native",
      );
      const unknown = yield* dispatch.receipt("unknown", null, null);
      const accepted = yield* dispatch.receipt(
        "accepted",
        TurnId.make("native-turn"),
        "native-ack",
      );
      expect(dispatch.text).toBe(renderContextualEvidence(evidence.text));
      expect(unknown?.id).toBe(accepted?.id);
      expect(unknown?.evidenceIncluded).toBe(true);
      expect(unknown?.suppliedEvidenceIds).toEqual([]);
      expect(accepted?.suppliedEvidenceIds).toEqual(["source-1"]);
      expect(yield* dispatch.receipt("accepted", TurnId.make("native-turn"), "native-ack")).toBe(
        accepted,
      );
      expect(observed.map((r) => decode(r).acceptance)).toEqual([
        "unknown",
        "accepted",
        "accepted",
      ]);
      expect(encodeContextualTestJson(observed)).not.toContain(evidence.text);
    }),
);
it.effect(
  "contextual fresh dispatch remains included when native acceptance reports a queue race",
  () =>
    Effect.gen(function* () {
      const dispatch = prepareContextualDispatch(input, "fresh", instanceId, "native");
      const receipt = yield* dispatch.receipt(
        "accepted",
        TurnId.make("queued-turn"),
        "native-ack",
        "provider-queued",
      );
      expect(decode(receipt).disposition).toBe("provider-queued");
      expect(receipt?.evidenceIncluded).toBe(true);
    }),
);
for (const disposition of ["steered", "provider-queued", "skipped"] as const) {
  it.effect(`contextual ${disposition} never appends evidence`, () =>
    Effect.gen(function* () {
      const dispatch = prepareContextualDispatch(input, disposition, instanceId, "native");
      expect(dispatch.text).toBeUndefined();
      expect(decode(yield* dispatch.receipt("unknown", null, null)).evidenceIncluded).toBe(false);
    }),
  );
}
it("contextual evidence respects the complete wrapper byte budget and native identity", () => {
  expect(contextualEvidenceFits("😀".repeat(400))).toBe(false);
  const overhead = new TextEncoder().encode(renderContextualEvidence("")).length;
  expect(contextualEvidenceFits("x".repeat(1500 - overhead))).toBe(true);
  expect(contextualEvidenceFits("x".repeat(1501 - overhead))).toBe(false);
  expect(prepareContextualDispatch(input, "fresh", instanceId, "other").included).toBe(false);
  expect(
    prepareContextualDispatch(input, "fresh", ProviderInstanceId.make("other"), "native").included,
  ).toBe(false);
});
it.effect(
  "contextual observer failure prevents dispatch, but cannot turn native acceptance into a resend",
  () =>
    Effect.gen(function* () {
      const dispatch = prepareContextualDispatch(
        { ...input, onContextualReceipt: () => Effect.fail(new ReceiptWriteError()) },
        "fresh",
        instanceId,
        "native",
      );
      expect(Exit.isFailure(yield* Effect.exit(dispatch.receipt("unknown", null, null)))).toBe(
        true,
      );
      expect(
        (yield* dispatch.receipt("accepted", TurnId.make("native-turn"), "ack"))?.acceptance,
      ).toBe("accepted");
      expect((yield* dispatch.receipt("unknown", null, null, undefined, true))?.acceptance).toBe(
        "unknown",
      );
    }),
);
