import type { StaveStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatStaveBinarySource, summarizeStaveStatus } from "./StaveSettings.logic";

function makeStatus(overrides: Partial<StaveStatus> = {}): StaveStatus {
  return {
    runnable: {
      path: "/usr/local/bin/stave",
      source: "path",
      version: "0.4.1",
      commit: "abc123",
    },
    runnableError: null,
    configPath: "/home/me/.config/stave/config.yaml",
    configExists: true,
    roots: null,
    marmot: { available: false, version: null },
    lastFailure: null,
    pendingCleanups: [],
    ...overrides,
  };
}

describe("summarizeStaveStatus", () => {
  it("reports a check in progress before any data arrives", () => {
    expect(summarizeStaveStatus({ status: null, error: null, isPending: true })).toEqual({
      text: "Checking…",
      detail: null,
      detailIsPath: false,
      needsSetup: false,
    });
    expect(summarizeStaveStatus({ status: null, error: null, isPending: false }).text).toBe(
      "Checking…",
    );
  });

  it("surfaces a query failure without data as a detail line", () => {
    expect(
      summarizeStaveStatus({ status: null, error: "connection lost", isPending: false }),
    ).toEqual({
      text: "Status unavailable",
      detail: "connection lost",
      detailIsPath: false,
      needsSetup: false,
    });
  });

  it("formats a runnable binary with its version, source, and path", () => {
    expect(summarizeStaveStatus({ status: makeStatus(), error: null, isPending: false })).toEqual({
      text: "stave 0.4.1 (on PATH)",
      detail: "/usr/local/bin/stave",
      detailIsPath: true,
      needsSetup: false,
    });
  });

  it("falls back to 'unknown version' when the binary did not report one", () => {
    const status = makeStatus({
      runnable: { path: "/opt/stave", source: "settings", version: null, commit: null },
    });
    expect(summarizeStaveStatus({ status, error: null, isPending: false }).text).toBe(
      "stave unknown version (from settings)",
    );
  });

  it("labels every binary source", () => {
    expect(formatStaveBinarySource("settings")).toBe("from settings");
    expect(formatStaveBinarySource("env")).toBe("from T3CODE_STAVE_PATH");
    expect(formatStaveBinarySource("bootstrap")).toBe("from the desktop bundle");
    expect(formatStaveBinarySource("bundled")).toBe("bundled");
    expect(formatStaveBinarySource("path")).toBe("on PATH");
  });

  it("reports a missing binary with the lookup error", () => {
    const status = makeStatus({
      runnable: null,
      runnableError: { code: "binary_missing", message: "no stave on PATH" },
    });
    expect(summarizeStaveStatus({ status, error: null, isPending: false })).toEqual({
      text: "Stave binary not found",
      detail: "no stave on PATH",
      detailIsPath: false,
      needsSetup: false,
    });
  });

  it("offers setup when the config file is missing, with or without a binary", () => {
    const withBinary = summarizeStaveStatus({
      status: makeStatus({ configExists: false }),
      error: null,
      isPending: false,
    });
    expect(withBinary).toEqual({
      text: "Stave is not set up on this machine",
      detail: "/usr/local/bin/stave",
      detailIsPath: true,
      needsSetup: true,
    });

    const withoutBinary = summarizeStaveStatus({
      status: makeStatus({ configExists: false, runnable: null, runnableError: null }),
      error: null,
      isPending: false,
    });
    expect(withoutBinary).toEqual({
      text: "Stave is not set up on this machine",
      detail: null,
      detailIsPath: false,
      needsSetup: true,
    });
  });

  it("prefers a refresh error over the binary path when stale data is still shown", () => {
    expect(
      summarizeStaveStatus({ status: makeStatus(), error: "timed out", isPending: false }),
    ).toMatchObject({ text: "stave 0.4.1 (on PATH)", detail: "timed out", detailIsPath: false });
  });
});
