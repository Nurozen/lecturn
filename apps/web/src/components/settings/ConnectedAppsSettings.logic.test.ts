import {
  AppId,
  AppsError,
  type AppRegistration,
  type AppStatus,
  type AppsDeleteInput,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appEnvEntries,
  appPairingKind,
  connectedAppActionError,
  connectedAppStatus,
  formatAppCommandLine,
  RUNTIME_CEILING_OPTIONS,
  runtimeCeilingFromKey,
  runtimeCeilingKey,
} from "./ConnectedAppsSettings.logic";

const ICON = "data:image/png;base64,iVBORw0KGgo=";
const TOOLS = {
  command: "/usr/local/bin/rocketwright",
  args: ["mcp", "--project", "{workspaceRoot}"],
  env: { RW_LOG: "info" },
  cwd: "{workspaceRoot}",
} as const;

function registration(overrides: Partial<AppRegistration> = {}): AppRegistration {
  return {
    appId: AppId.make("dev.example.rocket"),
    name: "Rocket",
    iconDataUrl: ICON,
    toolPrefix: "rw",
    refPrefixes: ["rw:"],
    headlessTools: TOOLS,
    liveTools: false,
    gatedTools: ["engine_simulate"],
    embedOrigins: ["http://127.0.0.1:*"],
    ...overrides,
  };
}

function status(overrides: Partial<AppStatus> = {}): AppStatus {
  return {
    appId: AppId.make("dev.example.rocket"),
    name: "Rocket",
    iconDataUrl: ICON,
    toolPrefix: "rw",
    refPrefixes: ["rw:"],
    openUrlTemplate: null,
    state: "granted",
    live: null,
    lastSeenAt: null,
    runtimeCeiling: null,
    headlessTools: TOOLS,
    gatedTools: ["engine_simulate"],
    embedOrigins: ["http://127.0.0.1:*"],
    pendingRequest: null,
    ...overrides,
  };
}

const pending = (overrides: Partial<AppRegistration> = {}) => ({
  requestId: "request-1",
  registration: registration(overrides),
  requestedAt: "2026-10-25T10:00:00.000Z",
});

describe("connectedAppStatus", () => {
  it("reads Running only while the app holds a live lease", () => {
    expect(
      connectedAppStatus(status({ live: { expiresAt: "2026-10-25T10:00:30.000Z" } })),
    ).toMatchObject({ label: "Running", tone: "success" });
    expect(connectedAppStatus(status()).label).toBe("Closed");
  });

  it("names every grant state", () => {
    expect(connectedAppStatus(status({ state: "pairing-requested" })).label).toBe(
      "Pairing requested",
    );
    expect(connectedAppStatus(status({ state: "denied" })).label).toBe("Denied");
    // A revoked app with a leftover lease still reads as revoked.
    expect(
      connectedAppStatus(
        status({ state: "revoked", live: { expiresAt: "2026-10-25T10:00:30.000Z" } }),
      ).label,
    ).toBe("Revoked");
  });
});

describe("appPairingKind", () => {
  it("is null without a waiting request", () => {
    expect(appPairingKind(status())).toBeNull();
  });

  it("tells a first request from a re-pair after revoke or deny", () => {
    expect(appPairingKind(status({ state: "pairing-requested", pendingRequest: pending() }))).toBe(
      "new",
    );
    expect(appPairingKind(status({ state: "revoked", pendingRequest: pending() }))).toBe("repair");
    expect(appPairingKind(status({ state: "denied", pendingRequest: pending() }))).toBe("repair");
  });

  it("flags a request whose command, env or origins differ from the approved ones", () => {
    const changedEnv = pending({ headlessTools: { ...TOOLS, env: { RW_LOG: "debug" } } });
    expect(appPairingKind(status({ state: "pairing-requested", pendingRequest: changedEnv }))).toBe(
      "changed",
    );
    const changedOrigins = pending({ embedOrigins: ["http://localhost:5173"] });
    expect(appPairingKind(status({ state: "granted", pendingRequest: changedOrigins }))).toBe(
      "changed",
    );
    // Key order and absent optional keys are not a change.
    const reordered = pending({
      headlessTools: {
        cwd: "{workspaceRoot}",
        env: { RW_LOG: "info" },
        args: TOOLS.args,
        command: TOOLS.command,
      },
    });
    expect(appPairingKind(status({ state: "granted", pendingRequest: reordered }))).toBe("renew");
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
