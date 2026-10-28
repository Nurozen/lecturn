// @effect-diagnostics globalTimers:off -- Plain-Promise public API for Electron hosts, which run no Effect runtime.
import { EmbedViewError } from "./errors.ts";
import type { EmbedBridge, EmbedDebuggerSession } from "./mountEmbedView.ts";

export type CapturableEmbedView = Pick<
  EmbedBridge,
  "webContents" | "debuggerSession" | "generation"
>;

export interface CaptureEmbedViewOptions {
  readonly attempts?: number;
  readonly retryDelayMs?: number;
  readonly attemptTimeoutMs?: number;
}

// Same budget as the desktop preview capture (apps/desktop/src/preview/Manager.ts):
// a guest that has not produced its first frame yet answers within a few retries.
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 120;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 1_000;

const BLUR_ACTIVE_ELEMENT =
  "document.activeElement instanceof HTMLElement && document.activeElement.blur()";

// Emulation overrides are per guest, so overlapping captures would undo each other.
const captureQueues = new WeakMap<object, Promise<unknown>>();

/**
 * Captures the guest as a DPR-1 PNG over the bridge's single debugger session.
 * Rejects with EmbedViewError: "guest-gone" when the view closed or crashed,
 * "stale-capture" when the guest navigated, retargeted or switched threads
 * while the capture ran, and "capture-failed" when every attempt failed.
 */
export function captureEmbedView(
  view: CapturableEmbedView,
  options: CaptureEmbedViewOptions = {},
): Promise<Buffer> {
  const previous = captureQueues.get(view.webContents) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => captureNow(view, options));
  captureQueues.set(view.webContents, next);
  return next;
}

async function captureNow(view: CapturableEmbedView, options: CaptureEmbedViewOptions) {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const startGeneration = view.generation;
  const requireCurrentGuest = () => {
    if (view.webContents.isDestroyed()) {
      throw new EmbedViewError("guest-gone", "The embed view was closed.");
    }
    if (view.webContents.isCrashed()) {
      throw new EmbedViewError("guest-gone", "The embed guest renderer is gone.");
    }
    if (view.generation !== startGeneration) {
      throw new EmbedViewError(
        "stale-capture",
        "The embed guest changed while it was being captured; the capture was dropped.",
      );
    }
  };

  requireCurrentGuest();
  // A focused guest takes the app's zoom shortcuts (DesktopWindow.ts), so a
  // stray zoom would otherwise leak into the capture.
  view.webContents.setZoomFactor(1);
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    requireCurrentGuest();
    try {
      const png = await withTimeout(captureOnce(view.debuggerSession), attemptTimeoutMs);
      requireCurrentGuest();
      return png;
    } catch (error) {
      if (error instanceof EmbedViewError && error.reason !== "capture-failed") throw error;
      lastFailure = error;
    }
    if (attempt < attempts) await delay(retryDelayMs);
  }
  requireCurrentGuest();
  throw new EmbedViewError(
    "capture-failed",
    `The embed guest capture failed after ${attempts} attempts.`,
    {
      cause: lastFailure,
    },
  );
}

async function captureOnce(session: EmbedDebuggerSession): Promise<Buffer> {
  await session.send("Runtime.evaluate", { expression: BLUR_ACTIVE_ELEMENT });
  const { width, height } = readViewportSize(await session.send("Page.getLayoutMetrics"));
  if (width === 0 || height === 0) {
    throw new EmbedViewError("capture-failed", "The embed guest has not laid out yet.");
  }
  await session.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  try {
    const result = await session.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const data = isRecord(result) && typeof result["data"] === "string" ? result["data"] : "";
    if (data.length === 0) {
      throw new EmbedViewError("capture-failed", "The embed guest returned an empty frame.");
    }
    return Buffer.from(data, "base64");
  } finally {
    await session.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
  }
}

function readViewportSize(metrics: unknown): { width: number; height: number } {
  const viewport = isRecord(metrics) ? metrics["cssLayoutViewport"] : undefined;
  if (!isRecord(viewport)) return { width: 0, height: 0 };
  const width = viewport["clientWidth"];
  const height = viewport["clientHeight"];
  return {
    width: typeof width === "number" ? Math.round(width) : 0,
    height: typeof height === "number" ? Math.round(height) : 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function withTimeout<A>(promise: Promise<A>, timeoutMs: number): Promise<A> {
  return new Promise<A>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new EmbedViewError(
            "capture-failed",
            `A capture attempt timed out after ${timeoutMs} ms.`,
          ),
        ),
      timeoutMs,
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
