import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  os: "ios",
  events: new Map<string, (value: boolean) => void>(),
  transparency: vi.fn<() => Promise<boolean>>(),
  contrast: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
  AccessibilityInfo: {
    isReduceTransparencyEnabled: () => native.transparency(),
    isDarkerSystemColorsEnabled: () => native.contrast(),
    isHighTextContrastEnabled: () => native.contrast(),
    addEventListener: (event: string, callback: (value: boolean) => void) => {
      native.events.set(event, callback);
      return { remove: () => native.events.delete(event) };
    },
  },
}));
import { glassAccessibilityStore as store } from "./useGlassAccessibility";

let cleanups: Array<() => void> = [];
function mount() {
  const stop = store.subscribe(vi.fn());
  cleanups.push(stop);
  return stop;
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}
beforeEach(() => {
  native.os = "ios";
  native.transparency.mockReset().mockResolvedValue(false);
  native.contrast.mockReset().mockResolvedValue(false);
});
afterEach(() => {
  for (const stop of cleanups) stop();
  cleanups = [];
});

describe("glass accessibility preferences", () => {
  it("shares native observers across cards and keeps either accessibility preference opaque", async () => {
    const first = mount();
    mount();
    expect(store.getSnapshot()).toBe(true);
    await flush();
    expect(store.getSnapshot()).toBe(false);
    expect(native.transparency).toHaveBeenCalledTimes(1);
    expect(native.events.size).toBe(2);
    native.events.get("reduceTransparencyChanged")!(true);
    native.events.get("darkerSystemColorsChanged")!(true);
    native.events.get("reduceTransparencyChanged")!(false);
    expect(store.getSnapshot()).toBe(true);
    native.events.get("darkerSystemColorsChanged")!(false);
    expect(store.getSnapshot()).toBe(false);
    first();
    expect(native.events.size).toBe(2);
  });

  it("does not let a late initial query undo a live accessibility change", async () => {
    let resolve!: (value: boolean) => void;
    native.transparency.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mount();
    native.events.get("reduceTransparencyChanged")!(true);
    resolve(false);
    await flush();
    expect(store.getSnapshot()).toBe(true);
  });

  it("ignores queries from a removed screen after a new screen subscribes", async () => {
    let resolve!: (value: boolean) => void;
    native.transparency.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const stop = mount();
    stop();
    expect(native.events.size).toBe(0);
    mount();
    await flush();
    expect(store.getSnapshot()).toBe(false);
    resolve(true);
    await flush();
    expect(store.getSnapshot()).toBe(false);
  });

  it("uses Android high-text contrast without querying the iOS-only transparency API", async () => {
    native.os = "android";
    mount();
    await flush();
    expect(store.getSnapshot()).toBe(false);
    expect(native.transparency).not.toHaveBeenCalled();
    native.events.get("highTextContrastChanged")!(true);
    expect(store.getSnapshot()).toBe(true);
  });
});
