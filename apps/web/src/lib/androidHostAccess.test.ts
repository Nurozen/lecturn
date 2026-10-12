import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  requireAndroidFullAccess,
  hasPhoneConnectAccount,
  type AndroidAccessState,
  type AndroidHost,
} from "./androidHostAccess";

const state = (fullAccess = false): AndroidAccessState => ({
  verified: true,
  fullAccess,
  computerUse: false,
  revision: 2,
  capabilities: { appData: true, computerUse: false },
});
const host = (): AndroidHost => ({
  protocolVersion: 2,
  getAccessState: vi.fn(async () => state()),
  requestFullAccess: vi.fn(async () => state(true)),
  openDeviceAccess: vi.fn(async () => state()),
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Android Full access guard", () => {
  it("preserves bridge-absent clients and all non-Full provider modes", async () => {
    await expect(
      requireAndroidFullAccess("thread", "full-access", undefined),
    ).resolves.toBeUndefined();
    const bridge = host();
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      await requireAndroidFullAccess("thread", mode, bridge);
    }
    expect(bridge.getAccessState).not.toHaveBeenCalled();
  });
  it("waits for native acknowledgement before allowing the default Full mode", async () => {
    const bridge = host();
    let complete!: (value: AndroidAccessState) => void;
    bridge.requestFullAccess = vi.fn(
      () =>
        new Promise<AndroidAccessState>((resolve) => {
          complete = resolve;
        }),
    );
    let sent = false;
    const work = requireAndroidFullAccess("new-project-thread", undefined, bridge).then(() => {
      sent = true;
    });
    await vi.waitFor(() =>
      expect(bridge.requestFullAccess).toHaveBeenCalledWith("new-project-thread"),
    );
    expect(sent).toBe(false);
    complete(state(true));
    await work;
    expect(sent).toBe(true);
  });
  it("reads policy on every send and requests again after revocation", async () => {
    const bridge = host();
    bridge.getAccessState = vi
      .fn()
      .mockResolvedValueOnce(state(true))
      .mockResolvedValueOnce(state(false));
    await requireAndroidFullAccess("thread", "full-access", bridge);
    expect(bridge.requestFullAccess).not.toHaveBeenCalled();
    await requireAndroidFullAccess("thread", "full-access", bridge);
    expect(bridge.requestFullAccess).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...state(), verified: false },
    { ...state(true), capabilities: { appData: false, computerUse: false } },
    { ...state(true), revision: null },
    state(false),
  ])("rejects unverified, unsupported, malformed and canceled receipts: %j", async (receipt) => {
    const bridge = host();
    bridge.requestFullAccess = vi.fn(async () => receipt);
    await expect(requireAndroidFullAccess("thread", "full-access", bridge)).rejects.toThrow(
      "not confirmed",
    );
  });
  it("does not open a grant dialog after a disconnected state read", async () => {
    const bridge = host();
    bridge.getAccessState = vi.fn(async () => ({ ...state(), verified: false }));
    await expect(requireAndroidFullAccess("thread", "full-access", bridge)).rejects.toThrow();
    expect(bridge.requestFullAccess).not.toHaveBeenCalled();
  });
  it("rejects legacy fire-and-forget bridges and native rejection", async () => {
    await expect(
      requireAndroidFullAccess("thread", "full-access", { ...host(), protocolVersion: 1 }),
    ).rejects.toThrow();
    const bridge = host();
    bridge.requestFullAccess = vi.fn().mockRejectedValue(new Error("conflict"));
    await expect(requireAndroidFullAccess("thread", "full-access", bridge)).rejects.toThrow();
  });
  it("bounds a missing acknowledgement and does not accept a late receipt", async () => {
    vi.useFakeTimers();
    const bridge = host();
    let complete!: (value: AndroidAccessState) => void;
    bridge.requestFullAccess = vi.fn(
      () =>
        new Promise<AndroidAccessState>((resolve) => {
          complete = resolve;
        }),
    );
    const work = expect(
      requireAndroidFullAccess("thread", "full-access", bridge),
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(185_000);
    await work;
    complete(state(true));
  });
});

it("does not open a late review after the access read has timed out", async () => {
  vi.useFakeTimers();
  const bridge = host();
  let complete!: (value: AndroidAccessState) => void;
  bridge.getAccessState = vi.fn(
    () =>
      new Promise<AndroidAccessState>((resolve) => {
        complete = resolve;
      }),
  );
  const work = expect(requireAndroidFullAccess("thread", "full-access", bridge)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(185_000);
  await work;
  complete(state(false));
  await Promise.resolve();
  expect(bridge.requestFullAccess).not.toHaveBeenCalled();
});

describe("phone Connect capability", () => {
  it("requires the explicit v2 capability and leaves browser/desktop auth selected otherwise", () => {
    for (const surface of [
      {},
      { desktopBridge: {} },
      { symbaHost: { protocolVersion: 2 } },
      { symbaHost: { protocolVersion: 2, connectAccount: false } },
      { symbaHost: { protocolVersion: 1, connectAccount: true } },
    ]) {
      vi.stubGlobal("window", surface);
      expect(hasPhoneConnectAccount()).toBe(false);
    }
    vi.stubGlobal("window", { symbaHost: { protocolVersion: 2, connectAccount: true } });
    expect(hasPhoneConnectAccount()).toBe(true);
  });
});
