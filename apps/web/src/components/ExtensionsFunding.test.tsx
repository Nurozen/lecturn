import type { ComponentProps, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@lecturn/contracts";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  refresh: vi.fn(),
  access: true,
  configured: false,
  account: "account-one",
  ensureLink: vi.fn(),
  state: {} as Record<string, unknown>,
  queryError: null as string | null,
}));
vi.mock("../cloud/linkEnvironmentAtoms", () => ({ linkRemoteDecisionEnvironment: {} }));
vi.mock("../cloud/accountTokens", () => ({ readToken: vi.fn() }));
vi.mock("../state/session", () => ({ readPreparedConnection: vi.fn() }));
vi.mock("../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../cloud/publicConfig", () => ({
  resolveCloudPublicConfig: () => ({ clerkPublishableKey: mocks.configured ? "key" : null }),
}));
vi.mock("../cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => ({
    linked: false,
    operationError: null,
    reconcileCloudState: mocks.ensureLink,
  }),
}));
vi.mock("@clerk/react", () => ({
  useUser: () => ({
    user: {
      id: mocks.account,
      primaryEmailAddress: { emailAddress: `${mocks.account}@example.test` },
    },
  }),
}));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({ label: "Fixture host" }),
  usePrimaryEnvironmentId: () => "host",
}));
vi.mock("../state/contextual", () => ({
  contextualEnvironment: { fundingStatus: (input: unknown) => input, funding: {} },
  useContextualAvailable: () => true,
  useContextualAccess: () => ({ funding: mocks.access }),
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.state,
    error: mocks.queryError,
    isPending: false,
    refresh: mocks.refresh,
  }),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("./ui/button", () => ({
  Button: ({
    children,
    render: _render,
    ...props
  }: ComponentProps<"button"> & { render?: ReactNode }) => <button {...props}>{children}</button>,
}));
vi.mock("./ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { ExtensionsFunding } from "./ExtensionsFunding";
import {
  FUNDING_OBSERVATION_LIMIT,
  FUNDING_OBSERVATION_INTERVAL_MS,
} from "./ExtensionsFunding.logic";

const challenge = {
  featureId: "contextual",
  environmentId: "host",
  challengeId: "challenge-one",
  generation: 3,
  approvalUrl: "https://example.test/approve",
  expiresAt: "2026-09-26T13:00:00.000Z",
};
const success = (value: unknown) => ({ _tag: "Success", value });
const observed = (state = "awaiting-approval") => ({
  featureId: challenge.featureId,
  environmentId: challenge.environmentId,
  challengeId: challenge.challengeId,
  generation: challenge.generation,
  expiresAt: challenge.expiresAt,
  state,
  accountLabel: state === "awaiting-approval" ? null : "payer@example.test",
});
let view: ReactTestRenderer | undefined;
function button(label: string) {
  return view!.root.findAllByType("button").find((node) => node.children.join("") === label)!;
}
async function click(label: string) {
  await act(async () => {
    button(label).props.onClick();
  });
}
async function render(host = "host") {
  await act(async () => {
    view = create(
      <ExtensionsFunding environmentId={EnvironmentId.make(host)} featureId="contextual" />,
    );
  });
}
function calls(operation: string) {
  return mocks.command.mock.calls.filter(([input]) => input.input.operation === operation);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-26T12:00:00.000Z"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.command.mockReset();
  mocks.refresh.mockReset();
  mocks.ensureLink.mockReset();
  mocks.access = true;
  mocks.configured = false;
  mocks.account = "account-one";
  mocks.queryError = null;
  mocks.state = {
    featureId: "contextual",
    environmentId: "host",
    state: "unfunded",
    generation: 3,
    accountLabel: null,
    eligible: false,
    reason: "not-paid",
    allowance: null,
    remoteRevocationPending: false,
  };
  mocks.command.mockImplementation(async ({ input }) =>
    success(input.operation === "create" ? challenge : observed()),
  );
});
afterEach(async () => {
  await act(async () => view?.unmount());
  view = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("feature funding host linking", () => {
  it("accepts redemption completed by observe without redeeming twice", async () => {
    mocks.command.mockImplementation(async ({ input }) =>
      success(
        input.operation === "create"
          ? challenge
          : {
              ...mocks.state,
              state: "active",
              generation: 4,
              eligible: true,
              reason: "eligible",
              accountLabel: "payer@example.test",
            },
      ),
    );
    await render();
    await click("Link membership");
    expect(calls("redeem")).toHaveLength(0);
    expect(JSON.stringify(view!.toJSON())).toContain("Membership linked");
    expect(JSON.stringify(view!.toJSON())).not.toContain("request changed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(calls("observe")).toHaveLength(1);
  });
  it.each(["active", "revoked"])(
    "reconciles a recovery race to the actual newer %s state without claiming this approval succeeded",
    async (state) => {
      mocks.state = {
        ...mocks.state,
        state: "active",
        eligible: true,
        reason: "eligible",
        accountLabel: "old@example.test",
      };
      let recovered = false;
      mocks.command.mockImplementation(async ({ input }) => {
        if (input.operation === "create") return success(challenge);
        if (recovered) throw new Error("This approval changed or expired. Start a new approval.");
        return success(observed());
      });
      mocks.refresh.mockImplementation(() => {
        if (recovered)
          mocks.state = {
            ...mocks.state,
            state,
            generation: 4,
            eligible: state === "active",
            accountLabel: "current@example.test",
          };
      });
      await render();
      await click("Change membership");
      recovered = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FUNDING_OBSERVATION_INTERVAL_MS);
      });
      const text = JSON.stringify(view!.toJSON());
      expect(text).toContain(state === "active" ? "Linked" : "Revoked");
      expect(text).toContain("current@example.test");
      expect(text).not.toContain("Approve in your browser");
      expect(text).not.toContain("Automatic checks stopped");
      expect(text).not.toContain("changed or expired");
      expect(text).not.toContain("Membership linked");
      expect(calls("redeem")).toHaveLength(0);
      const count = calls("observe").length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(calls("observe")).toHaveLength(count);
    },
  );
  it("does not discard an approval using an unconfirmed newer cached status", async () => {
    await render();
    await click("Link membership");
    mocks.state = { ...mocks.state, state: "active", generation: 4 };
    mocks.queryError = "Connection unavailable";
    await act(async () => {
      view!.update(
        <ExtensionsFunding environmentId={EnvironmentId.make("host")} featureId="contextual" />,
      );
    });
    expect(JSON.stringify(view!.toJSON())).toContain("Approve in your browser");
    expect(JSON.stringify(view!.toJSON())).not.toContain("Membership linked");
  });
  it("does not create or approve funding on render and preserves read-only access", async () => {
    mocks.access = false;
    await render();
    expect(mocks.command).not.toHaveBeenCalled();
    expect(button("Link membership")).toBeUndefined();
    expect(JSON.stringify(view!.toJSON())).toContain("relay management permission");
  });
  it("registers the primary host before requesting the named feature approval", async () => {
    mocks.configured = true;
    mocks.ensureLink.mockResolvedValue(true);
    await render();
    await click("Link membership");
    expect(mocks.ensureLink).toHaveBeenCalledWith({
      managedTunnel: false,
      publish: false,
      decisions: true,
    });
    expect(calls("create")[0]?.[0].input).toEqual({
      featureId: "contextual",
      operation: "create",
      expectedGeneration: 3,
    });
    expect(calls("redeem")).toHaveLength(0);
  });
  it("observes exact consent and automatically redeems once at the next funding generation", async () => {
    let approved = false;
    mocks.command.mockImplementation(async ({ input }) =>
      success(
        input.operation === "create"
          ? challenge
          : input.operation === "redeem"
            ? {
                ...mocks.state,
                state: "active",
                generation: 4,
                eligible: true,
                reason: "eligible",
                accountLabel: "payer@example.test",
              }
            : observed(approved ? "approved-awaiting-host" : "awaiting-approval"),
      ),
    );
    await render();
    await click("Link membership");
    expect(calls("redeem")).toHaveLength(0);
    approved = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FUNDING_OBSERVATION_INTERVAL_MS);
    });
    expect(calls("redeem")).toHaveLength(1);
    expect(calls("redeem")[0]?.[0].input).toEqual({
      featureId: "contextual",
      operation: "redeem",
      challengeId: "challenge-one",
      expectedGeneration: 3,
    });
    expect(JSON.stringify(view!.toJSON())).toContain("Membership linked");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(calls("redeem")).toHaveLength(1);
  });
  it.each(["featureId", "environmentId", "challengeId", "generation", "expiresAt"])(
    "never redeems an approval with mismatched %s",
    async (field) => {
      mocks.command.mockImplementation(async ({ input }) =>
        success(
          input.operation === "create"
            ? challenge
            : {
                ...observed("approved-awaiting-host"),
                [field]: field === "generation" ? 99 : "different",
              },
        ),
      );
      await render();
      await click("Link membership");
      expect(calls("redeem")).toHaveLength(0);
      expect(JSON.stringify(view!.toJSON())).toContain("approval request changed");
    },
  );
  it("does not report an active link when redemption returns the challenge generation", async () => {
    mocks.command.mockImplementation(async ({ input }) =>
      success(
        input.operation === "create"
          ? challenge
          : input.operation === "redeem"
            ? { ...mocks.state, state: "active" }
            : observed("approved-awaiting-host"),
      ),
    );
    await render();
    await click("Link membership");
    expect(JSON.stringify(view!.toJSON())).toContain("host link changed");
    expect(JSON.stringify(view!.toJSON())).not.toContain("Membership linked");
  });
  it("cancels the exact pending challenge and preserves prior active funding", async () => {
    mocks.state = {
      ...mocks.state,
      state: "active",
      eligible: true,
      reason: "eligible",
      accountLabel: "existing@example.test",
    };
    await render();
    await click("Change membership");
    await click("Cancel request");
    expect(calls("cancel")[0]?.[0].input).toEqual({
      featureId: "contextual",
      operation: "cancel",
      challengeId: "challenge-one",
      expectedGeneration: 3,
    });
    expect(calls("revoke")).toHaveLength(0);
    expect(JSON.stringify(view!.toJSON())).toContain("existing@example.test");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calls("redeem")).toHaveLength(0);
  });
  it("bounds automatic checks and supports explicit retry without a new challenge", async () => {
    await render();
    await click("Link membership");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        FUNDING_OBSERVATION_INTERVAL_MS * FUNDING_OBSERVATION_LIMIT,
      );
    });
    expect(calls("observe")).toHaveLength(FUNDING_OBSERVATION_LIMIT);
    expect(JSON.stringify(view!.toJSON())).toContain("Automatic checks stopped");
    await click("Check approval");
    expect(calls("observe")).toHaveLength(FUNDING_OBSERVATION_LIMIT + 1);
    expect(calls("create")).toHaveLength(1);
  });
  it("stops observing the prior account's challenge when the signed-in account changes", async () => {
    mocks.configured = true;
    mocks.ensureLink.mockResolvedValue(true);
    await render();
    await click("Link membership");
    const count = calls("observe").length;
    mocks.account = "account-two";
    await act(async () => {
      view!.update(
        <ExtensionsFunding environmentId={EnvironmentId.make("host")} featureId="contextual" />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(calls("observe")).toHaveLength(count);
    expect(calls("redeem")).toHaveLength(0);
  });
  it("expires locally without redeeming an expired approval", async () => {
    mocks.command.mockImplementation(async ({ input }) =>
      success(
        input.operation === "create"
          ? { ...challenge, expiresAt: "2026-09-26T11:59:00.000Z" }
          : observed("approved-awaiting-host"),
      ),
    );
    await render();
    await click("Link membership");
    expect(calls("observe")).toHaveLength(0);
    expect(calls("redeem")).toHaveLength(0);
    expect(JSON.stringify(view!.toJSON())).toContain("Request expired");
  });
});
