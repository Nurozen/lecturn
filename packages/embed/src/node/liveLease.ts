// @effect-diagnostics globalTimers:off -- Promise API for hosts that run no Effect runtime.

/**
 * Three beats fit in one lease, so a single missed beat (a busy event loop, a
 * socket reconnect) never reads as the app closing, while a crashed app reads
 * as closed within a minute.
 */
export const LIVE_LEASE_HEARTBEAT_MS = 20_000;
export const LIVE_LEASE_TTL_SECONDS = 60;

export interface LiveTools {
  /** The app's loopback Streamable-HTTP MCP endpoint. */
  readonly url: string;
  /** Lecturn sends it on every live call; the endpoint should refuse anything else. */
  readonly bearer: string;
}

export interface LiveLeasePublisher {
  readonly setLease: (input: {
    readonly url: string;
    readonly bearer: string;
    readonly ttlSeconds: number;
  }) => Promise<unknown>;
  readonly clearLease: () => Promise<unknown>;
}

export interface LiveLeaseHeartbeat {
  /** Resolves once the first lease is held; rejects if Lecturn refuses it. */
  set(tools: LiveTools): Promise<void>;
  clear(): Promise<void>;
  /** Stops beating without telling Lecturn; the lease then lapses on its own. */
  stop(): void;
  readonly active: boolean;
}

export function makeLiveLeaseHeartbeat(
  publisher: LiveLeasePublisher,
  options: { readonly intervalMs?: number; readonly ttlSeconds?: number } = {},
): LiveLeaseHeartbeat {
  const intervalMs = options.intervalMs ?? LIVE_LEASE_HEARTBEAT_MS;
  const ttlSeconds = options.ttlSeconds ?? LIVE_LEASE_TTL_SECONDS;
  let current: LiveTools | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Every publish runs in order, so a beat still in flight can never land
  // after a clear and reopen the lease.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <A>(operation: () => Promise<A>): Promise<A> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  };

  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const beat = (tools: LiveTools) =>
    enqueue(() =>
      current === tools
        ? publisher.setLease({ url: tools.url, bearer: tools.bearer, ttlSeconds })
        : Promise.resolve(),
    );

  return {
    get active() {
      return current !== null;
    },
    set: async (tools) => {
      stopTimer();
      current = tools;
      try {
        await beat(tools);
      } catch (error) {
        if (current === tools) current = null;
        throw error;
      }
      if (current !== tools) return;
      timer = setInterval(() => {
        // A failed beat is retried by the next one; only three in a row close the app.
        beat(tools).catch(() => undefined);
      }, intervalMs);
      // The heartbeat alone must not keep a host process alive.
      timer.unref?.();
    },
    clear: async () => {
      stopTimer();
      if (current === null) return;
      current = null;
      await enqueue(() => publisher.clearLease());
    },
    stop: () => {
      stopTimer();
      current = null;
    },
  };
}
