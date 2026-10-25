import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AppBinding,
  AppEmbedOrigin,
  AppIconDataUrl,
  AppId,
  AppLiveLeaseInput,
  AppPairingPoll,
  AppRegistration,
  AppStatusStreamEvent,
  AppToolPrefix,
  ConnectedAppThreadData,
  ConnectedAppThreadSummary,
  appGrantFingerprintSource,
} from "./apps.ts";
import { ConnectedAppThreadBundleV1 } from "./appsBundle.ts";
import { ApplicationProjectCreatedPayload } from "./applicationEvent.ts";
import { ServerBootstrapEnvelope } from "./desktopBootstrap.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";

const decodeProjectShell = Schema.decodeUnknownSync(OrchestrationProjectShell);
const decodeProjectCreated = Schema.decodeUnknownSync(ApplicationProjectCreatedPayload);
const decodeBundle = Schema.decodeUnknownSync(ConnectedAppThreadBundleV1);

const is = <S extends Schema.Top>(schema: S) => Schema.is(schema);

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// A PNG data URL whose payload decodes to exactly `bytes` bytes.
const pngOfBytes = (bytes: number) => {
  const prefix = "iVBORw0KGgo";
  const chars = Math.ceil((bytes * 4) / 3);
  const padded = Math.ceil(chars / 4) * 4;
  const padding = padded - chars;
  return `data:image/png;base64,${prefix}${"A".repeat(chars - prefix.length)}${"=".repeat(padding)}`;
};

const registration = {
  appId: "dev.rocketwright.app",
  name: "RocketWright",
  iconDataUrl: PNG_1PX,
  toolPrefix: "rw",
  openUrlTemplate: "rocketwright://open?root={workspaceRoot}&thread={threadId}",
  refPrefixes: ["rw:"],
  headlessTools: {
    command: "/usr/local/bin/rocketwright",
    args: ["mcp", "--project", "{workspaceRoot}"],
    listArgs: ["mcp", "--list-tools", "--project", "{workspaceRoot}"],
    env: { RW_MODE: "headless" },
    cwd: "{workspaceRoot}",
  },
  liveTools: true,
  gatedTools: ["engine_simulate"],
  embedOrigins: ["http://127.0.0.1:*"],
  instructions: "Use rw_ tools for rocket design.",
} as const;

describe("app registration", () => {
  const decode = Schema.decodeUnknownSync(AppRegistration);
  const encode = Schema.encodeSync(AppRegistration);

  it("round-trips a full registration and a minimal one", () => {
    expect(encode(decode(registration))).toEqual(registration);
    const minimal = {
      appId: "com.example.tool",
      name: "Tool",
      iconDataUrl: PNG_1PX,
      toolPrefix: "ex",
      refPrefixes: ["ex:"],
      liveTools: false,
      gatedTools: [],
    };
    expect(encode(decode(minimal))).toEqual(minimal);
  });

  it.each([
    ["missing reverse-DNS dot", { appId: "rocketwright" }],
    ["upper-case app id", { appId: "Dev.RocketWright" }],
    [
      "relative headless command",
      { headlessTools: { ...registration.headlessTools, command: "bin/rw" } },
    ],
    [
      "cwd other than the workspace root",
      { headlessTools: { ...registration.headlessTools, cwd: "/tmp" } },
    ],
    ["no ref prefix", { refPrefixes: [] }],
    ["ref prefix without colon", { refPrefixes: ["rw"] }],
    ["more than 8 ref prefixes", { refPrefixes: Array.from({ length: 9 }, (_, i) => `r${i}:`) }],
    ["name over 64 chars", { name: "x".repeat(65) }],
    ["instructions over 8 KB", { instructions: "é".repeat(4097) }],
  ])("refuses %s", (_label, patch) => {
    expect(() => decode({ ...registration, ...patch })).toThrow();
  });

  it("keeps tool prefixes to 2-12 lower-case alphanumerics", () => {
    expect(["rw", "a1", "abcdefghijkl"].every(is(AppToolPrefix))).toBe(true);
    expect(["r", "rw_", "RW", "abcdefghijklm", "r-w"].some(is(AppToolPrefix))).toBe(false);
  });

  it("bounds app ids at 128 characters", () => {
    expect(is(AppId)(`a.${"b".repeat(126)}`)).toBe(true);
    expect(is(AppId)(`a.${"b".repeat(127)}`)).toBe(false);
  });

  it("caps icons at 64 KB decoded PNG data", () => {
    expect(is(AppIconDataUrl)(PNG_1PX)).toBe(true);
    expect(is(AppIconDataUrl)(pngOfBytes(64 * 1024))).toBe(true);
    expect(is(AppIconDataUrl)(pngOfBytes(64 * 1024 + 1))).toBe(false);
    expect(is(AppIconDataUrl)(PNG_1PX.replace("image/png", "image/jpeg"))).toBe(false);
    // A GIF payload under a PNG media type.
    expect(is(AppIconDataUrl)("data:image/png;base64,R0lGODlhAQABAAAAACw=")).toBe(false);
    expect(is(AppIconDataUrl)(`${PNG_1PX.slice(0, -2)}!!`)).toBe(false);
  });

  it("accepts only loopback embed origins, with an optional port wildcard", () => {
    const accepted = [
      "http://127.0.0.1:*",
      "http://localhost:5173",
      "https://[::1]:8443",
      "http://127.0.0.1:65535",
    ];
    const refused = [
      "http://127.0.0.1",
      "http://example.com:80",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "http://127.0.0.1:5173/",
      "file://localhost:1",
      "http://localhost.evil.com:80",
    ];
    expect(accepted.filter(is(AppEmbedOrigin))).toEqual(accepted);
    expect(refused.filter(is(AppEmbedOrigin))).toEqual([]);
  });

  it("leases only loopback URLs for 5 to 60 seconds", () => {
    const lease = { url: "http://127.0.0.1:4321/mcp", bearer: "secret", ttlSeconds: 60 };
    expect(is(AppLiveLeaseInput)(lease)).toBe(true);
    expect(is(AppLiveLeaseInput)({ ...lease, ttlSeconds: 61 })).toBe(false);
    expect(is(AppLiveLeaseInput)({ ...lease, ttlSeconds: 4 })).toBe(false);
    expect(is(AppLiveLeaseInput)({ ...lease, url: "http://10.0.0.2:4321/mcp" })).toBe(false);
    expect(is(AppLiveLeaseInput)({ ...lease, url: "http://127.0.0.1/mcp" })).toBe(false);
  });
});

describe("grant fingerprint source", () => {
  it("ignores key order and presentation fields", () => {
    const reordered = {
      embedOrigins: registration.embedOrigins,
      headlessTools: {
        cwd: registration.headlessTools.cwd,
        env: registration.headlessTools.env,
        listArgs: registration.headlessTools.listArgs,
        args: registration.headlessTools.args,
        command: registration.headlessTools.command,
      },
    };
    expect(appGrantFingerprintSource(reordered)).toBe(appGrantFingerprintSource(registration));
  });

  it.each([
    [
      "env",
      { ...registration.headlessTools, env: { RW_MODE: "other" } },
      registration.embedOrigins,
    ],
    ["listArgs", { ...registration.headlessTools, listArgs: [] }, registration.embedOrigins],
    ["args", { ...registration.headlessTools, args: ["mcp"] }, registration.embedOrigins],
    ["embed origins", registration.headlessTools, ["http://localhost:*"]],
  ] as const)("changes when %s changes", (_label, headlessTools, embedOrigins) => {
    expect(appGrantFingerprintSource({ headlessTools, embedOrigins })).not.toBe(
      appGrantFingerprintSource(registration),
    );
  });

  it("treats absent embed origins as none", () => {
    expect(appGrantFingerprintSource({})).toBe(appGrantFingerprintSource({ embedOrigins: [] }));
  });
});

describe("app status and pairing", () => {
  it("round-trips a status stream with a pending re-pair request", () => {
    const status = {
      appId: registration.appId,
      name: registration.name,
      iconDataUrl: registration.iconDataUrl,
      toolPrefix: registration.toolPrefix,
      refPrefixes: registration.refPrefixes,
      openUrlTemplate: null,
      state: "revoked",
      live: null,
      lastSeenAt: "2026-10-24T10:00:00.000Z",
      runtimeCeiling: "read-only",
      headlessTools: registration.headlessTools,
      gatedTools: registration.gatedTools,
      embedOrigins: registration.embedOrigins,
      pendingRequest: {
        requestId: "req-1",
        registration,
        requestedAt: "2026-10-24T10:01:00.000Z",
      },
    };
    const codec = AppStatusStreamEvent;
    for (const event of [
      { type: "snapshot", apps: [status] },
      { type: "upsert", app: { ...status, runtimeCeiling: null } },
      { type: "remove", appId: registration.appId },
    ]) {
      expect(Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(event))).toEqual(event);
    }
  });

  it("returns the credential only alongside a state", () => {
    const decode = Schema.decodeUnknownSync(AppPairingPoll);
    expect(decode({ state: "expired" })).toEqual({ state: "expired" });
    const granted = {
      state: "granted",
      credential: { token: "t", expiresAt: "2026-11-23T00:00:00.000Z", environmentId: "env" },
    };
    expect(decode(granted)).toEqual(granted);
    expect(() => decode({ state: "unknown" })).toThrow();
  });

  it("decodes desktop and app sidecar bootstrap envelopes from one union", () => {
    const decode = Schema.decodeUnknownSync(ServerBootstrapEnvelope);
    const sidecar = decode({ mode: "app-sidecar", registration, appSeedToken: "seed" });
    expect(sidecar.mode).toBe("app-sidecar");
    const desktop = decode({
      mode: "desktop",
      noBrowser: true,
      port: 3773,
      host: "127.0.0.1",
      desktopBootstrapToken: "token",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    });
    expect(desktop.mode).toBe("desktop");
    expect(() => decode({ mode: "app-sidecar", registration, appSeedToken: "" })).toThrow();
  });
});

describe("app bindings on projects", () => {
  const shell = {
    id: "project-1",
    title: "Falcon",
    workspaceRoot: "/Users/me/rockets/falcon",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:00:00.000Z",
  };

  it("adds no bytes to projects without an app", () => {
    const codec = OrchestrationProjectShell;
    const encoded = Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(shell));
    expect(JSON.stringify(encoded)).toBe(JSON.stringify(shell));
  });

  it("echoes the bound workspace root verbatim on the shell and the created event", () => {
    const appBinding = { appId: registration.appId, workspaceRoot: "/Users/me/rockets/falcon/" };
    const decodedShell = decodeProjectShell({
      ...shell,
      appBinding,
    });
    expect(decodedShell.appBinding).toEqual(appBinding);
    const created = decodeProjectCreated({
      projectId: shell.id,
      title: shell.title,
      workspaceRoot: shell.workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      createdAt: shell.createdAt,
      updatedAt: shell.updatedAt,
      appBinding,
    });
    expect(created.appBinding).toEqual(appBinding);
    expect(is(AppBinding)({ ...appBinding, workspaceRoot: " /Users/me" })).toBe(false);
  });
});

describe("connected app threads", () => {
  it("caps app data at 1 KB of UTF-8", () => {
    expect(is(ConnectedAppThreadData)("x".repeat(1024))).toBe(true);
    expect(is(ConnectedAppThreadData)("é".repeat(513))).toBe(false);
  });

  it("round-trips a summary of a copied thread", () => {
    const summary = {
      threadId: "copy:env-a:thread-1",
      projectId: "project-1",
      workspaceRoot: "/Users/me/rockets/falcon",
      title: "Fin sizing",
      createdAt: "2026-10-24T10:00:00.000Z",
      updatedAt: "2026-10-24T10:05:00.000Z",
      historyRevision: 42,
      state: "awaiting-approval",
      appData: '{"artifact":"fins"}',
      subtitle: "baseline / 305.23 m",
      copiedFrom: {
        appId: registration.appId,
        sourceEnvironmentId: "env-a",
        sourceThreadId: "thread-1",
        copiedAt: "2026-10-24T10:04:00.000Z",
        sourceHistoryRevision: 40,
      },
    };
    const codec = ConnectedAppThreadSummary;
    expect(Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(summary))).toEqual(summary);
  });

  describe("copy bundle", () => {
    const at = "2026-10-24T10:00:00.000Z";
    const commandItem = {
      id: "item-1",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "command_execution",
      input: "rw simulate",
      output: "apogee 305.23 m",
      status: "completed",
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
    };
    const bundle = {
      version: 1,
      appId: registration.appId,
      sourceEnvironmentId: "env-a",
      exportedAt: at,
      projects: [
        {
          workspaceRoot: "/Users/me/rockets/falcon",
          title: "Falcon",
          threads: [
            {
              sourceThreadId: "thread-1",
              title: "Fin sizing",
              createdAt: at,
              updatedAt: at,
              historyRevision: 7,
              appData: null,
              subtitle: null,
              pinned: true,
              messages: [
                {
                  createdBy: "user",
                  creationSource: "web",
                  id: "message-1",
                  threadId: "thread-1",
                  runId: null,
                  nodeId: null,
                  role: "user",
                  text: "Size the fins",
                  attachments: [],
                  streaming: false,
                  createdAt: at,
                  updatedAt: at,
                },
              ],
              turnItems: [commandItem],
            },
          ],
        },
      ],
      assets: [
        {
          sourceAttachmentId: "card-1",
          mimeType: "text/html",
          byteLength: 4,
          sha256: "a".repeat(64),
          dataBase64: "PHA+",
        },
      ],
    };

    it("round-trips as JSON, so bundles double as fixture files", () => {
      const codec = ConnectedAppThreadBundleV1;
      const decoded = Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(bundle)));
      expect(Schema.encodeSync(codec)(decoded)).toEqual(bundle);
    });

    it("refuses turn items whose output was withheld", () => {
      const withheld = structuredClone(bundle);
      withheld.projects[0]!.threads[0]!.turnItems = [
        { ...commandItem, output: undefined, outputOmitted: true } as never,
      ];
      expect(() => decodeBundle(withheld)).toThrow("full output");
    });

    it("refuses other bundle versions", () => {
      const decode = Schema.decodeUnknownSync(ConnectedAppThreadBundleV1);
      expect(() => decode(bundle)).not.toThrow();
      expect(() => decode({ ...bundle, version: 2 })).toThrow();
    });
  });
});
