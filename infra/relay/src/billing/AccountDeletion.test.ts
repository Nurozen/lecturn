import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { verifyAccountDeletion } from "./AccountDeletion.ts";

const secret = "whsec_c2FuZGJveC1kZWxldGlvbi10ZXN0LXNlY3JldA==";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const signedRequest = Effect.fn("test.signedRequest")(function* (type: string, key = secret) {
  const body = encodeJson({ type, data: { id: "user_deleted" }, object: "event" });
  const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1000));
  const id = "msg_deleted_test";
  const signature = NodeCrypto.createHmac("sha256", Buffer.from(key.slice(6), "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return new Request("https://relay.example/api/billing/webhooks/clerk", {
    method: "POST",
    body,
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
      "content-type": "application/json",
    },
  });
});
describe("Clerk account deletion verification", () => {
  it.live("accepts a signed deletion and preserves event identity for durable deduplication", () =>
    Effect.gen(function* () {
      const request = yield* signedRequest("user.deleted");
      expect(yield* Effect.promise(() => verifyAccountDeletion(request, secret))).toEqual({
        userId: "user_deleted",
        eventId: "clerk:msg_deleted_test",
      });
    }),
  );
  it.live("rejects signatures from another endpoint's secret", () =>
    Effect.gen(function* () {
      const request = yield* signedRequest("user.deleted");
      const result = yield* Effect.result(
        Effect.tryPromise(() => verifyAccountDeletion(request, "whsec_YW5vdGhlci1zZWNyZXQ=")),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
  it.live("ignores signed non-deletion events", () =>
    Effect.gen(function* () {
      const request = yield* signedRequest("user.updated");
      expect(yield* Effect.promise(() => verifyAccountDeletion(request, secret))).toBeNull();
    }),
  );
});
