import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AuthRelayWriteScope, EnvironmentId } from "@lecturn/contracts";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  refresh: vi.fn(),
  removeStored: vi.fn(),
  getStored: vi.fn(),
  listeners: new Set<(state: string) => void>(),
  text: [] as string[],
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => {
    mocks.text = [];
    return children;
  },
  Alert: { alert: vi.fn() },
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.listeners.add(listener);
      return { remove: () => mocks.listeners.delete(listener) };
    },
  },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: mocks.getStored,
  deleteItemAsync: mocks.removeStored,
}));
vi.mock("expo-web-browser", () => ({ openBrowserAsync: vi.fn() }));
vi.mock("expo-crypto", () => ({ randomUUID: vi.fn() }));
vi.mock("expo-file-system", () => ({ File: vi.fn(), Paths: {} }));
vi.mock("expo-sharing", () => ({ shareAsync: vi.fn() }));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => {
    mocks.text.push([children].flat(Infinity).join(""));
    return null;
  },
  AppTextInput: () => null,
}));
vi.mock("../../components/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("./ContextualControls", () => ({ ContextualButton: () => null }));
vi.mock("../../state/contextual", () => ({
  contextualEnvironment: { fundingStatus: () => "funding", funding: {} },
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => "session" },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string) =>
    query === "session"
      ? {
          data: { authenticated: true, scopes: [AuthRelayWriteScope] },
          error: null,
          refresh: mocks.refresh,
        }
      : {
          // Keep the prior generation cached while the status refresh fails.
          data: {
            environmentId: "host",
            featureId: "contextual",
            state: "unfunded",
            generation: 3,
            eligible: false,
            reason: "not-paid",
            allowance: null,
          },
          error: "Status connection unavailable",
          refresh: mocks.refresh,
        },
}));
import { ContextualFunding } from "./ContextualHostSettings";

let view: Root | undefined;
afterEach(async () => {
  await act(async () => view?.unmount());
  view = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.listeners.clear();
  vi.unstubAllGlobals();
});
it("does not expire a confirmed link when foregrounded after expiry with a stale funding query", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  view = createRoot(container as unknown as HTMLElement);
  const challenge = {
    environmentId: "host",
    featureId: "contextual",
    challengeId: "approval",
    generation: 3,
    expiresAt: "2026-09-27T12:01:00.000Z",
    approvalUrl: "https://example.test/approve",
  };
  mocks.getStored.mockResolvedValue(JSON.stringify(challenge));
  mocks.removeStored.mockResolvedValue(undefined);
  mocks.command.mockResolvedValue({
    _tag: "Success",
    value: {
      environmentId: "host",
      featureId: "contextual",
      state: "active",
      generation: 4,
      eligible: true,
      reason: "eligible",
      allowance: null,
      accountLabel: "Confirmed payer",
      remoteRevocationPending: false,
    },
  });
  await act(async () => {
    view!.render(
      <ContextualFunding environmentId={EnvironmentId.make("host")} featureId="contextual" />,
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(mocks.command).toHaveBeenCalledTimes(1);
  expect(mocks.text.join(" ")).toContain("linked");
  expect(mocks.text.join(" ")).toContain("Confirmed payer");
  expect(mocks.removeStored).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
    for (const listener of mocks.listeners) listener("active");
  });
  expect(mocks.command).toHaveBeenCalledTimes(1);
  expect(mocks.text.join(" ")).toContain("linked");
  expect(mocks.text.join(" ")).not.toContain("expired");
});
