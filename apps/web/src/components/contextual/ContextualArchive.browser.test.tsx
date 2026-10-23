import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@lecturn/contracts";
const mocks = vi.hoisted(() => ({ command: vi.fn(), queries: vi.fn(), refresh: vi.fn() }));
vi.mock(import("../../state/contextual"), async (original) => ({
  ...(await original()),
  contextualEnvironment: {
    sources: (input: unknown) => ({ kind: "sources", input }),
    captureStatus: (input: unknown) => ({ kind: "capture", input }),
    inspect: (input: unknown) => ({ kind: "inspect", input }),
    export: "export",
    forget: "forget",
    downloadExport: "download",
  } as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: { kind: string; input: unknown } | null) => {
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
  }) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((kind: string) => (input: unknown) => mocks.command(kind, input)) as never,
}));
import { ContextualArchive } from "./ContextualArchive";
const environmentId = EnvironmentId.make("host");
let view: { root: Root; container: HTMLDivElement } | undefined;
function button(label: string) {
  return [...view!.container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(label),
  )!;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
const text = () => view!.container.textContent ?? "";
async function renderAndSelect() {
  const container = document.createElement("div");
  document.body.append(container);
  view = { root: createRoot(container), container };
  const { root } = view;
  await act(async () => {
    root.render(<ContextualArchive environmentId={environmentId} />);
  });
  await act(async () => {
    container.querySelector<HTMLInputElement>('input[type="radio"]')!.click();
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  const current = view;
  view = undefined;
  if (current) {
    await act(async () => current.root.unmount());
    current.container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("administrator archive management", () => {
  it("does not read raw exchanges until an explicit bounded source search", async () => {
    await renderAndSelect();
    expect(mocks.queries.mock.calls.some(([atom]) => atom.kind === "inspect")).toBe(false);
    await act(async () => view!.container.querySelector("form")!.requestSubmit());
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
        // lib/utils cannot be partially mocked in the browser (import cycle), so match any UUID.
        actionId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/),
        selection: { kind: "sources", sourceIds: ["slack-source"] },
        expectedSourceGeneration: 4,
        expectedPurgeGeneration: 7,
      },
    });
    expect(text()).toContain("Forget request");
  });
  it("downloads only the completed artifact from the authenticated host command", async () => {
    const anchor = { href: "", download: "", click: vi.fn() };
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
      tag === "a" ? anchor : createElement(tag)) as never);
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
    expect(text()).toContain("not a completed export or deletion");
  });
});
