import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
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
  // Query results are reactive in the app; compiled parents memoize children, so
  // fixture changes must notify subscribed query hooks instead of re-rendering the root.
  version: 0,
  listeners: new Set<() => void>(),
  publish() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  },
}));
vi.mock(import("../../state/contextual"), async (original) => ({
  ...(await original()),
  useContextualAvailable: (() => mocks.available) as never,
  useContextualAccess: (() => ({
    administer: mocks.administer,
    operate: true,
    funding: false,
  })) as never,
  contextualEnvironment: {
    captureStatus: (input: unknown) => ({ kind: "capture", input }),
    fundingStatus: (input: unknown) => ({ kind: "funding", input }),
    sources: (input: unknown) => ({ kind: "sources", input }),
    configureSources: { kind: "configure" },
    setCapture: { kind: "capture" },
  } as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({ label: "Fixture host" })) as never,
}));
vi.mock(import("../../state/query"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useEnvironmentQuery: ((atom: { kind: string; input: { input: { cursor?: string } } }) => {
      useSyncExternalStore(
        (listener) => {
          mocks.listeners.add(listener);
          return () => mocks.listeners.delete(listener);
        },
        () => mocks.version,
      );
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
    }) as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => mocks.command) as never,
}));
vi.mock(import("../ExtensionsFunding"), () => ({
  ExtensionsFunding: (() => <div>Membership</div>) as never,
}));
vi.mock(import("./ContextualArchive"), () => ({
  ContextualArchive: (() => <div>Administrator archive</div>) as never,
}));
vi.mock(import("../ui/checkbox"), () => ({
  Checkbox: (({
    onCheckedChange,
    ...props
  }: ComponentProps<"input"> & { onCheckedChange: (checked: boolean) => void }) => (
    <input {...props} type="checkbox" onChange={(event) => onCheckedChange(event.target.checked)} />
  )) as never,
}));
import { ContextualHostSettings } from "./ContextualHostSettings";
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
const checkbox = () => view!.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
async function render() {
  if (!view) {
    const container = document.createElement("div");
    document.body.append(container);
    view = { root: createRoot(container), container };
  }
  const { root } = view;
  await act(async () => {
    root.render(<ContextualHostSettings environmentId={environmentId} />);
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  const current = view;
  view = undefined;
  if (current) {
    await act(async () => current.root.unmount());
    current.container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    const dm = checkbox();
    expect(dm.checked).toBe(false);
    await act(async () => dm.click());
    await click("Next");
    await act(async () => checkbox().click());
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
    await act(async () => checkbox().click());
    mocks.policy = { ...mocks.policy, revision: 3 };
    await act(async () => mocks.publish());
    expect(button("Save source selection").disabled).toBe(true);
    await click("Save source selection");
    expect(mocks.command).not.toHaveBeenCalled();
    expect(text()).toContain("Another administrator changed");
  });
  it("allows eligible local collection even when paid inference allowance is exhausted", async () => {
    await render();
    expect(button("Start collection").disabled).toBe(false);
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
    expect(button("Pause collection").disabled).toBe(false);
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
    expect(text()).toContain("Update this host");
  });
});

it("explains disabled collection during a membership outage and offers refresh", async () => {
  mocks.funding.state = "unavailable";
  mocks.funding.eligible = false;
  await render();
  expect(button("Start collection").disabled).toBe(true);
  expect(text()).toContain("membership access could not be verified");
  expect(text()).not.toContain("paused by your request");
  await click("Refresh status");
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  expect(mocks.command).not.toHaveBeenCalled();
});
