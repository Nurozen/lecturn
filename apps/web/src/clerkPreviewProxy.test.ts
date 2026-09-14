import { describe, expect, it, vi } from "vite-plus/test";

import { clerkPreviewProxy } from "../server/clerkPreviewProxy";

const origin = "https://lecturn-preview.vercel.app";
const env = {
  VERCEL_ENV: "preview",
  VERCEL_URL: "lecturn-preview.vercel.app",
  CLERK_SECRET_KEY: "server-only-test-key",
};
function request(path = "/__clerk/v1/client/sign_ins", init?: RequestInit) {
  return new Request(`${origin}${path}`, {
    ...init,
    headers: { origin, "x-vercel-forwarded-for": "192.0.2.10", ...init?.headers },
  });
}

describe("Clerk preview proxy", () => {
  it("forwards sign-in bodies, query, trusted IP and server authentication without following redirects", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"response":{"status":"needs_first_factor"}}'));
    const response = await clerkPreviewProxy(
      request("/__clerk/v1/client/sign_ins?__clerk_api_version=2026-01-01", {
        method: "POST",
        body: "identifier=person%40example.com",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "clerk-secret-key": "attacker",
          "clerk-proxy-url": "https://evil.test",
          "x-forwarded-for": "1.1.1.1",
          "x-vercel-protection-bypass": "private-vercel-token",
          cookie: "_vercel_jwt=private; __vercel_live_token=private; __clerk_db_jwt=clerk-session",
        },
      }),
      env,
      fetcher,
    );
    expect(response.status).toBe(200);
    const [forwarded, options] = fetcher.mock.calls[0]!;
    expect(forwarded).toBeInstanceOf(Request);
    const upstream = forwarded as Request;
    expect(upstream.url).toBe(
      "https://frontend-api.clerk.dev/v1/client/sign_ins?__clerk_api_version=2026-01-01",
    );
    expect(await upstream.text()).toBe("identifier=person%40example.com");
    expect(upstream.headers.get("clerk-secret-key")).toBe(env.CLERK_SECRET_KEY);
    expect(upstream.headers.get("clerk-proxy-url")).toBe(`${origin}/__clerk`);
    expect(upstream.headers.get("x-forwarded-for")).toBe("192.0.2.10");
    expect(upstream.headers.has("x-vercel-protection-bypass")).toBe(false);
    expect(upstream.headers.get("cookie")).toBe("__clerk_db_jwt=clerk-session");
    expect(options?.redirect).toBe("manual");
  });

  it("preserves Clerk validation errors and multiple session cookies, never caching them", async () => {
    const headers = new Headers({ "content-encoding": "gzip", "content-length": "12" });
    headers.append("set-cookie", "first=1; HttpOnly");
    headers.append("set-cookie", "second=2; HttpOnly");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{"errors":[{"message":"Account exists"}]}', { status: 422, headers }),
      );
    const response = await clerkPreviewProxy(request(), env, fetcher);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ errors: [{ message: "Account exists" }] });
    expect(response.headers.getSetCookie()).toEqual(["first=1; HttpOnly", "second=2; HttpOnly"]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("content-encoding")).toBe(false);
  });

  it("refuses production, alias domains and foreign Origin headers before sending secrets", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      (await clerkPreviewProxy(request(), { ...env, VERCEL_ENV: "production" }, fetcher)).status,
    ).toBe(404);
    expect(
      (
        await clerkPreviewProxy(
          new Request("https://alias.vercel.app/__clerk/v1/environment"),
          env,
          fetcher,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await clerkPreviewProxy(
          request(undefined, { headers: { origin: "https://evil.test" } }),
          env,
          fetcher,
        )
      ).status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed for missing secrets or untrusted client IPs", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      (await clerkPreviewProxy(request(), { ...env, CLERK_SECRET_KEY: "" }, fetcher)).status,
    ).toBe(503);
    expect(
      (
        await clerkPreviewProxy(
          request(undefined, { headers: { "x-vercel-forwarded-for": "bad,192.0.2.10" } }),
          env,
          fetcher,
        )
      ).status,
    ).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps encoded and double-slash paths on the fixed Clerk upstream", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    await clerkPreviewProxy(request("/api/clerk-proxy//evil.test/v1/client"), env, fetcher);
    expect((fetcher.mock.calls[0]![0] as Request).url).toBe(
      "https://frontend-api.clerk.dev//evil.test/v1/client",
    );
  });

  it("returns a usable error without exposing upstream exception details", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(env.CLERK_SECRET_KEY));
    const response = await clerkPreviewProxy(request(), env, fetcher);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(env.CLERK_SECRET_KEY);
  });
});
