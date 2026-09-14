import * as NodeNet from "node:net";

type Environment = Readonly<Record<string, string | undefined>>;

const FRONTEND_API = "https://frontend-api.clerk.dev";

/** Server-only: Clerk auto-proxies production keys on vercel.app origins. */
export async function clerkPreviewProxy(
  request: Request,
  env: Environment,
  fetchUpstream: typeof fetch = fetch,
): Promise<Response> {
  const fail = (status: number, message: string) =>
    Response.json(
      { errors: [{ message, long_message: message }] },
      {
        status,
        headers: { "Cache-Control": "no-store" },
      },
    );
  const hostname = env.VERCEL_URL?.trim();
  if (env.VERCEL_ENV !== "preview" || !hostname || !/^[a-z0-9-]+\.vercel\.app$/.test(hostname)) {
    return fail(404, "Preview authentication is unavailable on this deployment.");
  }
  const origin = `https://${hostname}`;
  const url = new URL(request.url);
  if (
    url.origin !== origin ||
    (request.headers.has("origin") && request.headers.get("origin") !== origin)
  ) {
    return fail(403, "Open the exact preview deployment URL to sign in.");
  }
  const path = url.pathname.replace(/^\/(?:__clerk|api\/clerk-proxy)(?=\/|$)/, "");
  if (path === url.pathname || !path.startsWith("/")) return fail(404, "Not found.");
  const secret = env.CLERK_SECRET_KEY?.trim();
  if (!secret) return fail(503, "Preview authentication is not configured.");
  // Vercel overwrites this header at its edge. Never trust a user-supplied
  // X-Forwarded-For chain or send a datacenter peer address to Clerk.
  const clientIp = request.headers.get("x-vercel-forwarded-for")?.trim();
  if (!clientIp || !NodeNet.isIP(clientIp))
    return fail(503, "Could not verify the client address.");

  // Assign pathname instead of resolving it: even //evil.test stays on Clerk.
  const upstreamUrl = new URL(FRONTEND_API);
  upstreamUrl.pathname = path;
  upstreamUrl.search = url.search;
  const upstreamRequest = new Request(upstreamUrl, request);
  for (const name of [...upstreamRequest.headers.keys()]) {
    if (
      name.startsWith("x-vercel-") ||
      [
        "host",
        "connection",
        "content-length",
        "forwarded",
        "x-forwarded-host",
        "x-forwarded-proto",
      ].includes(name)
    ) {
      upstreamRequest.headers.delete(name);
    }
  }
  const cookies = upstreamRequest.headers.get("cookie");
  if (cookies) {
    const clerkCookies = cookies
      .split(";")
      .filter((cookie) => !/^_{1,2}vercel_/.test(cookie.trim()));
    if (clerkCookies.length) upstreamRequest.headers.set("cookie", clerkCookies.join(";"));
    else upstreamRequest.headers.delete("cookie");
  }
  upstreamRequest.headers.set("Clerk-Proxy-Url", `${origin}/__clerk`);
  upstreamRequest.headers.set("Clerk-Secret-Key", secret);
  upstreamRequest.headers.set("X-Forwarded-For", clientIp);
  try {
    const response = await fetchUpstream(upstreamRequest, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const headers = new Headers(response.headers);
    // fetch decodes compressed responses. Preserve cookies and Clerk errors,
    // but do not retain encoding/length metadata from the compressed payload.
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("clerk-secret-key");
    headers.set("Cache-Control", "no-store");
    headers.set("Vercel-CDN-Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return fail(502, "Authentication is temporarily unavailable. Please try again.");
  }
}
