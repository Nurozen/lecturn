// Frame scheduling and window focus for the companion runtime, behind one seam so browser
// tests can drive the 30 fps gate, the 20 s settle, and the unfocused pause on an injected
// clock instead of waiting in real time.

export interface CompanionClock {
  /** Milliseconds on the same timeline as the timestamps passed to frame callbacks. */
  now(): number;
  requestFrame(callback: (timestamp: number) => void): number;
  cancelFrame(handle: number): void;
  /** `document.hasFocus()`: window `blur` also fires when focus moves into an iframe or webview. */
  hasFocus(): boolean;
}

const browserClock: CompanionClock = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  hasFocus: () => document.hasFocus(),
};

let clock = browserClock;
const focusListeners = new Set<() => void>();

export function companionClock(): CompanionClock {
  return clock;
}

/** Window focus or blur changed; elements re-read `companionClock().hasFocus()`. */
export function onCompanionFocusChange(listener: () => void): () => void {
  if (focusListeners.size === 0) {
    window.addEventListener("focus", notifyFocusChange);
    window.addEventListener("blur", notifyFocusChange);
  }
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
    if (focusListeners.size === 0) {
      window.removeEventListener("focus", notifyFocusChange);
      window.removeEventListener("blur", notifyFocusChange);
    }
  };
}

export function notifyFocusChange() {
  for (const listener of focusListeners) listener();
}

/** Test seam. Pass `null` to restore the browser clock. */
export function setCompanionClockForTests(next: CompanionClock | null) {
  clock = next ?? browserClock;
}

/**
 * A manual clock for tests: frames fire only from `advance`, at `frameMs` intervals, so a
 * 120 Hz display can be simulated without real time passing.
 */
export function createManualCompanionClock(options: { frameMs?: number; focused?: boolean } = {}) {
  const frameMs = options.frameMs ?? 1000 / 120;
  let time = 0;
  let focused = options.focused ?? true;
  let nextHandle = 1;
  const pending = new Map<number, (timestamp: number) => void>();
  const manual = {
    now: () => time,
    requestFrame(callback: (timestamp: number) => void) {
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    },
    cancelFrame(handle: number) {
      pending.delete(handle);
    },
    hasFocus: () => focused,
    get pendingFrames() {
      return pending.size;
    },
    /** Runs display frames until `ms` have passed. */
    advance(ms: number) {
      const end = time + ms;
      while (time + frameMs <= end + 1e-9) {
        time += frameMs;
        const callbacks = [...pending.values()];
        pending.clear();
        for (const callback of callbacks) callback(time);
      }
      time = end;
    },
    setFocused(next: boolean) {
      focused = next;
      notifyFocusChange();
    },
  } satisfies CompanionClock & Record<string, unknown>;
  return manual;
}
