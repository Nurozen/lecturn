import { act, type ReactNode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  MessageId,
  type ContextualDisclosure,
  type ContextualConflict,
} from "@lecturn/contracts";
const mocks = vi.hoisted(() => ({
  operate: true,
  data: {} as Record<string, unknown>,
  execute: vi.fn(),
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
  contextualEnvironment: {
    status: () => "status",
    conflicts: () => "conflicts",
    disclosures: () => "disclosures",
    preparationAction: "preparationAction",
    resolveConflict: "resolveConflict",
    exclude: "exclude",
  } as never,
  useContextualAccess: (() => ({
    operate: mocks.operate,
    administer: false,
    funding: false,
  })) as never,
  useContextualAvailable: (() => true) as never,
  contextualErrorMessage: ((e: unknown) => (e instanceof Error ? e.message : "Failed")) as never,
}));
vi.mock(import("../../state/query"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useEnvironmentQuery: ((key: string) => {
      useSyncExternalStore(
        (listener) => {
          mocks.listeners.add(listener);
          return () => mocks.listeners.delete(listener);
        },
        () => mocks.version,
      );
      return { data: mocks.data[key] ?? null, error: null, isPending: false, refresh: () => {} };
    }) as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: string) => (input: unknown) => mocks.execute(command, input)) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({ children }: { children: ReactNode }) => <a>{children}</a>) as never,
}));
import { ContextualDisclosureCard, ContextualMessageDisclosure } from "./ContextualDisclosure";
import { ContextualConflictCard, ContextualPreparationPanel } from "./ContextualPreparationPanel";
const environmentId = EnvironmentId.make("host"),
  threadId = ThreadId.make("thread");
const evidence = (id: string, quote: string) => ({
  id,
  quote,
  sourceId: "source",
  sourceKind: "slack",
  occurredAt: "2026-09-25T00:00:00Z",
  observedAt: "2026-09-25T00:00:01Z",
  author: "Colleague",
  availability: "available",
  sourceUrl: null,
  locator: {
    sourceKind: "slack",
    workspaceId: "workspace",
    channelId: "channel",
    messageTs: "1.000",
    threadTs: null,
  },
});
const disclosure = {
  receipt: {
    id: "receipt",
    acceptance: "accepted",
    evidenceIncluded: true,
    suppliedEvidenceIds: ["selected"],
    disposition: "fresh",
  },
  retention: "available",
  packet: {
    purpose: "new-context",
    groups: [
      {
        guidanceId: "guidance",
        attribution: "agent-chosen",
        reasons: ["constraint"],
        evidence: [
          evidence("selected", "Use a single region."),
          evidence("unselected", "Do not reveal this unselected excerpt."),
        ],
      },
    ],
  },
} as unknown as ContextualDisclosure;
const conflict = {
  id: "conflict",
  threadId,
  revision: 8,
  taskFingerprint: "task",
  state: "awaiting-review",
  pair: {
    left: {
      id: "left",
      revision: 2,
      scope: "This project",
      temporalApplicability: "Current",
      attribution: "user-directed",
      evidence: [evidence("left-evidence", "Use one region.")],
    },
    right: {
      id: "right",
      revision: 3,
      scope: "This project",
      temporalApplicability: "Current",
      attribution: "agent-chosen",
      evidence: [evidence("right-evidence", "Use two regions.")],
    },
  },
} as unknown as ContextualConflict;
type View = { root: Root; container: HTMLDivElement };
let renderer: View | undefined;
async function render(node: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const view = { root: createRoot(container), container };
  renderer = view;
  await act(async () => view.root.render(node));
  return view;
}
const textOf = (view: View) => view.container.textContent ?? "";
const buttons = (view: View) => [...view.container.querySelectorAll("button")];
const button = (view: View, label: string) => buttons(view).find((b) => b.textContent === label)!;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.operate = true;
  mocks.data = {
    status: {
      thread: { revision: 9, exclusionRevision: 4 },
      preparation: {
        id: "prep",
        revision: 5,
        state: "awaiting-conflict-review",
        conflictIds: ["conflict"],
      },
    },
    conflicts: { items: [conflict] },
  };
  mocks.execute.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  const current = renderer;
  renderer = undefined;
  if (current) {
    await act(async () => current.root.unmount());
    current.container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Contextual interaction boundaries", () => {
  it("shows only receipt-confirmed evidence and keeps original decision attribution", async () => {
    const view = await render(
      <ContextualDisclosureCard
        environmentId={environmentId}
        threadId={threadId}
        disclosure={disclosure}
      />,
    );
    const text = textOf(view);
    expect(text).toContain("Use a single region.");
    expect(text).not.toContain("Do not reveal");
    expect(text).toContain("Agent chosen");
    expect(text).not.toContain("User accepted");
    await act(async () => button(view, "Exclude from this thread").click());
    expect(mocks.execute).toHaveBeenCalledWith("exclude", {
      environmentId,
      input: expect.objectContaining({
        threadId,
        guidanceId: "guidance",
        excluded: true,
        expectedRevision: 4,
      }),
    });
    expect(textOf(view)).toContain("cannot retract text already sent");
  });
  it("does not expose mutation actions on a read-only remote connection", async () => {
    mocks.operate = false;
    const view = await render(
      <>
        <ContextualDisclosureCard
          environmentId={environmentId}
          threadId={threadId}
          disclosure={disclosure}
        />
        <ContextualConflictCard environmentId={environmentId} conflict={conflict} />
      </>,
    );
    expect(buttons(view)).toHaveLength(0);
    expect(textOf(view)).toContain("Use a single region.");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("binds a conflict choice to exact task and both claim revisions", async () => {
    const view = await render(
      <ContextualConflictCard environmentId={environmentId} conflict={conflict} />,
    );
    const distinct = button(view, "Apply to different scopes");
    expect(distinct.disabled).toBe(true);
    await act(async () => button(view, "Use second claim").click());
    expect(mocks.execute).toHaveBeenCalledWith("resolveConflict", {
      environmentId,
      input: expect.objectContaining({
        conflictId: "conflict",
        expectedRevision: 8,
        leftRevision: 2,
        rightRevision: 3,
        threadId,
        taskFingerprint: "task",
        action: "use-right",
        clarification: null,
      }),
    });
  });
  it("requires explicit skip while a material conflict holds the submitted message", async () => {
    const view = await render(
      <ContextualPreparationPanel environmentId={environmentId} threadId={threadId} />,
    );
    expect(textOf(view)).toContain("message waiting");
    expect(mocks.execute).not.toHaveBeenCalled();
    await act(async () => button(view, "Send without context").click());
    expect(mocks.execute).toHaveBeenCalledWith("preparationAction", {
      environmentId,
      input: expect.objectContaining({
        preparationId: "prep",
        expectedRevision: 5,
        action: "send-without-context",
      }),
    });
  });
  it("labels inherited and forgotten disclosures without inventing a new delivery", async () => {
    const view = await render(
      <ContextualDisclosureCard
        environmentId={environmentId}
        threadId={threadId}
        disclosure={{
          ...disclosure,
          packet: null,
          retention: "forgotten",
          inherited: { originThreadId: ThreadId.make("parent"), messageId: "mapped" as never },
        }}
      />,
    );
    const text = textOf(view);
    expect(text).toContain("Inherited context");
    expect(text).toContain("forgotten");
    expect(text).not.toContain("Use a single region.");
  });
});

it("presents a distinct Contextual summary with unchanged original evidence", async () => {
  const messageId = MessageId.make("message");
  mocks.data.status = { thread: { exclusionRevision: 4 }, preparation: null };
  mocks.data.disclosures = {
    items: [
      {
        ...disclosure,
        messageId,
        displaySummary: { state: "ready", text: "Keep this deployment in one region." },
      },
    ],
  };
  const view = await render(
    <ContextualMessageDisclosure
      environmentId={environmentId}
      threadId={threadId}
      messageId={messageId}
    />,
  );
  expect(view.container.querySelector("article")?.dataset.messageType).toBe("contextual");
  const rendered = textOf(view);
  expect(rendered).toContain("Keep this deployment in one region.");
  expect(rendered).toContain("Use a single region.");
  expect(rendered).not.toContain("Do not reveal this unselected excerpt.");
  expect(view.container.querySelectorAll("details")).toHaveLength(1);
  await act(async () => {
    mocks.data.disclosures = {
      items: [
        {
          ...disclosure,
          packet: null,
          messageId,
          retention: "forgotten",
          displaySummary: { state: "ready", text: "Keep this deployment in one region." },
        },
      ],
    };
    mocks.publish();
  });
  expect(textOf(view)).not.toContain("Keep this deployment in one region.");
});
it("explains a skipped message without inferring cause from current settings", async () => {
  const messageId = MessageId.make("message");
  mocks.data.status = {
    preparation: { task: { messageId }, state: "skipped", skipReason: "unavailable" },
  };
  const view = await render(
    <ContextualMessageDisclosure
      environmentId={environmentId}
      threadId={threadId}
      messageId={messageId}
    />,
  );
  expect(textOf(view)).toContain("Context was unavailable for this message");
  expect(textOf(view)).not.toContain("at your request");
});
