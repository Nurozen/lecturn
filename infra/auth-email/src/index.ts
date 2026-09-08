import { verifyWebhook } from "@clerk/backend/webhooks";

export interface Env {
  CLERK_WEBHOOK_SIGNING_SECRET: string;
  RESEND_API_KEY: string;
  AUTH_EMAIL_FROM: string;
}

export async function handleRequest(
  request: Request,
  env: Env,
  send: typeof fetch = fetch,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/health" && request.method === "GET") {
    return Response.json({ ok: true });
  }
  if (path !== "/clerk-email") return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env.CLERK_WEBHOOK_SIGNING_SECRET || !env.RESEND_API_KEY || !env.AUTH_EMAIL_FROM) {
    return new Response("Email delivery is not configured", { status: 503 });
  }

  let event;
  try {
    event = await verifyWebhook(request, { signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET });
  } catch {
    return new Response("Invalid webhook signature", { status: 400 });
  }
  if (event.type !== "email.created" || event.data.delivered_by_clerk !== false) {
    return new Response(null, { status: 204 });
  }
  const email = event.data;
  if (
    typeof email.id !== "string" ||
    !email.id ||
    typeof email.to_email_address !== "string" ||
    !email.to_email_address ||
    typeof email.subject !== "string" ||
    !email.subject ||
    !(
      (typeof email.body === "string" && email.body) ||
      (typeof email.body_plain === "string" && email.body_plain)
    )
  ) {
    return new Response("Incomplete email event", { status: 422 });
  }

  try {
    const response = await send("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `clerk-email/${email.id}`,
      },
      body: JSON.stringify({
        from: env.AUTH_EMAIL_FROM,
        to: [email.to_email_address],
        subject: email.subject,
        ...(email.body ? { html: email.body } : {}),
        ...(email.body_plain ? { text: email.body_plain } : {}),
      }),
    });
    // Let Svix retry failed sends. Never log email bodies, addresses, or codes.
    if (!response.ok) return new Response("Email provider rejected delivery", { status: 502 });
    return new Response(null, { status: 204 });
  } catch {
    return new Response("Email provider unavailable", { status: 502 });
  }
}

export default {
  fetch(request: Request, env: Env) {
    return handleRequest(request, env);
  },
};
