import { describe, expect, it } from "@effect/vitest";
import { buildServerProvider } from "@lecturn/provider-core/server/snapshotProbe";

import { CursorProviderCapabilitiesV2 } from "./adapter.ts";
import { CURSOR_PRESENTATION } from "./status.ts";

// Lecturn: conversationFork parity moved here with the driver; apps/server keeps
// the same check for the drivers it still owns (providerPresentationParity.test.ts).
describe("Cursor conversationFork capability/presentation parity", () => {
  it("presentation matches the adapter capability", () => {
    const conversationFork: string = CURSOR_PRESENTATION.conversationFork;
    expect(conversationFork === "native").toBe(CursorProviderCapabilitiesV2.threads.canForkThread);
  });

  it("snapshot carries conversationFork and no fork anchor requirement", () => {
    const snapshot = buildServerProvider({
      presentation: CURSOR_PRESENTATION,
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
    expect(snapshot.conversationFork).toBe(CURSOR_PRESENTATION.conversationFork);
    expect(snapshot.externalSessions).toBe(CURSOR_PRESENTATION.externalSessions);
    expect(snapshot.conversationForkRequiresAnchor ?? false).toBe(false);
  });
});
