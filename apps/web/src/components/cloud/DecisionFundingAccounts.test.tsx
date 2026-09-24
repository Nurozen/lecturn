import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ list: vi.fn(), revoke: vi.fn() }));
vi.mock("../../cloud/decisionFundingAccounts", () => ({
  decisionFundingAccountsClient: () => mocks,
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
import { DecisionFundingAccounts } from "./DecisionFundingAccounts";
const row = { environmentId: "host-a", environmentLabel: "My workstation", generation: 7 };
async function click(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((item) => item.children.join("") === label);
  expect(button).toBeDefined();
  await act(async () => {
    await button!.props.onClick();
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.list.mockResolvedValue({ environments: [row], nextCursor: null });
  mocks.revoke.mockResolvedValue({ state: "revoked" });
});
describe("account funding reverse action", () => {
  it("requires confirmation, revokes the displayed generation, and removes the host only after success", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DecisionFundingAccounts accountId="payer-a" />);
    });
    expect(mocks.list).toHaveBeenCalledWith("payer-a", undefined, expect.any(AbortSignal));
    await click(renderer, "Stop funding");
    expect(mocks.revoke).not.toHaveBeenCalled();
    await click(renderer, "Confirm stop funding");
    expect(mocks.revoke).toHaveBeenCalledWith(
      "payer-a",
      { environmentId: "host-a", expectedGeneration: 7 },
      expect.any(AbortSignal),
    );
    expect(
      renderer.root.findAllByType("button").some((b) => b.children.join("") === "Stop funding"),
    ).toBe(false);
    await act(async () => renderer.unmount());
  });
  it("aborts old account requests and clears its pending confirmation when account selection changes", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DecisionFundingAccounts accountId="payer-a" />);
    });
    const signal = mocks.list.mock.calls[0]![2] as AbortSignal;
    await click(renderer, "Stop funding");
    mocks.list.mockResolvedValueOnce({ environments: [], nextCursor: null });
    await act(async () => renderer.update(<DecisionFundingAccounts accountId="payer-b" />));
    expect(signal.aborted).toBe(true);
    expect(mocks.list).toHaveBeenLastCalledWith("payer-b", undefined, expect.any(AbortSignal));
    expect(
      renderer.root
        .findAllByType("button")
        .some((b) => b.children.join("") === "Confirm stop funding"),
    ).toBe(false);
    expect(mocks.revoke).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
  it("retains the host and shows recovery when generation changed", async () => {
    mocks.revoke.mockRejectedValueOnce(new Error("conflict"));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DecisionFundingAccounts accountId="payer-a" />);
    });
    await click(renderer, "Stop funding");
    await click(renderer, "Confirm stop funding");
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("Refresh");
    expect(
      renderer.root.findAllByType("p").some((p) => p.children.join("") === "My workstation"),
    ).toBe(true);
    await act(async () => renderer.unmount());
  });
});
