import type { ComponentProps, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@lecturn/contracts";
const mocks = vi.hoisted(() => ({ command: vi.fn(), queries: vi.fn(), refresh: vi.fn() }));
vi.mock("../../state/contextual", () => ({
  contextualEnvironment: {
    sources: (input: unknown) => ({ kind: "sources", input }),
    captureStatus: (input: unknown) => ({ kind: "capture", input }),
    inspect: (input: unknown) => ({ kind: "inspect", input }),
    export: "export",
    forget: "forget",
    downloadExport: "download",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string; input: unknown } | null) => {
    if (atom) mocks.queries(atom);
    return {
      data:
        atom?.kind === "sources"
          ? {
              sources: [
                { id: "slack-source", label: "Fixture Slack channel", sourceKind: "slack" },
              ],
              nextCursor: null,
            }
          : atom?.kind === "capture"
            ? { sourceGeneration: 4, purgeGeneration: 7 }
            : atom?.kind === "inspect"
              ? {
                  candidates: [],
                  coverage: { complete: true, truncated: false, unexaminedCount: 0 },
                  sourceGeneration: 4,
                  purgeGeneration: 7,
                }
              : null,
      isPending: false,
      error: null,
      refresh: mocks.refresh,
    };
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (kind: string) => (input: unknown) => mocks.command(kind, input),
}));
vi.mock("../../lib/utils", () => ({ randomUUID: () => "action-one" }));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
import { ContextualArchive } from "./ContextualArchive";
const environmentId = EnvironmentId.make("host");
let view: ReactTestRenderer | undefined;
function button(label: string) {
  return view!.root.findAllByType("button").find((node) => node.children.includes(label))!;
}
async function click(label: string) {
  await act(async () => {
    button(label).props.onClick();
  });
}
async function renderAndSelect() {
  await act(async () => {
    view = create(<ContextualArchive environmentId={environmentId} />);
  });
  await act(async () => {
    view!.root
      .findAllByType("input")
      .find((input) => input.props.type === "radio")!
      .props.onChange();
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.command.mockImplementation(async (operation, { input }) => ({
    _tag: "Success",
    value: {
      jobId: "job",
      actionId: input.actionId,
      operation,
      state: "completed",
      sourceGeneration: 4,
      purgeGeneration: 8,
      affectedRecords: 12,
      artifactId: operation === "export" ? "artifact-one" : null,
      updatedAt: "2026-09-26T12:00:00Z",
    },
  }));
});
afterEach(async () => {
  await act(async () => view?.unmount());
  view = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("administrator archive management", () => {
  it("does not read raw exchanges until an explicit bounded source search", async () => {
    await renderAndSelect();
    expect(mocks.queries.mock.calls.some(([atom]) => atom.kind === "inspect")).toBe(false);
    await act(async () => view!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(mocks.queries).toHaveBeenCalledWith({
      kind: "inspect",
      input: { environmentId, input: { query: "", sourceIds: ["slack-source"], limit: 24 } },
    });
    expect(mocks.command).not.toHaveBeenCalled();
  });
  it("requires explicit destructive confirmation and fences forgetting with observed generations", async () => {
    await renderAndSelect();
    await click("Forget this source…");
    expect(mocks.command).not.toHaveBeenCalled();
    await click("Forget stored data");
    expect(mocks.command).toHaveBeenCalledWith("forget", {
      environmentId,
      input: {
        actionId: "action-one",
        selection: { kind: "sources", sourceIds: ["slack-source"] },
        expectedSourceGeneration: 4,
        expectedPurgeGeneration: 7,
      },
    });
    expect(JSON.stringify(view!.toJSON())).toContain("Forget request");
  });
  it("downloads only the completed artifact from the authenticated host command", async () => {
    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor) });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
    vi.useFakeTimers();
    try {
      await renderAndSelect();
      await click("Export this source");
      expect(mocks.command.mock.calls.some(([operation]) => operation === "download")).toBe(false);
      mocks.command.mockResolvedValueOnce({ _tag: "Success", value: new ArrayBuffer(8) });
      await click("Download NDJSON");
      expect(mocks.command).toHaveBeenLastCalledWith("download", {
        environmentId,
        input: { artifactId: "artifact-one" },
      });
      expect(anchor.click).toHaveBeenCalledOnce();
      expect(anchor.download).toBe("lecturn-contextual-artifact-one.ndjson");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it("does not present a running export as downloadable or complete", async () => {
    mocks.command.mockResolvedValueOnce({
      _tag: "Success",
      value: { operation: "export", state: "running", affectedRecords: 0, artifactId: null },
    });
    await renderAndSelect();
    await click("Export this source");
    expect(button("Download NDJSON")).toBeUndefined();
    expect(JSON.stringify(view!.toJSON())).toContain("not a completed export or deletion");
  });
});
