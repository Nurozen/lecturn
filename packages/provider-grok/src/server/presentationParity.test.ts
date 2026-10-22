import { describe, expect, it } from "@effect/vitest";
import { buildServerProvider } from "@lecturn/provider-core/server/snapshotProbe";

import { GrokProviderCapabilitiesV2 } from "./adapter.ts";
import { GROK_PRESENTATION } from "./status.ts";

// Lecturn: conversationFork parity moved here with the driver; apps/server keeps
// the same check for the drivers it still owns (providerPresentationParity.test.ts).
describe("Grok conversationFork capability/presentation parity", () => {
  it("presentation matches the adapter capability", () => {
    const conversationFork: string = GROK_PRESENTATION.conversationFork;
    expect(conversationFork === "native").toBe(GrokProviderCapabilitiesV2.threads.canForkThread);
  });

  it("snapshot carries conversationFork and no fork anchor requirement", () => {
    const snapshot = buildServerProvider({
      presentation: GROK_PRESENTATION,
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
    expect(snapshot.conversationFork).toBe(GROK_PRESENTATION.conversationFork);
    expect(snapshot.externalSessions).toBe(GROK_PRESENTATION.externalSessions);
    expect(snapshot.conversationForkRequiresAnchor ?? false).toBe(false);
  });
});
