import { describe, expect, it } from "vite-plus/test";

import {
  getContextualProviderCapabilities,
  supportsContextualAcceptanceEvidence,
  supportsContextualCompactionSignal,
} from "./ContextualCapabilities.ts";

describe("Contextual receipt evidence policy", () => {
  it("does not turn Grok's successful skipped result into provider acceptance", () => {
    expect(
      supportsContextualAcceptanceEvidence("grok", {
        evidence: "acp-prompt-response",
        promptDispatched: false,
        cancelled: false,
      }),
    ).toBe(false);
  });

  it.each(["cursor", "grok", "antigravity"])(
    "%s requires a real prompt response and rejects locally synthesized cancellation",
    (driver) => {
      const observation = {
        evidence: "acp-prompt-response" as const,
        promptDispatched: true,
        cancelled: false,
      };
      expect(supportsContextualAcceptanceEvidence(driver, observation)).toBe(true);
      expect(
        supportsContextualAcceptanceEvidence(driver, { ...observation, cancelled: true }),
      ).toBe(false);
      expect(
        supportsContextualAcceptanceEvidence(driver, {
          ...observation,
          evidence: "local-dispatched",
        }),
      ).toBe(false);
    },
  );

  it("does not promote local Claude queueing or generic lifecycle events into receipts", () => {
    for (const evidence of ["local-queue", "turn-started", "turn-completed"] as const) {
      expect(
        supportsContextualAcceptanceEvidence("claude", {
          evidence,
          promptDispatched: true,
          cancelled: false,
        }),
      ).toBe(false);
    }
  });

  it("keeps provider proofs scoped to their own driver and rejects unknown drivers", () => {
    const observation = {
      evidence: "opencode-correlated-user-message" as const,
      promptDispatched: true,
      cancelled: false,
    };
    expect(supportsContextualAcceptanceEvidence("opencode", observation)).toBe(true);
    expect(
      supportsContextualAcceptanceEvidence("opencode", {
        ...observation,
        evidence: "opencode-prompt-async-response",
      }),
    ).toBe(false);
    expect(supportsContextualAcceptanceEvidence("codex", observation)).toBe(false);
    expect(supportsContextualAcceptanceEvidence("future-driver", observation)).toBe(false);
    expect(getContextualProviderCapabilities("future-driver").delivery).toBe("unsupported");
  });

  it("recognizes a Codex admission response even if a later cancellation occurs", () => {
    expect(
      supportsContextualAcceptanceEvidence("codex", {
        evidence: "codex-turn-start-response",
        promptDispatched: true,
        cancelled: true,
      }),
    ).toBe(true);
  });

  it("rejects synthetic compaction and another driver's native compaction", () => {
    expect(supportsContextualCompactionSignal("codex", "thread/compacted")).toBe(true);
    expect(supportsContextualCompactionSignal("codex", "item/completed:context_compaction")).toBe(
      true,
    );
    expect(supportsContextualCompactionSignal("codex", "session.compacted")).toBe(false);
    expect(supportsContextualCompactionSignal("cursor", "thread/compacted")).toBe(false);
    expect(supportsContextualCompactionSignal("opencode", "slash-command-completed")).toBe(false);
  });
});

import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@lecturn/contracts";
import {
  contextualCompactionBoundaryKey,
  providerContextIdForSession,
} from "./ContextualCapabilities.ts";

it("extracts native context identity without treating local thread IDs or reconnect as continuity", () => {
  expect(providerContextIdForSession("codex", { threadId: "native" })).toBe("native");
  expect(providerContextIdForSession("claudeAgent", { resume: "native" })).toBe("native");
  expect(providerContextIdForSession("claudeAgent", { threadId: "local" })).toBeNull();
  expect(providerContextIdForSession("cursor", { schemaVersion: 1, sessionId: "native" })).toBe(
    "native",
  );
  expect(
    providerContextIdForSession("cursor", { schemaVersion: 2, sessionId: "native" }),
  ).toBeNull();
  expect(providerContextIdForSession("future", { threadId: "native" })).toBeNull();
});
it("deduplicates native Codex compaction aliases and refuses session-only OpenCode occurrence", () => {
  const event: ProviderRuntimeEvent = {
    type: "thread.state.changed",
    eventId: EventId.make("local-event"),
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("local-thread"),
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { state: "compacted" },
    raw: {
      source: "codex.app-server.notification",
      method: "thread/compacted",
      payload: { threadId: "native", turnId: "native-turn" },
    },
  };
  const alias: ProviderRuntimeEvent = {
    ...event,
    raw: {
      source: "codex.app-server.notification",
      method: "item/completed",
      payload: {
        threadId: "native",
        turnId: "native-turn",
        item: { type: "contextCompaction", id: "native-item" },
      },
    },
  };
  expect(contextualCompactionBoundaryKey(event, "native")).toBe("codex:native:turn:native-turn");
  expect(contextualCompactionBoundaryKey(alias, "native")).toBe(
    contextualCompactionBoundaryKey(event, "native"),
  );
  expect(contextualCompactionBoundaryKey(event, "different")).toBeNull();
  expect(
    contextualCompactionBoundaryKey(
      {
        ...event,
        raw: {
          source: "opencode.sdk.event",
          payload: { type: "session.compacted", properties: { sessionID: "native" } },
        },
        provider: ProviderDriverKind.make("opencode"),
      },
      "native",
    ),
  ).toBeNull();
  expect(contextualCompactionBoundaryKey({ ...event, raw: undefined }, "native")).toBeNull();
});
it("uses Claude native boundary UUID, never the synthetic event identity", () => {
  const event: ProviderRuntimeEvent = {
    type: "thread.state.changed",
    eventId: EventId.make("local-event"),
    provider: ProviderDriverKind.make("claudeAgent"),
    threadId: ThreadId.make("local-thread"),
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { state: "compacted" },
    raw: {
      source: "claude.sdk.message",
      payload: {
        type: "system",
        subtype: "compact_boundary",
        session_id: "native",
        uuid: "boundary",
      },
    },
  };
  expect(contextualCompactionBoundaryKey(event, "native")).toBe("claude:native:boundary");
  expect(
    contextualCompactionBoundaryKey(
      { ...event, eventId: EventId.make("replay-local-event") },
      "native",
    ),
  ).toBe("claude:native:boundary");
});
