import {
  AcpRegistrySettings,
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GithubCopilotSettings,
  GrokSettings,
  OpenCodeSettings,
  ProviderDriverKind,
} from "@lecturn/contracts";
import { makeProviderClientRegistry } from "@lecturn/provider-core/client";
import { museClient } from "@lecturn/provider-muse/client";
import { piClient } from "@lecturn/provider-pi/client";

/** The provider client definitions this web build ships, in presentation order. */
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  {
    driverKind: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    settingsSchema: CursorSettings,
    environmentFields: [
      {
        name: "CURSOR_API_KEY",
        label: "Cursor API key",
        description: "Optional. Overrides browser sign-in for this provider.",
        placeholder: "Paste API key",
        sensitive: true,
      },
    ],
  },
  {
    driverKind: ProviderDriverKind.make("grok"),
    label: "Grok",
    settingsSchema: GrokSettings,
  },
  {
    // Lecturn: GitHub Copilot stays a built-in provider driver.
    driverKind: ProviderDriverKind.make("githubCopilot"),
    label: "GitHub Copilot",
    badgeLabel: "Early Access",
    settingsSchema: GithubCopilotSettings,
  },
  {
    driverKind: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    settingsSchema: OpenCodeSettings,
  },
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  {
    driverKind: ProviderDriverKind.make("acpRegistry"),
    label: "ACP Registry",
    settingsSchema: AcpRegistrySettings,
    hasDefaultInstance: false,
  },
]);
