import { describe, expect, it } from "@effect/vitest";
import { buildServerProvider } from "@lecturn/provider-core/server/snapshotProbe";

import { AntigravityProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { CopilotProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CopilotAdapterV2.ts";
import { CursorProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CursorAdapterV2.ts";
import { GrokProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/GrokAdapterV2.ts";
import { OpenCodeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/OpenCodeAdapterV2.ts";
import { ANTIGRAVITY_PRESENTATION } from "./AntigravityProvider.ts";
import { CLAUDE_PRESENTATION } from "./ClaudeProvider.ts";
import { CODEX_PRESENTATION } from "./CodexProvider.ts";
import { COPILOT_PRESENTATION } from "./CopilotProvider.ts";
import { CURSOR_PRESENTATION } from "./CursorProvider.ts";
import { GROK_PRESENTATION } from "./GrokProvider.ts";
import { OPENCODE_PRESENTATION } from "./OpenCodeProvider.ts";

describe("conversationFork capability/presentation parity", () => {
  // Presentation says "native" exactly when the orchestration adapter forks the
  // provider thread itself; every other provider forks through a portable handoff.
  const drivers = [
    {
      driver: "antigravity",
      capabilities: AntigravityProviderCapabilitiesV2,
      presentation: ANTIGRAVITY_PRESENTATION,
    },
    {
      driver: "codex",
      capabilities: CodexProviderCapabilitiesV2,
      presentation: CODEX_PRESENTATION,
    },
    {
      driver: "claudeAgent",
      capabilities: ClaudeProviderCapabilitiesV2,
      presentation: CLAUDE_PRESENTATION,
    },
    {
      driver: "opencode",
      capabilities: OpenCodeProviderCapabilitiesV2,
      presentation: OPENCODE_PRESENTATION,
    },
    {
      driver: "cursor",
      capabilities: CursorProviderCapabilitiesV2,
      presentation: CURSOR_PRESENTATION,
    },
    { driver: "grok", capabilities: GrokProviderCapabilitiesV2, presentation: GROK_PRESENTATION },
    {
      driver: "githubCopilot",
      capabilities: CopilotProviderCapabilitiesV2,
      presentation: COPILOT_PRESENTATION,
    },
  ] as const;

  it.each(drivers)(
    "$driver presentation matches the adapter capability",
    ({ capabilities, presentation }) => {
      expect(presentation.conversationFork === "native").toBe(capabilities.threads.canForkThread);
    },
  );

  it.each(drivers)("$driver snapshot carries conversationFork", ({ presentation }) => {
    const snapshot = buildServerProvider({
      presentation,
      enabled: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "unknown" },
      },
    });
    expect(snapshot.conversationFork).toBe(presentation.conversationFork);
    expect(snapshot.externalSessions).toBe(presentation.externalSessions);
    expect(snapshot.conversationForkRequiresAnchor ?? false).toBe(
      "conversationForkRequiresAnchor" in presentation &&
        presentation.conversationForkRequiresAnchor,
    );
  });

  // Claude is the only provider without a positional fallback for anchor-less
  // turns, so it alone rejects mid-thread forks of pre-anchor history.
  it.each(drivers)("$driver declares its fork anchor requirement", ({ driver, presentation }) => {
    expect(
      "conversationForkRequiresAnchor" in presentation &&
        presentation.conversationForkRequiresAnchor,
    ).toBe(driver === "claudeAgent");
  });
});
