import type { ComponentProps, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@lecturn/contracts";
const mocks = vi.hoisted(() => ({
  administer: true,
  available: true,
  refresh: vi.fn(),
  command: vi.fn(),
  queries: vi.fn(),
  policy: {
    allowedSourceIds: ["unseen-channel"],
    allowDirectMessages: false,
    allowGroupDirectMessages: false,
    unknownConversationPolicy: "exclude",
    draftsPolicy: "exclude",
    revision: 2,
  },
  capture: {
    state: "paused",
    reason: "requested",
    generation: 1,
    sourceGeneration: 2,
    purgeGeneration: 0,
    capturedRecords: 5,
    coverage: "partial",
  },
  funding: { state: "active", eligible: true, allowance: { remainingInputTokens: 0 } },
}));
vi.mock("../../state/contextual", () => ({
  useContextualAvailable: () => mocks.available,
  useContextualAccess: () => ({ administer: mocks.administer, operate: true, funding: false }),
  contextualEnvironment: {
    captureStatus: (input: unknown) => ({ kind: "capture", input }),
    fundingStatus: (input: unknown) => ({ kind: "funding", input }),
    sources: (input: unknown) => ({ kind: "sources", input }),
    configureSources: { kind: "configure" },
    setCapture: { kind: "capture" },
  },
}));
vi.mock("../../state/environments", () => ({ useEnvironment: () => ({ label: "Fixture host" }) }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string; input: { input: { cursor?: string } } }) => {
    mocks.queries(atom.kind);
    const source = {
      id: atom.input.input.cursor ? "channel-two" : "dm-one",
      sourceKind: "slack",
      label: atom.input.input.cursor ? "Engineering" : "Private exchange",
      hostName: "Fixture host",
      workspaceId: "workspace",
      channelId: "channel",
      conversationType: atom.input.input.cursor ? "channel" : "dm",
      available: true,
      selected: false,
    };
    return {
      data:
        atom.kind === "capture"
          ? mocks.capture
          : atom.kind === "funding"
            ? mocks.funding
            : {
                sources: [source],
                nextCursor: atom.input.input.cursor ? null : "page-two",
                policy: mocks.policy,
                sourceGeneration: 2,
              },
      error: null,
      isPending: false,
      refresh: mocks.refresh,
    };
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("../ExtensionsFunding", () => ({ ExtensionsFunding: () => <div>Membership</div> }));
vi.mock("./ContextualArchive", () => ({
  ContextualArchive: () => <div>Administrator archive</div>,
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/checkbox", () => ({
  Checkbox: ({
    onCheckedChange,
    ...props
  }: ComponentProps<"input"> & { onCheckedChange: (checked: boolean) => void }) => (
    <input {...props} type="checkbox" onChange={(event) => onCheckedChange(event.target.checked)} />
  ),
}));
import { ContextualHostSettings } from "./ContextualHostSettings";
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
async function render() {
  await act(async () => {
    view = create(<ContextualHostSettings environmentId={environmentId} />);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.administer = true;
  mocks.available = true;
  mocks.policy.revision = 2;
  mocks.capture.state = "paused";
  mocks.funding.eligible = true;
  mocks.funding.state = "active";
  mocks.command.mockResolvedValue({ _tag: "Success", value: {} });
});
afterEach(async () => {
  await act(async () => view?.unmount());
  view = undefined;
  vi.restoreAllMocks();
});
describe("Contextual host source controls", () => {
  it("discovers metadata only after an explicit action and never starts collection on setup", async () => {
    await render();
    expect(mocks.queries).not.toHaveBeenCalledWith("sources");
    expect(mocks.command).not.toHaveBeenCalled();
    await click("Discover sources");
    expect(mocks.queries).toHaveBeenCalledWith("sources");
    expect(mocks.command).not.toHaveBeenCalled();
  });
  it("preserves unseen selected sources across pagination and requires explicit DM selection", async () => {
    await render();
    await click("Discover sources");
    const dm = view!.root.findByType("input");
    expect(dm.props.checked).toBe(false);
    await act(async () => dm.props.onChange({ target: { checked: true } }));
    await click("Next");
    await act(async () =>
      view!.root.findByType("input").props.onChange({ target: { checked: true } }),
    );
    await click("Save source selection");
    expect(mocks.command).toHaveBeenCalledWith({
      environmentId,
      input: {
        expectedRevision: 2,
        policy: {
          ...mocks.policy,
          revision: 3,
          allowedSourceIds: ["unseen-channel", "dm-one", "channel-two"],
          allowDirectMessages: true,
        },
      },
    });
  });
  it("does not overwrite another administrator's newer source policy", async () => {
    await render();
    await click("Discover sources");
    await act(async () =>
      view!.root.findByType("input").props.onChange({ target: { checked: true } }),
    );
    mocks.policy = { ...mocks.policy, revision: 3 };
    await act(async () => view!.update(<ContextualHostSettings environmentId={environmentId} />));
    expect(button("Save source selection").props.disabled).toBe(true);
    await click("Save source selection");
    expect(mocks.command).not.toHaveBeenCalled();
    expect(JSON.stringify(view!.toJSON())).toContain("Another administrator changed");
  });
  it("allows eligible local collection even when paid inference allowance is exhausted", async () => {
    await render();
    expect(button("Start collection").props.disabled).toBe(false);
    await click("Start collection");
    expect(mocks.command).toHaveBeenCalledWith({
      environmentId,
      input: { state: "running", expectedGeneration: 1 },
    });
  });
  it("keeps pause available after funding becomes ineligible", async () => {
    mocks.capture.state = "running";
    mocks.funding.eligible = false;
    await render();
    expect(button("Pause collection").props.disabled).toBe(false);
    await click("Pause collection");
    expect(mocks.command).toHaveBeenCalledWith({
      environmentId,
      input: { state: "paused", expectedGeneration: 1 },
    });
  });
  it("never queries raw source metadata or exposes archive management to non-administrators", async () => {
    mocks.administer = false;
    await render();
    expect(mocks.queries).not.toHaveBeenCalledWith("sources");
    expect(button("Discover sources")).toBeUndefined();
    expect(button("Inspect, export, or forget")).toBeUndefined();
    expect(button("Start collection")).toBeUndefined();
    expect(mocks.command).not.toHaveBeenCalled();
  });
  it("does not call new RPC methods on older hosts", async () => {
    mocks.available = false;
    await render();
    expect(mocks.queries).not.toHaveBeenCalled();
    expect(JSON.stringify(view!.toJSON())).toContain("Update this host");
  });
});

it("explains disabled collection during a membership outage and offers refresh", async () => {
  mocks.funding.state = "unavailable";
  mocks.funding.eligible = false;
  await render();
  expect(button("Start collection").props.disabled).toBe(true);
  expect(JSON.stringify(view!.toJSON())).toContain("membership access could not be verified");
  expect(JSON.stringify(view!.toJSON())).not.toContain("paused by your request");
  await click("Refresh status");
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  expect(mocks.command).not.toHaveBeenCalled();
});
