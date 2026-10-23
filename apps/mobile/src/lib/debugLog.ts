export interface DebugLogger {
  readonly isEnabled: () => boolean;
  readonly log: (event: string, data?: Record<string, unknown>) => void;
}

export interface DebugLoggerOptions {
  readonly enabledInDev?: boolean;
  /** Name of a legacy subsystem-specific global boolean, e.g. `"__LECTURN_CLOUD_DEBUG__"`. */
  readonly legacyGlobalFlag?: string;
}

function globalValue(name: string): unknown {
  return typeof globalThis === "undefined"
    ? undefined
    : (globalThis as Record<string, unknown>)[name];
}

export function createDebugLogger(
  namespace: string,
  options: DebugLoggerOptions = {},
): DebugLogger {
  const isEnabled = () => {
    if (options.enabledInDev === true && typeof __DEV__ !== "undefined" && __DEV__) {
      return true;
    }
    if (options.legacyGlobalFlag !== undefined && globalValue(options.legacyGlobalFlag) === true) {
      return true;
    }
    const filter = globalValue("__LECTURN_DEBUG__");
    return filter === true || (Array.isArray(filter) && filter.includes(namespace));
  };
  const log = (event: string, data?: Record<string, unknown>) => {
    if (!isEnabled()) {
      return;
    }
    if (data === undefined) {
      console.log(`[lecturn-${namespace}] ${event}`);
    } else {
      console.log(`[lecturn-${namespace}] ${event}`, data);
    }
  };
  return { isEnabled, log };
}
