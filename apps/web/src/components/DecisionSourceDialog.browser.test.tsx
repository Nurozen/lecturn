import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Schema } from "effect";
import {
  EnvironmentId,
  ProjectId,
  ThreadDecisionSourceWindowResult,
  DecisionEvidence,
  type ThreadDecision,
} from "@lecturn/contracts";
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), close: vi.fn(), source: null as unknown }));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => mocks.navigate) as never,
}));
vi.mock(import("../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: mocks.source, error: null, isPending: false })) as never,
}));
vi.mock(import("../state/threadDecisions"), async (original) => ({
  ...(await original()),
  threadDecisionEnvironment: { sourceWindow: () => null } as never,
}));
import { DecisionSourceDialog } from "./DecisionSourceDialog";
import { assistantCitationFromLocation } from "../lib/assistantCitationNavigation";
const environmentId = EnvironmentId.make("remote"),
  projectId = ProjectId.make("project");
const evidence = Schema.decodeUnknownSync(DecisionEvidence)({
  id: "e",
  threadId: "thread",
  messageId: "message",
  messageRole: "user",
  sourceHash: "hash",
  sourceGeneration: 0,
  canonicalVersion: "1",
  quote: "Use\nPostgres",
  start: 0,
  end: 12,
  prefix: "",
  suffix: "",
  occurrence: 0,
  availability: "available",
});
const source = Schema.decodeUnknownSync(ThreadDecisionSourceWindowResult)({
  outcome: "exact",
  threadId: "thread",
  messageId: "message",
  messages: [
    { id: "message", role: "user", text: "Use\r\nPostgres", createdAt: "2026-09-23T00:00:00Z" },
  ],
  start: 0,
  end: 13,
  reason: null,
});
const note = { id: "decision", title: "Use Postgres" } as ThreadDecision;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
// The dialog renders in a portal, so queries read the document rather than the container.
async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <DecisionSourceDialog
        environmentId={environmentId}
        projectId={projectId}
        note={note}
        evidence={evidence}
        onClose={mocks.close}
      />,
    );
  });
  return async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}
function openSourceButton() {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Open source thread",
  );
}
describe("source thread activation", () => {
  it("preserves the exact raw excerpt and targets its message without rendered-text coordinates", async () => {
    mocks.navigate.mockClear();
    mocks.source = source;
    const unmount = await render();
    expect(document.querySelectorAll("mark")).toHaveLength(1);
    await act(async () => openSourceButton()!.click());
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: "thread" },
        hash: expect.stringContaining("assistant-citation="),
      }),
    );
    expect(
      assistantCitationFromLocation("#" + mocks.navigate.mock.calls[0]![0].hash),
    ).toMatchObject({ coordinateSpace: "raw-message", messageId: "message", text: evidence.quote });
    expect(mocks.close).toHaveBeenCalled();
    await unmount();
  });
  it("targets a nonexact source message and never offers a jump for unavailable evidence", async () => {
    mocks.navigate.mockClear();
    mocks.source = { ...source, outcome: "message-only", start: null, end: null };
    const unmount = await render();
    expect(document.querySelectorAll("mark")).toHaveLength(0);
    await act(async () => openSourceButton()!.click());
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: "thread" },
        hash: expect.stringContaining("assistant-citation="),
      }),
    );
    await unmount();
    mocks.source = { ...source, outcome: "unavailable", messages: [], start: null, end: null };
    const unmountMissing = await render();
    expect(openSourceButton()).toBeUndefined();
    await unmountMissing();
  });
});
