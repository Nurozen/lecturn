import { afterEach, expect, it, vi } from "vite-plus/test";
vi.mock("../cloud/publicConfig", () => ({
  resolveCloudPublicConfig: () => ({ relay: { url: "https://relay.test" } }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("bounds capability discovery without AbortSignal.timeout on native", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("AbortSignal", {});
  const fetch = vi.fn(
    (_url, { signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("timeout")));
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const { refreshMultiAccountPushCapability, getMultiAccountPushSupported } =
    await import("./multiAccountCapability");
  const pending = refreshMultiAccountPushCapability();
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10_000);
  await pending;
  expect(getMultiAccountPushSupported()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("accepts native capability responses and clears the abort timer", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("AbortSignal", {});
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ capabilities: { multiAccountPush: true } }),
      }),
  );
  const { refreshMultiAccountPushCapability, getMultiAccountPushSupported } =
    await import("./multiAccountCapability");
  await refreshMultiAccountPushCapability();
  expect(getMultiAccountPushSupported()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
