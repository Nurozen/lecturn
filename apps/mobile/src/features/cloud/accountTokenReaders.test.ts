import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { accountTokenReader, bindAccountTokenClerk, readToken } from "./accountTokenReaders";
vi.mock("./publicConfig", () => ({ resolveRelayClerkTokenOptions: () => ({ template: "relay" }) }));
const token = (sub: string) => `e30.${btoa(JSON.stringify({ sub }))}.signature`;
afterEach(() => bindAccountTokenClerk(null));
describe("mobile account token readers", () => {
  it("looks up the non-active account at read time using only template tokens", async () => {
    const a = vi.fn().mockResolvedValue(token("a"));
    const b = vi.fn().mockResolvedValue(token("b"));
    const clerk = {
      client: {
        signedInSessions: [
          { user: { id: "a" }, getToken: a },
          { user: { id: "b" }, getToken: b },
        ],
      },
    };
    bindAccountTokenClerk(clerk);
    const reader = accountTokenReader("b");
    expect(await reader()).toBe(token("b"));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith({ template: "relay" });
    clerk.client.signedInSessions = [{ user: { id: "a" }, getToken: a }];
    expect(await reader()).toBeNull();
    expect(accountTokenReader("b")).toBe(reader);
  });
  it("serializes reads across accounts", async () => {
    const entered: string[] = [];
    let release = () => {};
    let started = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bindAccountTokenClerk({
      client: {
        signedInSessions: [
          {
            user: { id: "a" },
            getToken: async () => {
              entered.push("a");
              started();
              await gate;
              return token("a");
            },
          },
          {
            user: { id: "b" },
            getToken: async () => {
              entered.push("b");
              return token("b");
            },
          },
        ],
      },
    });
    const reads = [readToken("a"), readToken("b")];
    await startedPromise;
    expect(entered).toEqual(["a"]);
    release();
    expect(await Promise.all(reads)).toEqual([token("a"), token("b")]);
  });
  it("rejects a token belonging to another account", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    bindAccountTokenClerk({
      client: { signedInSessions: [{ user: { id: "a" }, getToken: async () => token("b") }] },
    });
    expect(await readToken("a")).toBeNull();
    log.mockRestore();
  });
});
