import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { bindAccountTokenClerk } from "./accountTokenReaders";
import { useSessionRelayToken } from "./useSessionRelayToken";

vi.mock("./publicConfig", () => ({
  resolveRelayClerkTokenOptions: () => ({ template: "relay" }),
}));
const token = (accountId: string, revision: string) =>
  `header.${btoa(JSON.stringify({ sub: accountId, revision }))}.signature`;
const session = (accountId: string, revision: string) => ({
  user: { id: accountId },
  getToken: vi.fn(async () => token(accountId, revision)),
});
const reader = (userId: string | null, sessionId = userId) =>
  useSessionRelayToken({ userId, sessionId, isSignedIn: userId !== null });
afterEach(() => bindAccountTokenClerk(null));

describe("account-scoped relay credentials", () => {
  it("uses hydrated credentials through the same stable reader", async () => {
    const read = reader("a");
    expect(await read()).toBeNull();
    bindAccountTokenClerk({ client: { signedInSessions: [session("a", "ready")] } });
    expect(reader("a")).toBe(read);
    expect(await read()).toBe(token("a", "ready"));
  });
  it("reads refreshed resources without restarting account effects", async () => {
    const client = { signedInSessions: [session("a", "first")] };
    bindAccountTokenClerk({ client });
    const read = reader("a", "old-session");
    expect(await read()).toBe(token("a", "first"));
    client.signedInSessions = [session("a", "new")];
    expect(reader("a", "new-session")).toBe(read);
    expect(await read()).toBe(token("a", "new"));
  });
  it("keeps concurrent accounts isolated and stops using revoked credentials", async () => {
    const a = session("a", "active"),
      b = session("b", "active");
    const client = { signedInSessions: [a, b] };
    bindAccountTokenClerk({ client });
    const oldReader = reader("a");
    expect(await oldReader()).toBe(token("a", "active"));
    expect(await reader("b")()).toBe(token("b", "active"));
    client.signedInSessions = [b];
    expect(await oldReader()).toBeNull();
    expect(await reader(null)()).toBeNull();
    expect(await reader("b")()).toBe(token("b", "active"));
  });
});
