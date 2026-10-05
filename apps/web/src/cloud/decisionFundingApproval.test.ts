import { describe, expect, it, vi } from "vite-plus/test";
import { createDecisionFundingApprovalClient } from "./decisionFundingApproval";

const info = {
  challengeId: "challenge",
  environmentId: "host",
  environmentLabel: "My Mac",
  expiresAt: "2026-09-23T12:00:00.000Z",
  approved: false,
  eligible: true,
};
function fixture(response: Response) {
  const token = vi.fn(async (_accountId: string): Promise<string | null> => "account-token");
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
  return {
    token,
    fetch,
    client: createDecisionFundingApprovalClient({
      relayUrl: "https://relay.example",
      token,
      fetch,
    }),
  };
}

describe("Decisions funding approval client", () => {
  it("reads the explicitly selected account token and request metadata without approving", async () => {
    const f = fixture(Response.json(info));
    expect(await f.client.info("account-a", "challenge")).toEqual(info);
    expect(f.token).toHaveBeenCalledWith("account-a");
    expect(f.fetch).toHaveBeenCalledOnce();
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://relay.example/v1/decisions/funding/approval?challengeId=challenge",
    );
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: "Bearer account-token" },
    });
    expect(init?.body).toBeUndefined();
  });
  it("approval sends only the challenge and never a claimed payer", async () => {
    const f = fixture(
      Response.json({ challengeId: "challenge", approved: true, expiresAt: info.expiresAt }),
    );
    expect((await f.client.approve("account-b", "challenge")).approved).toBe(true);
    expect(f.token).toHaveBeenCalledWith("account-b");
    const [, init] = f.fetch.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"challengeId":"challenge"}');
  });
  it("does not send unauthenticated or canceled requests", async () => {
    const f = fixture(Response.json(info));
    f.token.mockResolvedValueOnce(null);
    await expect(f.client.info("account-a", "challenge")).rejects.toThrow("Sign in again");
    expect(f.fetch).not.toHaveBeenCalled();
    const controller = new AbortController();
    f.token.mockImplementationOnce(async () => {
      controller.abort();
      return "token";
    });
    await expect(f.client.approve("account-a", "challenge", controller.signal)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("sanitizes backend errors and rejects invalid success payloads", async () => {
    const f = fixture(new Response("private upstream failure", { status: 410 }));
    await expect(f.client.approve("account-a", "challenge")).rejects.toThrow(
      "This request expired",
    );
    const invalid = fixture(Response.json({ approved: true }));
    await expect(invalid.client.info("account-a", "challenge")).rejects.toThrow();
  });
});
