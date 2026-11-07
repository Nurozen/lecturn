import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render as renderUi, type Screen } from "../../../test/render";
const mocks = vi.hoisted(() => ({ list: vi.fn(), revoke: vi.fn() }));
vi.mock(import("../../cloud/decisionFundingAccounts"), async (original) => ({
  ...(await original()),
  decisionFundingAccountsClient: (() => mocks) as never,
}));
import { DecisionFundingAccounts } from "./DecisionFundingAccounts";
const row = { environmentId: "host-a", environmentLabel: "My workstation", generation: 7 };
let container: HTMLDivElement;

let testScreen: Screen;

async function setup(): Promise<AsyncDisposable> {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ environments: [row], nextCursor: null });
  mocks.revoke.mockResolvedValue({ state: "revoked" });
  container = document.createElement("div");
  document.body.append(container);
  testScreen = await renderUi(null, { container, router: false });
  return {
    async [Symbol.asyncDispose]() {
      await testScreen[Symbol.asyncDispose]();
    },
  };
}
async function render(element: ReactElement) {
  await testScreen.rerender(element);
}
const buttons = () => [...container.querySelectorAll("button")];
async function click(label: string) {
  const button = buttons().find((item) => item.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
describe("account funding reverse action", () => {
  it("requires confirmation, revokes the displayed generation, and removes the host only after success", async () => {
    await using _setup = await setup();
    await render(<DecisionFundingAccounts accountId="payer-a" />);
    await vi.waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith("payer-a", undefined, expect.any(AbortSignal)),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("My workstation"));
    await click("Stop funding");
    expect(mocks.revoke).not.toHaveBeenCalled();
    await click("Confirm stop funding");
    expect(mocks.revoke).toHaveBeenCalledWith(
      "payer-a",
      { environmentId: "host-a", expectedGeneration: 7 },
      expect.any(AbortSignal),
    );
    await vi.waitFor(() =>
      expect(buttons().some((b) => b.textContent === "Stop funding")).toBe(false),
    );
  });
  it("aborts old account requests and clears its pending confirmation when account selection changes", async () => {
    await using _setup = await setup();
    await render(<DecisionFundingAccounts accountId="payer-a" />);
    await vi.waitFor(() => expect(container.textContent).toContain("My workstation"));
    const signal = mocks.list.mock.calls[0]![2] as AbortSignal;
    await click("Stop funding");
    mocks.list.mockResolvedValueOnce({ environments: [], nextCursor: null });
    await render(<DecisionFundingAccounts accountId="payer-b" />);
    expect(signal.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith("payer-b", undefined, expect.any(AbortSignal)),
    );
    expect(buttons().some((b) => b.textContent === "Confirm stop funding")).toBe(false);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("retains the host and shows recovery when generation changed", async () => {
    await using _setup = await setup();
    mocks.revoke.mockRejectedValueOnce(new Error("conflict"));
    await render(<DecisionFundingAccounts accountId="payer-a" />);
    await vi.waitFor(() => expect(container.textContent).toContain("My workstation"));
    await click("Stop funding");
    await click("Confirm stop funding");
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Refresh"),
    );
    expect(
      [...container.querySelectorAll("p")].some((p) => p.textContent === "My workstation"),
    ).toBe(true);
  });
});
