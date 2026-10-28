import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  GithubCopilotSettings,
  ProviderDriverKind,
} from "@lecturn/contracts";
import { acpRegistryClient } from "@lecturn/provider-acp-registry/client";
import { makeProviderClientRegistry, type ProviderIcon } from "@lecturn/provider-core/client";
import { cursorClient } from "@lecturn/provider-cursor/client";
import { grokClient } from "@lecturn/provider-grok/client";
import { museClient } from "@lecturn/provider-muse/client";
import { openCodeClient } from "@lecturn/provider-opencode/client";
import { piClient } from "@lecturn/provider-pi/client";
import { SCRIPTED_PROVIDER_EMBLEM } from "@lecturn/shared/providerEmblems";

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

const SCRIPTED_DRIVER = ProviderDriverKind.make("scripted");

/**
 * The scripted driver runs only under LECTURN_TEST_PROVIDERS and is never offered in settings, so
 * it has an icon here but no registry entry.
 */
export function providerDriverIcon(
  driverKind: ProviderDriverKind | undefined,
): ProviderIcon | undefined {
  return driverKind === SCRIPTED_DRIVER
    ? SCRIPTED_PROVIDER_EMBLEM
    : providerClients.get(driverKind)?.icon;
}
