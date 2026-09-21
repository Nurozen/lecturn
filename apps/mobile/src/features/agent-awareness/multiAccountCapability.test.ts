import { afterEach, expect, it, vi } from "vite-plus/test";
vi.mock("../cloud/publicConfig", () => ({
  resolveCloudPublicConfig: () => ({ relay: { url: "https://relay.test" } }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("bounds capability discovery and resolves unsupported after timeout", async () => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("timeout")));
        }),
    ),
  );
  const { refreshMultiAccountPushCapability, getMultiAccountPushSupported } =
    await import("./multiAccountCapability");
  const pending = refreshMultiAccountPushCapability();
  controller.abort();
  await pending;
  expect(timeout).toHaveBeenCalledWith(10_000);
  expect(getMultiAccountPushSupported()).toBe(false);
});
