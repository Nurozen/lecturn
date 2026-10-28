import {
  EMBED_MAX_MESSAGE_BYTES,
  EMBED_MAX_PENDING_REQUESTS,
  EMBED_NOT_INITIALIZED_ERROR_CODE,
  type EmbedHostContext,
} from "@lecturn/contracts/embedBridge";
import { NodeId, RuntimeRequestId, type OrchestrationV2ThreadProjection } from "@lecturn/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ThreadRuntimeSummary } from "../state/models.ts";
import { v2Now, v2Projection } from "../state/orchestrationV2TestFixtures.ts";
import { deriveEmbedTurnState, EmbedGuestRequestError, makeEmbedGuest } from "./guest.ts";

const hostContext: EmbedHostContext = {
  theme: "dark",
  displayMode: "inline",
  locale: "en-US",
  styles: { variables: { "--background": "#1b1e20" } },
};

const initializeResult = {
  hostContext,
  hostCapabilities: { experimental: { lecturn: { version: 1 } } },
};

function setup() {
  const posted: Array<Record<string, unknown>> = [];
  const onHostContext = vi.fn();
  const onHostCommand = vi.fn();
  const guest = makeEmbedGuest({
    post: (message) => posted.push(message as Record<string, unknown>),
    onHostContext,
    onHostCommand,
  });
  const answer = (index: number, result: unknown) =>
    guest.receive({ jsonrpc: "2.0", id: posted[index]?.id, result });
  return { guest, posted, onHostContext, onHostCommand, answer };
}

async function initialized() {
  const harness = setup();
  const ready = harness.guest.initialize();
  harness.answer(0, initializeResult);
  await ready;
  return harness;
}

describe("embed guest handshake", () => {
  it("holds its own messages until the host answers ui/initialize, then sends initialized first", async () => {
    const { guest, posted, onHostContext, answer } = setup();
    const ready = guest.initialize();
    guest.notify("lecturn/thread.changed", { threadId: "thread-1" });
    guest.notify("lecturn/turn.state", { threadId: "thread-1", state: "running" });

    expect(posted).toEqual([
      {
        jsonrpc: "2.0",
        id: expect.any(String),
        method: "ui/initialize",
        params: {
          protocolVersion: "2026-01-26",
          appCapabilities: { experimental: { lecturn: { version: 1 } } },
        },
      },
    ]);
    expect(guest.initialize()).toBe(ready);

    answer(0, initializeResult);
    await expect(ready).resolves.toEqual(hostContext);
    expect(onHostContext).toHaveBeenCalledWith(hostContext);
    expect(posted.slice(1).map((message) => message.method)).toEqual([
      "ui/notifications/initialized",
      "lecturn/thread.changed",
      "lecturn/turn.state",
    ]);

    guest.notify("lecturn/thread.changed", { threadId: null });
    expect(posted.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "lecturn/thread.changed",
      params: { threadId: null },
    });
  });

  it("rejects the handshake when the host answers with something that is not a host context", async () => {
    const { guest, posted, answer } = setup();
    const ready = guest.initialize();
    answer(0, { hostContext: { theme: "sepia" } });
    await expect(ready).rejects.toThrow();
    expect(posted.map((message) => message.method)).toEqual(["ui/initialize"]);
  });
});

describe("host messages", () => {
  it("refuses host requests with -32002 and drops host notifications before initialized", () => {
    const { guest, posted, onHostCommand } = setup();
    void guest.initialize();
    guest.receive({ jsonrpc: "2.0", id: 7, method: "lecturn/anything" });
    guest.receive({ jsonrpc: "2.0", method: "lecturn/thread.open", params: { threadId: "t" } });

    expect(posted.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: EMBED_NOT_INITIALIZED_ERROR_CODE, message: expect.any(String) },
    });
    expect(onHostCommand).not.toHaveBeenCalled();
  });

  it("answers unknown host requests after initialized with method-not-found", async () => {
    const { guest, posted } = await initialized();
    guest.receive({ jsonrpc: "2.0", id: "h1", method: "lecturn/anything" });
    expect(posted.at(-1)).toMatchObject({ id: "h1", error: { code: -32601 } });
  });

  it("folds host-context changes into the context and passes host commands on decoded", async () => {
    const { guest, onHostContext, onHostCommand } = await initialized();
    guest.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "light" },
    });
    expect(guest.hostContext()).toEqual({ ...hostContext, theme: "light" });
    expect(onHostContext).toHaveBeenLastCalledWith({ ...hostContext, theme: "light" });

    guest.receive({ jsonrpc: "2.0", method: "lecturn/thread.open", params: { threadId: "t-2" } });
    guest.receive({ jsonrpc: "2.0", method: "lecturn/thread.open", params: { threadId: "" } });
    guest.receive({ jsonrpc: "2.0", method: "lecturn/unknown", params: {} });
    expect(onHostCommand.mock.calls).toEqual([
      [{ method: "lecturn/thread.open", params: { threadId: "t-2" } }],
    ]);
  });

  it("keeps the host's composer placeholder across other changes until the host clears it", async () => {
    const { guest } = await initialized();
    const change = (params: object) =>
      guest.receive({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params });

    change({ composerPlaceholder: "Ask for changes…" });
    change({ theme: "light" });
    expect(guest.hostContext()).toEqual({
      ...hostContext,
      theme: "light",
      composerPlaceholder: "Ask for changes…",
    });

    change({ composerPlaceholder: null });
    expect(guest.hostContext()).toEqual({ ...hostContext, theme: "light" });
    expect(guest.hostContext()).not.toHaveProperty("composerPlaceholder");
  });

  it("ignores messages over the envelope cap", async () => {
    const { guest, onHostCommand } = await initialized();
    guest.receive({
      jsonrpc: "2.0",
      method: "lecturn/composer.setDraft",
      params: { text: "x".repeat(EMBED_MAX_MESSAGE_BYTES) },
    });
    expect(onHostCommand).not.toHaveBeenCalled();
  });
});

describe("guest requests", () => {
  it("queues token.refresh until initialized and resolves with the decoded grant", async () => {
    const { guest, posted, answer } = setup();
    const ready = guest.initialize();
    const refreshed = guest.request("lecturn/token.refresh", {});
    expect(posted).toHaveLength(1);

    answer(0, initializeResult);
    await ready;
    const refreshIndex = posted.findIndex((message) => message.method === "lecturn/token.refresh");
    expect(refreshIndex).toBe(2);
    answer(refreshIndex, { token: "next", expiresAt: "2026-10-25T00:15:00.000Z" });
    await expect(refreshed).resolves.toEqual({
      token: "next",
      expiresAt: "2026-10-25T00:15:00.000Z",
    });
  });

  it("rejects with the host's error code, and on an undecodable result", async () => {
    const { guest, posted } = await initialized();
    const failed = guest.request("lecturn/token.refresh", {});
    guest.receive({
      jsonrpc: "2.0",
      id: posted.at(-1)?.id,
      error: { code: -32603, message: "Could not refresh the embed token." },
    });
    await expect(failed).rejects.toMatchObject({ code: -32603 });

    const malformed = guest.request("lecturn/token.refresh", {});
    guest.receive({ jsonrpc: "2.0", id: posted.at(-1)?.id, result: { token: "" } });
    await expect(malformed).rejects.toThrow();
  });

  it("caps requests in flight and rejects everything pending on dispose", async () => {
    const { guest } = await initialized();
    const inFlight = Array.from({ length: EMBED_MAX_PENDING_REQUESTS }, () =>
      guest.request("lecturn/token.refresh", {}),
    );
    await expect(guest.request("lecturn/token.refresh", {})).rejects.toBeInstanceOf(
      EmbedGuestRequestError,
    );
    guest.dispose();
    const settled = await Promise.allSettled(inFlight);
    expect(settled.every((result) => result.status === "rejected")).toBe(true);
  });
});

describe("deriveEmbedTurnState", () => {
  const idleShell = { runtime: null, hasPendingApprovals: false, hasPendingUserInput: false };
  const runningShell = {
    ...idleShell,
    runtime: { status: "running", activeRunId: null } as unknown as ThreadRuntimeSummary,
  };
  const pendingApproval: OrchestrationV2ThreadProjection = {
    ...v2Projection,
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("approval-1"),
        nodeId: NodeId.make("approval-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "permission",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: v2Now,
        resolvedAt: null,
      },
    ],
  };

  it("reports a pending request over a running turn", () => {
    expect(deriveEmbedTurnState({ projection: pendingApproval, shell: runningShell })).toBe(
      "awaiting-approval",
    );
    expect(deriveEmbedTurnState({ projection: v2Projection, shell: runningShell })).toBe("running");
    expect(deriveEmbedTurnState({ projection: v2Projection, shell: idleShell })).toBe("idle");
  });

  it("falls back to the shell's flags before the thread detail loads", () => {
    expect(
      deriveEmbedTurnState({
        projection: null,
        shell: { ...runningShell, hasPendingUserInput: true },
      }),
    ).toBe("awaiting-approval");
    expect(deriveEmbedTurnState({ projection: null, shell: null })).toBe("idle");
  });
});
