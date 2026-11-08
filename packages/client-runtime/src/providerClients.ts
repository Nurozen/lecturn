import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  GithubCopilotSettings,
  isProviderDriverKind,
  ProviderDriverKind,
} from "@lecturn/contracts";
import { acpRegistryClient } from "@lecturn/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@lecturn/provider-core/client";
import { modelShortName } from "@lecturn/provider-core/modelShortName";
import { cursorClient } from "@lecturn/provider-cursor/client";
import { fxClient } from "@lecturn/provider-fx/client";
import { grokClient } from "@lecturn/provider-grok/client";
import { museClient } from "@lecturn/provider-muse/client";
import { openCodeClient } from "@lecturn/provider-opencode/client";
import { piClient } from "@lecturn/provider-pi/client";

export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    modelFamilies: ["GPT-", "GPT "],
    acpRegistryAgentIds: ["codex-acp"],
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    modelFamilies: ["Claude "],
    acpRegistryAgentIds: ["claude-acp"],
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
  fxClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    modelFamilies: ["Gemini "],
    acpRegistryAgentIds: ["antigravity-acp"],
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}

export function resolveModelShortName(
  model: { readonly name: string; readonly shortName?: string | undefined },
  driverKind: ProviderDriverKind | null | undefined,
): string | undefined {
  if (model.shortName) return model.shortName;
  const families = driverKind ? providerClients.get(driverKind)?.modelFamilies : undefined;
  return modelShortName(model.name, families ?? []);
}
