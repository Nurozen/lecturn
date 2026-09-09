// @effect-diagnostics globalDate:off - Signed webhook freshness uses wall-clock Unix timestamps.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";
import { handleRequest, type Env } from "./index.ts";

const secretBytes = Buffer.from("test signing secret is not a credential");
const env: Env = {
  CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${secretBytes.toString("base64")}`,
  RESEND_API_KEY: "test-key",
  AUTH_EMAIL_FROM: "Lecturn <notifications@cloudgatherer.net>",
};
const email = {
  id: "email_test",
  delivered_by_clerk: false,
  to_email_address: "test@example.com",
  subject: "Sign in",
  body: "<p>Your code: 123456</p>",
  body_plain: "Your code: 123456",
};
function signed(data: unknown = email, timestamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify({ type: "email.created", data });
  const signature = NodeCrypto.createHmac("sha256", secretBytes)
    .update(`msg_test.${timestamp}.${body}`)
    .digest("base64");
  return new Request("https://worker.example/clerk-email", {
    method: "POST",
    body,
    headers: {
      "svix-id": "msg_test",
      "svix-timestamp": String(timestamp),
      "svix-signature": `v1,${signature}`,
    },
  });
}

describe("Clerk email delivery", () => {
  it("verifies signed messages and preserves content with a stable idempotency key", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"id":"sent"}'));
    expect((await handleRequest(signed(), env, send)).status).toBe(204);
    expect((await handleRequest(signed(), env, send)).status).toBe(204);
    for (const [url, options] of send.mock.calls) {
      expect(url).toBe("https://api.resend.com/emails");
      expect(new Headers(options?.headers).get("Idempotency-Key")).toBe("clerk-email/email_test");
      expect(JSON.parse(String(options?.body))).toEqual({
        from: env.AUTH_EMAIL_FROM,
        to: [email.to_email_address],
        subject: email.subject,
        html: email.body,
        text: email.body_plain,
      });
    }
  });
  it("rejects unsigned and stale requests without sending", async () => {
    const send = vi.fn<typeof fetch>();
    const unsigned = new Request("https://worker.example/clerk-email", {
      method: "POST",
      body: "{}",
    });
    expect((await handleRequest(unsigned, env, send)).status).toBe(400);
    const forged = signed();
    forged.headers.set("svix-signature", "v1,Zm9yZ2Vk");
    expect((await handleRequest(forged, env, send)).status).toBe(400);
    expect((await handleRequest(signed(email, 1), env, send)).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
  it("avoids duplicate delivery by Clerk and rejects incomplete email payloads", async () => {
    const send = vi.fn<typeof fetch>();
    expect(
      (await handleRequest(signed({ ...email, delivered_by_clerk: true }), env, send)).status,
    ).toBe(204);
    expect(
      (await handleRequest(signed({ ...email, to_email_address: undefined }), env, send)).status,
    ).toBe(422);
    expect(send).not.toHaveBeenCalled();
  });
  it("requests webhook retries when the provider rejects or fails", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockRejectedValueOnce(new Error("network"));
    expect((await handleRequest(signed(), env, send)).status).toBe(502);
    expect((await handleRequest(signed(), env, send)).status).toBe(502);
  });
});
