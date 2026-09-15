import { afterEach, assert, it, vi } from "vite-plus/test";
import { createShellEnvironmentDetector, SHELL_DETECTION_TIMEOUT_MS } from "./shellEnvironment.ts";

afterEach(() => vi.useRealTimers());

it("shares one pending probe without blocking callers and preserves inherited environment", async () => {
  const env = { PATH: "/usr/bin", SHELL: "/bin/zsh", SSH_AUTH_SOCK: "/existing.sock" };
  let finish!: (value: Record<string, string>) => void;
  const probe = vi.fn(
    () =>
      new Promise<Record<string, string>>((resolve) => {
        finish = resolve;
      }),
  );
  const detector = createShellEnvironmentDetector(env, "darwin", probe);
  const first = detector.detect();
  assert.equal(detector.getStatus(), "pending");
  assert.equal(detector.detect({ retry: true }), first);
  assert.equal(probe.mock.calls.length, 1);
  finish({ PATH: "/opt/homebrew/bin:/usr/bin", SSH_AUTH_SOCK: "/shell.sock" });
  assert.equal((await first).status, "ready");
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
  assert.equal(env.SSH_AUTH_SOCK, "/existing.sock");
});

it("allows a slow profile beyond the previous five-second limit", async () => {
  vi.useFakeTimers();
  let finish!: (value: Record<string, string>) => void;
  const detector = createShellEnvironmentDetector(
    { PATH: "/usr/bin" },
    "darwin",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = detector.detect();
  await vi.advanceTimersByTimeAsync(6_000);
  assert.equal(detector.getStatus(), "pending");
  finish({ PATH: "/opt/homebrew/bin" });
  assert.equal((await pending).status, "ready");
});

it("refreshes a previously successful but incomplete PATH on explicit retry", async () => {
  const env = { PATH: "/usr/bin" };
  const probe = vi
    .fn()
    .mockResolvedValueOnce({ PATH: "/usr/bin" })
    .mockResolvedValueOnce({ PATH: "/new/bin:/usr/bin" });
  const detector = createShellEnvironmentDetector(env, "darwin", probe);
  await detector.detect();
  await detector.detect();
  assert.equal(probe.mock.calls.length, 1);
  await detector.detect({ retry: true });
  assert.equal(probe.mock.calls.length, 2);
  assert.equal(env.PATH, "/new/bin:/usr/bin");
});

it("aborts at the shared deadline, retries once, and rejects stale environment results", async () => {
  vi.useFakeTimers();
  const env = { PATH: "/usr/bin" };
  let late!: (value: Record<string, string>) => void;
  let signal: AbortSignal | undefined;
  const detector = createShellEnvironmentDetector(env, "darwin", (_shell, _names, nextSignal) => {
    signal = nextSignal;
    return new Promise((resolve) => {
      late = resolve;
    });
  });
  const first = detector.detect();
  await vi.advanceTimersByTimeAsync(SHELL_DETECTION_TIMEOUT_MS);
  assert.equal((await first).status, "timed-out");
  assert.equal(signal?.aborted, true);
  const oldFinish = late;
  const retry = detector.detect({ retry: true });
  assert.equal(detector.detect({ retry: true }), retry);
  late({ PATH: "/opt/homebrew/bin" });
  assert.equal((await retry).status, "ready");
  oldFinish({ PATH: "/stale/bin" });
  await Promise.resolve();
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
  assert.equal(detector.getStatus(), "ready");
});
