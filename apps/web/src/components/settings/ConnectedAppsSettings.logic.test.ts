import { AppId, AppsError, type AppStatus, type AppsDeleteInput } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appEnvEntries,
  connectedAppAccess,
  connectedAppActionError,
  connectedAppStatus,
  formatAppCommandLine,
  RUNTIME_CEILING_OPTIONS,
  runtimeCeilingFromKey,
  runtimeCeilingKey,
} from "./ConnectedAppsSettings.logic";

const LEASE = { expiresAt: "2026-10-25T10:00:30.000Z" };

describe("connectedAppStatus", () => {
  it("gives each status its badge tone", () => {
    const tone = (app: Pick<AppStatus, "state" | "live">) => connectedAppStatus(app).tone;
    expect(connectedAppStatus({ state: "granted", live: LEASE })).toEqual({
      label: "Running",
      tone: "success",
    });
    expect(tone({ state: "granted", live: null })).toBe("muted");
    expect(tone({ state: "pairing-requested", live: null })).toBe("warning");
    expect(tone({ state: "denied", live: null })).toBe("error");
    expect(tone({ state: "revoked", live: LEASE })).toBe("error");
  });
});

describe("connectedAppAccess", () => {
  const app = {
    name: "Embed Host",
    toolPrefix: "ex",
    headlessTools: null,
    embedOrigins: [],
  } satisfies Omit<Parameters<typeof connectedAppAccess>[0], "gatedTools">;
  const gated = (gatedTools: ReadonlyArray<string>) =>
    connectedAppAccess({ ...app, gatedTools }).find((line) => line.title === "Gated tools");

  it("names gated tools as agents call them, with the verb agreeing", () => {
    expect(gated(["window_flash"])?.detail).toBe(
      "ex_window_flash follows the runtime ceiling below.",
    );
    expect(gated(["window_flash", "counter_reset"])?.detail).toBe(
      "ex_window_flash, ex_counter_reset follow the runtime ceiling below.",
    );
    expect(gated([])).toBeUndefined();
  });
});

describe("runtime ceiling", () => {
  it("offers no ceiling and Read-only alongside every runtime mode", () => {
    expect(RUNTIME_CEILING_OPTIONS.map((option) => option.key)).toEqual([
      "none",
      "read-only",
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
  });

  it("round-trips null and every access level through the select key", () => {
    for (const option of RUNTIME_CEILING_OPTIONS) {
      expect(runtimeCeilingKey(runtimeCeilingFromKey(option.key))).toBe(option.key);
    }
    expect(runtimeCeilingFromKey("none")).toBeNull();
    expect(runtimeCeilingFromKey("read-only")).toBe("read-only");
  });
});

describe("pinned command", () => {
  it("quotes only the arguments a shell would split or expand", () => {
    expect(
      formatAppCommandLine({
        command: "/Applications/Rocket Wright.app/bin/rw",
        args: ["mcp", "--project", "{workspaceRoot}", "it's", "$HOME", ""],
      }),
    ).toBe(
      `'/Applications/Rocket Wright.app/bin/rw' mcp --project {workspaceRoot} 'it'\\''s' '$HOME' ''`,
    );
  });

  it("lists env in a stable order", () => {
    expect(appEnvEntries({ env: { ZED: "1", ALPHA: "two words" } })).toEqual([
      ["ALPHA", "two words"],
      ["ZED", "1"],
    ]);
    expect(appEnvEntries({})).toEqual([]);
  });
});

describe("connectedAppActionError", () => {
  const deleteInput = (deleteThreads: boolean): AppsDeleteInput => ({
    appId: AppId.make("dev.example.rocket"),
    deleteThreads,
  });

  it("explains that a server without thread deletion removed nothing", () => {
    const error = new AppsError({ code: "unavailable", message: "delete with deleteThreads" });
    const message = connectedAppActionError("delete", error, deleteInput(true));
    expect(message).toContain("cannot delete an app's threads yet");
    expect(message).toContain("Nothing was removed");
  });

  it("passes other server messages through and falls back per action", () => {
    const conflict = new AppsError({ code: "conflict", message: "Tool prefix taken." });
    expect(connectedAppActionError("approve", conflict)).toBe("Tool prefix taken.");
    const unavailable = new AppsError({ code: "unavailable", message: "Storage failed." });
    expect(connectedAppActionError("delete", unavailable, deleteInput(false))).toBe(
      "Storage failed.",
    );
    expect(connectedAppActionError("revoke", null)).toBe("Could not revoke the app.");
  });
});
