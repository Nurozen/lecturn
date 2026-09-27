import type { ComponentProps, ReactNode, ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
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
}));
vi.mock("../../state/contextual", () => ({
  contextualEnvironment: {
    status: () => "status",
    conflicts: () => "conflicts",
    disclosures: () => "disclosures",
    preparationAction: "preparationAction",
    resolveConflict: "resolveConflict",
    exclude: "exclude",
  },
  useContextualAccess: () => ({ operate: mocks.operate, administer: false, funding: false }),
  useContextualAvailable: () => true,
  contextualErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "Failed"),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string) => ({
    data: mocks.data[key] ?? null,
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (input: unknown) => mocks.execute(command, input),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipPopup: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
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
let renderer: ReactTestRenderer | undefined;
async function render(node: ReactElement) {
  await act(async () => {
    renderer = create(node);
  });
  return renderer!;
}
beforeEach(() => {
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
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
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
    const text = JSON.stringify(view.toJSON());
    expect(text).toContain("Use a single region.");
    expect(text).not.toContain("Do not reveal");
    expect(text).toContain("Agent chosen");
    expect(text).not.toContain("User accepted");
    await act(async () =>
      view.root
        .findAllByType("button")
        .find((b) => b.children.join("") === "Exclude from this thread")!
        .props.onClick(),
    );
    expect(mocks.execute).toHaveBeenCalledWith("exclude", {
      environmentId,
      input: expect.objectContaining({
        threadId,
        guidanceId: "guidance",
        excluded: true,
        expectedRevision: 4,
      }),
    });
    expect(JSON.stringify(view.toJSON())).toContain("cannot retract text already sent");
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
    expect(view.root.findAllByType("button")).toHaveLength(0);
    expect(JSON.stringify(view.toJSON())).toContain("Use a single region.");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("binds a conflict choice to exact task and both claim revisions", async () => {
    const view = await render(
      <ContextualConflictCard environmentId={environmentId} conflict={conflict} />,
    );
    const distinct = view.root
      .findAllByType("button")
      .find((b) => b.children.join("") === "Apply to different scopes")!;
    expect(distinct.props.disabled).toBe(true);
    await act(async () =>
      view.root
        .findAllByType("button")
        .find((b) => b.children.join("") === "Use second claim")!
        .props.onClick(),
    );
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
    expect(JSON.stringify(view.toJSON())).toContain("message waiting");
    expect(mocks.execute).not.toHaveBeenCalled();
    await act(async () =>
      view.root
        .findAllByType("button")
        .find((b) => b.children.join("") === "Send without context")!
        .props.onClick(),
    );
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
    const text = JSON.stringify(view.toJSON());
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
  expect(view.root.findByType("article").props["data-message-type"]).toBe("contextual");
  const rendered = JSON.stringify(view.toJSON());
  expect(rendered).toContain("Keep this deployment in one region.");
  expect(rendered).toContain("Use a single region.");
  expect(rendered).not.toContain("Do not reveal this unselected excerpt.");
  expect(view.root.findAllByType("details")).toHaveLength(1);
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
    view.update(
      <ContextualMessageDisclosure
        environmentId={environmentId}
        threadId={threadId}
        messageId={messageId}
      />,
    );
  });
  expect(JSON.stringify(view.toJSON())).not.toContain("Keep this deployment in one region.");
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
  expect(JSON.stringify(view.toJSON())).toContain("Context was unavailable for this message");
  expect(JSON.stringify(view.toJSON())).not.toContain("at your request");
});
