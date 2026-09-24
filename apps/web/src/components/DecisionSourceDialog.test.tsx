import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import { Schema } from "effect";
import {
  EnvironmentId,
  ProjectId,
  ThreadDecisionSourceWindowResult,
  DecisionEvidence,
  type ThreadDecision,
} from "@lecturn/contracts";
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), close: vi.fn(), source: null as unknown }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: mocks.source, error: null, isPending: false }),
}));
vi.mock("../state/threadDecisions", () => ({
  threadDecisionEnvironment: { sourceWindow: () => null },
}));
vi.mock("./ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("./ui/dialog", () => {
  const Box = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Box,
    DialogPopup: Box,
    DialogHeader: Box,
    DialogTitle: Box,
    DialogDescription: Box,
    DialogPanel: Box,
  };
});
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
async function render() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <DecisionSourceDialog
        environmentId={environmentId}
        projectId={projectId}
        note={note}
        evidence={evidence}
        onClose={mocks.close}
      />,
    );
  });
  return renderer;
}
describe("source thread activation", () => {
  it("preserves the exact raw excerpt and targets its message without rendered-text coordinates", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.navigate.mockClear();
    mocks.source = source;
    const renderer = await render();
    expect(renderer.root.findAllByType("mark")).toHaveLength(1);
    await act(async () => renderer.root.findByType("button").props.onClick());
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
    await act(async () => renderer.unmount());
  });
  it("targets a nonexact source message and never offers a jump for unavailable evidence", async () => {
    mocks.navigate.mockClear();
    mocks.source = { ...source, outcome: "message-only", start: null, end: null };
    const renderer = await render();
    expect(renderer.root.findAllByType("mark")).toHaveLength(0);
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: "thread" },
        hash: expect.stringContaining("assistant-citation="),
      }),
    );
    await act(async () => renderer.unmount());
    mocks.source = { ...source, outcome: "unavailable", messages: [], start: null, end: null };
    const missing = await render();
    expect(missing.root.findAllByType("button")).toHaveLength(0);
    await act(async () => missing.unmount());
  });
});
