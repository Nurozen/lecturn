import { createDebugLogger } from "../../lib/debugLog";

/**
 * Debug logging for the mobile terminal pipeline. Prefix: `[lecturn-terminal]`.
 *
 * Enabled when `__DEV__` is true, or set `globalThis.__LECTURN_TERMINAL_DEBUG__`
 * (or the shared `globalThis.__LECTURN_DEBUG__` filter) in a JS debugger / Metro
 * console to trace release/TestFlight builds.
 */
const logger = createDebugLogger("terminal", {
  enabledInDev: true,
  legacyGlobalFlag: "__LECTURN_TERMINAL_DEBUG__",
});

export function terminalDebugLog(message: string, data?: Record<string, unknown>): void {
  logger.log(message, data);
}
