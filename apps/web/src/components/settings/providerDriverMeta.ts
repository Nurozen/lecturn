import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  GithubCopilotSettings,
  ProviderDriverKind,
} from "@lecturn/contracts";
import { acpRegistryClient } from "@lecturn/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@lecturn/provider-core/client";
import { cursorClient } from "@lecturn/provider-cursor/client";
import { grokClient } from "@lecturn/provider-grok/client";
import { museClient } from "@lecturn/provider-muse/client";
import { openCodeClient } from "@lecturn/provider-opencode/client";
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
  cursorClient,
  grokClient,
  {
    // Lecturn: GitHub Copilot stays a built-in provider driver.
    driverKind: ProviderDriverKind.make("githubCopilot"),
    label: "GitHub Copilot",
    badgeLabel: "Early Access",
    settingsSchema: GithubCopilotSettings,
  },
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
