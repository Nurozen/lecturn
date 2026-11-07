import { describe, expect, it, vi } from "vite-plus/test";
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
vi.mock(import("../cloud/linkEnvironmentAtoms"), async (original) => ({
  ...(await original()),
  linkRemoteDecisionEnvironment: {} as never,
}));
vi.mock(import("../cloud/accountTokens"), async (original) => ({
  ...(await original()),
  readToken: (() => Promise.resolve(null)) as never,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() => new Map()) as never,
}));
vi.mock(import("../cloud/publicConfig"), async (original) => ({
  ...(await original()),
  resolveCloudPublicConfig: (() => ({ clerkPublishableKey: null })) as never,
}));
vi.mock(import("@clerk/react"), async (original) => ({
  ...(await original()),
  useUser: (() => {
    throw new Error("No Clerk provider in OSS build");
  }) as never,
}));
vi.mock(import("../cloud/useCloudLinkController"), async (original) => ({
  ...(await original()),
  useCloudLinkController: (() => {
    throw new Error("No Clerk provider in OSS build");
  }) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "env") as never,
  useEnvironment: (() => ({ label: "Fixture host" })) as never,
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentSessionState: (() => ({
    data: { authenticated: true, scopes: mocks.scopes },
  })) as never,
}));
vi.mock(import("../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: mocks.funding,
    error: null,
    isPending: false,
    refresh: mocks.refresh,
  })) as never,
}));
vi.mock(import("../state/contextual"), async (original) => ({
  ...(await original()),
  contextualEnvironment: { fundingStatus: () => null, funding: {} } as never,
  useContextualAvailable: (() => mocks.contextual) as never,
  useContextualAccess: (() => ({ funding: mocks.scopes.includes("relay:write") })) as never,
}));
vi.mock(import("../state/threadDecisions"), async (original) => ({
  ...(await original()),
  threadDecisionEnvironment: { fundingStatus: () => null, funding: {} } as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => mocks.command) as never,
}));
vi.mock(import("../env"), async (original) => ({
  ...(await original()),
  isElectron: false as never,
}));
import { act, render as renderUi, type Screen } from "../../test/render";
import { DecisionsFunding } from "./DecisionsFunding";
const environmentId = EnvironmentId.make("env");
type View = Screen;
const mounted: View[] = [];
async function render(): Promise<View> {
  const view = await renderUi(
    <DecisionsFunding environmentId={environmentId} onChange={mocks.changed} />,
    { router: false },
  );
  mounted.push(view);
  // The lazy view replaces the empty Suspense fallback only after its import settles.
  await vi.waitFor(() => expect(view.container.firstElementChild).not.toBeNull());
  return view;
}
async function unmount(view: View) {
  mounted.splice(mounted.indexOf(view), 1);
  await view[Symbol.asyncDispose]();
}
const buttons = (view: View) => [...view.container.querySelectorAll("button")];
async function click(view: View, text: string) {
  const button = buttons(view).find((b) => b.textContent === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function setup(): Promise<AsyncDisposable> {
  // Both funding views are lazy chunks; load them first so a cold transform cannot outlast a render.
  await Promise.all([import("./ExtensionsFunding"), import("./LegacyDecisionsFunding")]);
  vi.clearAllMocks();
  mocks.scopes = [AuthRelayWriteScope];
  mocks.contextual = true;
  mocks.funding.state = "unfunded";
  mocks.funding.generation = 1;
  vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    async [Symbol.asyncDispose]() {
      for (const view of mounted.toReversed()) await unmount(view);
      vi.restoreAllMocks();
    },
  };
}
describe("funding controls without cloud auth configured", () => {
  it("reads status and completes a separately approved challenge with the challenge generation", async () => {
    await using _setup = await setup();
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
    expect(renderer.container.textContent).toContain("Membership linked");
    await unmount(renderer);
  });
  it("retains legacy Decisions membership setup when the host does not support shared funding", async () => {
    await using _setup = await setup();
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
    expect(renderer.container.querySelector("a")?.getAttribute("href")).toContain(
      "/decisions/funding/approve",
    );
    await unmount(renderer);
  });
  it("requires a second explicit click before revoking and preserves read-only allowance access", async () => {
    await using _setup = await setup();
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
    await unmount(renderer);
    mocks.scopes = [];
    const readonly = await render();
    expect(buttons(readonly)).toHaveLength(0);
    expect(readonly.container.textContent).toContain("Membership allowance");
    await unmount(readonly);
  });
});
