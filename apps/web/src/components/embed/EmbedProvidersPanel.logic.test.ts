import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveEmbedProviderRows, resolveEmbedDefaultModel } from "./EmbedProvidersPanel.logic";

const provider = (driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-25T00:00:00Z",
  models: [
    { slug: `${driver}-default`, name: "Default", isCustom: false, capabilities: null },
    { slug: `${driver}-other`, name: "Other", isCustom: false, capabilities: null },
  ],
  skills: [],
  slashCommands: [],
  ...overrides,
});

const withSetup = { canAuthenticate: true, canInstall: true } as const;

describe("deriveEmbedProviderRows", () => {
  it("lists only enabled providers, with the account a ready one is signed in as", () => {
    const rows = deriveEmbedProviderRows([
      provider("codex", { auth: { status: "authenticated", email: "pilot@example.com" } }),
      provider("cursor", { enabled: false, status: "disabled" }),
      provider("opencode", { discovery: { status: "detecting", phase: "provider" } }),
    ]);
    expect(
      rows.map(({ instanceId, state, detail, account }) => ({
        instanceId,
        state,
        detail,
        account,
      })),
    ).toEqual([
      { instanceId: "codex", state: "ready", detail: null, account: "pilot@example.com" },
      { instanceId: "opencode", state: "checking", detail: null, account: null },
    ]);
  });

  it("keeps the provider's own CLI sign-in instruction", () => {
    const [row] = deriveEmbedProviderRows([
      provider("claudeAgent", {
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Claude Code is not signed in. Run `claude auth login` and try again.",
        setup: withSetup,
      }),
    ]);
    expect(row).toMatchObject({
      state: "signed-out",
      detail: "Claude Code is not signed in. Run `claude auth login` and try again.",
    });
  });

  it("never points at Lecturn's provider setup, which the embed does not have", () => {
    const rows = deriveEmbedProviderRows([
      provider("codex", { status: "error", auth: { status: "unauthenticated" }, setup: withSetup }),
      provider("githubCopilot", {
        installed: false,
        status: "error",
        auth: { status: "unknown" },
        setup: withSetup,
      }),
      provider("grok", { status: "error", auth: { status: "unauthenticated" } }),
    ]);
    expect(rows.map(({ state, detail }) => ({ state, detail }))).toEqual([
      { state: "signed-out", detail: "Sign in via the CLI to authenticate again." },
      {
        state: "not-installed",
        detail: "Install GitHub Copilot on this computer, then check again.",
      },
      { state: "signed-out", detail: "Sign in via the CLI to authenticate again." },
    ]);
    expect(rows.some((row) => row.detail?.includes("provider setup"))).toBe(false);
  });

  it("flags a usable provider with a status problem, but not Antigravity's unchecked sign-in", () => {
    const rows = deriveEmbedProviderRows([
      provider("codex", { status: "warning", message: "Codex is rate limited." }),
      provider("antigravity", { status: "warning", auth: { status: "unknown" } }),
    ]);
    expect(rows.map(({ state, detail }) => ({ state, detail }))).toEqual([
      { state: "attention", detail: "Codex is rate limited." },
      { state: "ready", detail: null },
    ]);
  });
});

describe("resolveEmbedDefaultModel", () => {
  const projectId = ProjectId.make("project-rocket");
  const providers = [provider("codex"), provider("claudeAgent")];
  const claude = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claudeAgent-other",
  };

  it("reads the project's own default and says it can be reset", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsFolded: true,
      projectSettingsOverrides: { [projectId]: { defaultModelSelection: claude } },
    };
    expect(resolveEmbedDefaultModel({ settings, projectId, project: null, providers })).toEqual({
      selection: claude,
      projectOverride: true,
    });
  });

  it("falls back to the environment default when the project names none", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsFolded: true,
      defaultModelSelection: claude,
      projectSettingsOverrides: {
        [ProjectId.make("project-other")]: {
          defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "x" },
        },
      },
    };
    expect(resolveEmbedDefaultModel({ settings, projectId, project: null, providers })).toEqual({
      selection: claude,
      projectOverride: false,
    });
  });

  it("shows what a new thread would really start with when the default provider is off", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsFolded: true,
      projectSettingsOverrides: { [projectId]: { defaultModelSelection: claude } },
    };
    const claudeOff = [
      provider("codex"),
      provider("claudeAgent", { enabled: false, status: "disabled" }),
    ];
    expect(
      resolveEmbedDefaultModel({ settings, projectId, project: null, providers: claudeOff })
        .selection?.instanceId,
    ).toBe("codex");
    expect(
      resolveEmbedDefaultModel({ settings, projectId, project: null, providers: [] }).selection,
    ).toBeNull();
  });
});
