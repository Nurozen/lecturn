import { AppId, EnvironmentId, type AppRegistration, type AppStatus } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { APP_STATUS_LABEL, appPairingKind, appStatusPhase, primaryAppStatus } from "./appStatus.ts";

const ICON = "data:image/png;base64,iVBORw0KGgo=";
const LEASE = { expiresAt: "2026-10-25T10:00:30.000Z" };
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

const label = (app: AppStatus) => APP_STATUS_LABEL[appStatusPhase(app)];

describe("appStatusPhase", () => {
  it("reads Running only while the app holds a live lease", () => {
    expect(appStatusPhase(status({ live: LEASE }))).toBe("running");
    expect(label(status({ live: LEASE }))).toBe("Running");
    expect(label(status())).toBe("Closed");
  });

  it("names every grant state", () => {
    expect(label(status({ state: "pairing-requested", pendingRequest: pending() }))).toBe(
      "Pairing requested",
    );
    expect(label(status({ state: "denied" }))).toBe("Denied");
    // A revoked app with a leftover lease still reads as revoked.
    expect(label(status({ state: "revoked", live: LEASE }))).toBe("Revoked");
  });
});

describe("appPairingKind", () => {
  it("is null without a waiting request", () => {
    expect(appPairingKind(status())).toBeNull();
    // A lapsed request leaves the app as last decided, with nothing to answer.
    expect(appPairingKind(status({ state: "denied" }))).toBeNull();
  });

  it("tells a first request from a re-pair after revoke or deny", () => {
    expect(appPairingKind(status({ state: "pairing-requested", pendingRequest: pending() }))).toBe(
      "new",
    );
    // Revoked and denied apps keep their state while they ask again.
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

  it("compares an app without headless tools by its origins alone", () => {
    const app = status({ headlessTools: null, embedOrigins: [] });
    const { headlessTools: _tools, embedOrigins: _origins, ...bare } = registration();
    const ask = (embedOrigins?: ReadonlyArray<string>) => ({
      ...pending(),
      registration: embedOrigins === undefined ? bare : { ...bare, embedOrigins },
    });
    expect(appPairingKind({ ...app, pendingRequest: ask() })).toBe("renew");
    expect(appPairingKind({ ...app, pendingRequest: ask(["http://localhost:5173"]) })).toBe(
      "changed",
    );
  });
});

describe("primaryAppStatus", () => {
  const mac = EnvironmentId.make("mac");
  const server = EnvironmentId.make("server");
  const laptop = EnvironmentId.make("laptop");

  it("is null when no environment reports the app", () => {
    expect(primaryAppStatus([])).toBeNull();
  });

  it("prefers a running app, then a waiting request, then a closed grant", () => {
    const closed = { environmentId: mac, app: status() };
    const asking = {
      environmentId: server,
      app: status({ state: "revoked", pendingRequest: pending() }),
    };
    const runningApp = { environmentId: laptop, app: status({ live: LEASE }) };
    expect(primaryAppStatus([closed, asking, runningApp])).toBe(runningApp);
    expect(primaryAppStatus([closed, asking])).toBe(asking);
    expect(
      primaryAppStatus([{ environmentId: server, app: status({ state: "denied" }) }, closed]),
    ).toBe(closed);
  });

  it("ranks revoked above denied and keeps the first of equals", () => {
    const denied = { environmentId: mac, app: status({ state: "denied" }) };
    const revoked = { environmentId: server, app: status({ state: "revoked" }) };
    expect(primaryAppStatus([denied, revoked])).toBe(revoked);
    const first = { environmentId: mac, app: status() };
    expect(primaryAppStatus([first, { environmentId: server, app: status() }])).toBe(first);
  });
});
