import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  LIVE_LEASE_HEARTBEAT_MS,
  LIVE_LEASE_TTL_SECONDS,
  makeLiveLeaseHeartbeat,
} from "./liveLease.ts";

const tools = { url: "http://127.0.0.1:4100/mcp", bearer: "live-bearer" };

function recordingPublisher() {
  const calls: Array<string> = [];
  let failNext = false;
  return {
    calls,
    failNextSet: () => {
      failNext = true;
    },
    publisher: {
      setLease: async (input: { url: string; bearer: string; ttlSeconds: number }) => {
        calls.push(`set ${input.url} ttl=${input.ttlSeconds}`);
        if (failNext) {
          failNext = false;
          throw new Error("socket reconnecting");
        }
      },
      clearLease: async () => {
        calls.push("clear");
      },
    },
  };
}

describe("makeLiveLeaseHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes at once, then renews every 20 s with a 60 s lease", async () => {
    const { calls, publisher } = recordingPublisher();
    const heartbeat = makeLiveLeaseHeartbeat(publisher);

    await heartbeat.set(tools);
    expect(calls).toEqual([`set ${tools.url} ttl=${LIVE_LEASE_TTL_SECONDS}`]);
    expect(LIVE_LEASE_HEARTBEAT_MS * 3).toBe(LIVE_LEASE_TTL_SECONDS * 1000);

    await vi.advanceTimersByTimeAsync(LIVE_LEASE_HEARTBEAT_MS * 3);
    expect(calls).toHaveLength(4);
    heartbeat.stop();
  });

  it("keeps beating after a failed renewal", async () => {
    const recorder = recordingPublisher();
    const heartbeat = makeLiveLeaseHeartbeat(recorder.publisher);
    await heartbeat.set(tools);

    recorder.failNextSet();
    await vi.advanceTimersByTimeAsync(LIVE_LEASE_HEARTBEAT_MS * 2);
    expect(recorder.calls).toHaveLength(3);
    expect(heartbeat.active).toBe(true);
    heartbeat.stop();
  });

  it("rejects when Lecturn refuses the first lease and does not start beating", async () => {
    const recorder = recordingPublisher();
    const heartbeat = makeLiveLeaseHeartbeat(recorder.publisher);
    recorder.failNextSet();

    await expect(heartbeat.set(tools)).rejects.toThrow("socket reconnecting");
    expect(heartbeat.active).toBe(false);
    await vi.advanceTimersByTimeAsync(LIVE_LEASE_HEARTBEAT_MS * 2);
    expect(recorder.calls).toHaveLength(1);
  });

  it("clears once, and a beat in flight never lands after the clear", async () => {
    const calls: Array<string> = [];
    let finishBeat: (() => void) | undefined;
    const heartbeat = makeLiveLeaseHeartbeat({
      setLease: () => {
        calls.push("set");
        // The first lease answers at once; the renewal hangs until released.
        if (calls.length === 1) return Promise.resolve();
        return new Promise<void>((resolve) => {
          finishBeat = resolve;
        });
      },
      clearLease: async () => {
        calls.push("clear");
      },
    });
    await heartbeat.set(tools);
    await vi.advanceTimersByTimeAsync(LIVE_LEASE_HEARTBEAT_MS);
    expect(calls).toEqual(["set", "set"]);

    const cleared = heartbeat.clear();
    await heartbeat.clear();
    finishBeat?.();
    await cleared;
    expect(calls).toEqual(["set", "set", "clear"]);

    await vi.advanceTimersByTimeAsync(LIVE_LEASE_HEARTBEAT_MS * 3);
    expect(calls).toEqual(["set", "set", "clear"]);
    expect(heartbeat.active).toBe(false);
  });

  it("moves the lease when set again with a new endpoint", async () => {
    const { calls, publisher } = recordingPublisher();
    const heartbeat = makeLiveLeaseHeartbeat(publisher);
    await heartbeat.set(tools);
    await heartbeat.set({ url: "http://127.0.0.1:4200/mcp", bearer: "next" });

    await vi.advanceTimersByTimeAsync(LIVE_LEASE_HEARTBEAT_MS);
    expect(calls).toEqual([
      `set ${tools.url} ttl=60`,
      "set http://127.0.0.1:4200/mcp ttl=60",
      "set http://127.0.0.1:4200/mcp ttl=60",
    ]);
    heartbeat.stop();
  });
});
