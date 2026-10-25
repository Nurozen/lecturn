import { describe, expect, it } from "vite-plus/test";

import { exchangeSeedToken, issueWebSocketTicket } from "./connect.ts";

function recordingFetch(response: Response) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return response;
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("exchangeSeedToken", () => {
  it("spends the seed as an environment-bootstrap token without asking for a scope", async () => {
    const { fetch, requests } = recordingFetch(
      Response.json({
        access_token: "app-session",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 2_592_000,
        scope: "apps:host",
      }),
    );

    const result = await exchangeSeedToken({
      origin: "http://127.0.0.1:41001",
      seedToken: "seed",
      clientLabel: "Example",
      fetch,
    });

    expect(result).toEqual({ accessToken: "app-session", expiresInSeconds: 2_592_000 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://127.0.0.1:41001/oauth/token");
    const body = new URLSearchParams(String(requests[0]!.init?.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "seed",
      subject_token_type: "urn:lecturn:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Example",
      client_device_type: "desktop",
    });
    expect(requests[0]!.init?.credentials).toBe("omit");
  });

  it("surfaces a refused seed with the server's answer", async () => {
    const { fetch } = recordingFetch(Response.json({ error: "invalid_grant" }, { status: 401 }));
    await expect(
      exchangeSeedToken({
        origin: "http://127.0.0.1:41001",
        seedToken: "x",
        clientLabel: "E",
        fetch,
      }),
    ).rejects.toThrow(/refused the sidecar seed: 401 .*invalid_grant/);
  });
});

describe("issueWebSocketTicket", () => {
  it("reads the ticket from the server's JSON answer", async () => {
    const { fetch, requests } = recordingFetch(
      Response.json({ ticket: "ws-ticket", expiresAt: "2026-10-25T11:36:24.457Z" }),
    );

    await expect(
      issueWebSocketTicket("http://127.0.0.1:41001", "app-session", fetch),
    ).resolves.toBe("ws-ticket");
    expect(requests[0]!.url).toBe("http://127.0.0.1:41001/api/auth/websocket-ticket");
    expect(requests[0]!.init?.credentials).toBe("omit");
  });
});
