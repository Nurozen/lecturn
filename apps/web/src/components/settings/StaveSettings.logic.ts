import type { StaveBinarySource, StaveStatus } from "@lecturn/contracts";

const BINARY_SOURCE_LABELS: Readonly<Record<StaveBinarySource, string>> = {
  settings: "from settings",
  env: "from LECTURN_STAVE_PATH",
  bootstrap: "from the desktop bundle",
  bundled: "bundled",
  path: "on PATH",
};

export function formatStaveBinarySource(source: StaveBinarySource): string {
  return BINARY_SOURCE_LABELS[source];
}

export interface StaveStatusSummary {
  /** Headline shown in the Status row control slot. */
  readonly text: string;
  /** Muted secondary line: the binary path, the lookup error, or the query error. */
  readonly detail: string | null;
  /** Monospace detail (a filesystem path) rather than prose. */
  readonly detailIsPath: boolean;
  /** Offer the "Set up" action: a config file is missing on this machine. */
  readonly needsSetup: boolean;
}

/**
 * Reduces `stave.getStatus` (or its absence) to the copy the Status row
 * renders. A query error never throws; it lands on the detail line so the
 * rest of the section stays usable.
 */
export function summarizeStaveStatus(input: {
  readonly status: StaveStatus | null;
  readonly error: string | null;
  readonly isPending: boolean;
}): StaveStatusSummary {
  const { status, error, isPending } = input;
  if (status === null) {
    return isPending || error === null
      ? { text: "Checking…", detail: null, detailIsPath: false, needsSetup: false }
      : { text: "Status unavailable", detail: error, detailIsPath: false, needsSetup: false };
  }

  const needsSetup = !status.configExists;
  if (status.runnable === null) {
    return {
      text: needsSetup ? "Stave is not set up on this machine" : "Stave binary not found",
      detail: error ?? status.runnableError?.message ?? null,
      detailIsPath: false,
      needsSetup,
    };
  }

  if (needsSetup) {
    return {
      text: "Stave is not set up on this machine",
      detail: error ?? status.runnable.path,
      detailIsPath: error === null,
      needsSetup,
    };
  }

  const version = status.runnable.version ?? "unknown version";
  return {
    text: `stave ${version} (${formatStaveBinarySource(status.runnable.source)})`,
    detail: error ?? status.runnable.path,
    detailIsPath: error === null,
    needsSetup: false,
  };
}
