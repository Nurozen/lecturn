import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, AuthRelayWriteScope } from "@lecturn/contracts";
const mocks = vi.hoisted(() => ({
  scopes: ["relay:write"] as string[],
  contextual: true,
  refresh: vi.fn(),
  changed: vi.fn(),
  command: vi.fn(),
  funding: {
    environmentId: "env",
    featureId: "decisions",
    reason: "not-paid",
    state: "unfunded",
    generation: 1,
    accountLabel: null,
    eligible: false,
    allowance: null,
    remoteRevocationPending: false,
  },
}));
vi.mock("../cloud/linkEnvironmentAtoms", () => ({ linkRemoteDecisionEnvironment: {} }));
vi.mock("../cloud/accountTokens", () => ({ readToken: () => Promise.resolve(null) }));
vi.mock("../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../cloud/publicConfig", () => ({
  resolveCloudPublicConfig: () => ({ clerkPublishableKey: null }),
}));
vi.mock("@clerk/react", () => ({
  useUser: () => {
    throw new Error("No Clerk provider in OSS build");
  },
}));
vi.mock("../cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => {
    throw new Error("No Clerk provider in OSS build");
  },
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => "env",
  useEnvironment: () => ({ label: "Fixture host" }),
}));
vi.mock("../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: { authenticated: true, scopes: mocks.scopes } }),
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.funding,
    error: null,
    isPending: false,
    refresh: mocks.refresh,
  }),
}));
vi.mock("../state/contextual", () => ({
  contextualEnvironment: { fundingStatus: () => null, funding: {} },
  useContextualAvailable: () => mocks.contextual,
  useContextualAccess: () => ({ funding: mocks.scopes.includes("relay:write") }),
}));
vi.mock("./ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../state/threadDecisions", () => ({
  threadDecisionEnvironment: { fundingStatus: () => null, funding: {} },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("../env", () => ({ isElectron: false }));
vi.mock("./ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
import { DecisionsFunding } from "./DecisionsFunding";
const environmentId = EnvironmentId.make("env");
async function render() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<DecisionsFunding environmentId={environmentId} onChange={mocks.changed} />);
  });
  return renderer;
}
async function click(renderer: ReactTestRenderer, text: string) {
  const button = renderer.root.findAllByType("button").find((b) => b.children.join("") === text);
  expect(button).toBeDefined();
  await act(async () => {
    await button!.props.onClick();
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scopes = [AuthRelayWriteScope];
  mocks.contextual = true;
  mocks.funding.state = "unfunded";
  mocks.funding.generation = 1;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
describe("funding controls without cloud auth configured", () => {
  it("reads status and completes a separately approved challenge with the challenge generation", async () => {
    const challenge = {
      featureId: "decisions",
      environmentId: "env",
      challengeId: "challenge",
      generation: 1,
      approvalUrl: "https://example.test/extensions/funding/approve?challengeId=challenge",
      expiresAt: "2099-09-23T12:00:00Z",
    };
    mocks.command.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value:
        input.operation === "create"
          ? challenge
          : input.operation === "observe"
            ? { ...challenge, state: "approved-awaiting-host", accountLabel: "payer@example.test" }
            : { ...mocks.funding, state: "active", generation: 2 },
    }));
    const renderer = await render();
    await click(renderer, "Link membership");
    expect(mocks.command).toHaveBeenNthCalledWith(1, {
      environmentId,
      input: { featureId: "decisions", operation: "create", expectedGeneration: 1 },
    });
    expect(mocks.command).toHaveBeenNthCalledWith(3, {
      environmentId,
      input: {
        featureId: "decisions",
        operation: "redeem",
        challengeId: "challenge",
        expectedGeneration: 1,
      },
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Membership linked");
    await act(async () => renderer.unmount());
  });
  it("retains legacy Decisions membership setup when the host does not support shared funding", async () => {
    mocks.contextual = false;
    mocks.command.mockResolvedValue({
      _tag: "Success",
      value: {
        status: mocks.funding,
        challenge: {
          challengeId: "legacy",
          generation: 2,
          approvalUrl: "https://example.test/decisions/funding/approve",
          expiresAt: "2099-09-23T12:00:00Z",
        },
      },
    });
    const renderer = await render();
    await click(renderer, "Link membership…");
    expect(mocks.command).toHaveBeenCalledWith({
      environmentId,
      input: { operation: "challenge", expectedGeneration: 1 },
    });
    expect(renderer.root.findByType("a").props.href).toContain("/decisions/funding/approve");
    await act(async () => renderer.unmount());
  });
  it("requires a second explicit click before revoking and preserves read-only allowance access", async () => {
    mocks.funding.state = "active";
    mocks.command.mockResolvedValue({
      _tag: "Success",
      value: { ...mocks.funding, state: "revoked" },
    });
    const renderer = await render();
    await click(renderer, "Revoke access…");
    expect(mocks.command).not.toHaveBeenCalled();
    await click(renderer, "Revoke Decisions");
    expect(mocks.command).toHaveBeenCalledWith({
      environmentId,
      input: { featureId: "decisions", operation: "revoke", expectedGeneration: 1 },
    });
    await act(async () => renderer.unmount());
    mocks.scopes = [];
    const readonly = await render();
    expect(readonly.root.findAllByType("button")).toHaveLength(0);
    expect(JSON.stringify(readonly.toJSON())).toContain("Membership allowance");
    await act(async () => readonly.unmount());
  });
});
