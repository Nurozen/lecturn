import { EnvironmentId, MessageId, RunId } from "@lecturn/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, render } from "../../../test/render";
import { MessagesTimeline, remarkThoughtPreview } from "./MessagesTimeline";
import { parseMarkdownWithMath } from "@lecturn/shared/markdownMath";

const pullRequestQuery = vi.hoisted(() => ({ error: "Pull request not found" }));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    error: pullRequestQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

function work(id: string, entry: Record<string, unknown>): Entry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: { id, createdAt: CREATED_AT, ...entry },
  } as Entry;
}

function v2Item(type: string, fields: Record<string, unknown>) {
  const id = (fields.id as string | undefined) ?? type;
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: id,
    item: {
      id,
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: {},
      type,
      ...fields,
    },
  } as never;
}

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function message(
  text: string,
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

async function renderElement(element: ReactElement) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, { container });
  const buttons = (name: string | RegExp) =>
    [...container.querySelectorAll<HTMLElement>("button, [role=button]")].filter((button) => {
      const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    });
  return Object.assign(screen, {
    text: () => container.textContent ?? "",
    buttons,
    button: (name: string | RegExp) => {
      const [match] = buttons(name);
      if (!match) throw new Error(`Missing button: ${String(name)}`);
      return match;
    },
  });
}

function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  return renderElement(
    <MessagesTimeline {...baseProps()} timelineEntries={entries as Entry[]} {...props} />,
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe("MessagesTimeline work rows", () => {
  it("renders Lecturn MCP dynamic tools with the product logo and pretty name", async () => {
    const item = {
      id: "tool-lecturn-thread-read",
      type: "dynamic_tool",
      toolName: "mcp__lecturn__lecturn_thread_read",
      input: { threadId: "thread-child" },
      output: { messages: [] },
    };
    await using screen = await renderTimeline([
      work("context-info", { label: "Session started", tone: "info" }),
      work(item.id, {
        runId: null,
        label: item.toolName,
        tone: "tool",
        itemType: item.type,
        toolTitle: item.toolName,
        toolLifecycleStatus: "completed",
        toolData: { input: item.input, output: item.output },
        structuredPayload: v2Item("dynamic_tool", item),
        projectedItem: v2Item("dynamic_tool", item),
      }),
    ]);
    await click(screen.button(/^Received 1 update/));
    await vi.waitFor(() => expect(screen.text()).toContain("Read a Lecturn thread"));
    expect(screen.container.querySelector('svg[viewBox="0 0 1024 1024"]')).not.toBeNull();
    expect(screen.text()).not.toContain("mcp__lecturn__lecturn_thread_read");
  });

  it("does not repeat the visible tool label in expanded output", async () => {
    await using screen = await renderTimeline([
      work("duplicate-label", { label: "Search results", detail: "Search results", tone: "tool" }),
    ]);
    await click(screen.container.querySelector<HTMLElement>('[aria-expanded="false"]')!);
    expect(screen.container.querySelectorAll("pre")).toHaveLength(0);
    const labels = [...screen.container.querySelectorAll("span")].filter((span) =>
      [...span.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent === "Search results",
      ),
    );
    expect(labels).toHaveLength(1);
  });
});

describe("MessagesTimeline messages", () => {
  it("preserves XML-like tags and comparisons in user messages as text", async () => {
    const source = [
      'Without reading a file, do you have <global-agent-instructions scope="workspace">',
      'Before <nested data-value="a&b">inside</nested> after',
      "</global-agent-instructions> in your context?",
      "Comparison: 2 < 3 and 5 > 4.",
    ];
    await using screen = await renderTimeline([message(source.join("\n"))]);
    for (const line of source) expect(screen.text()).toContain(line);
    expect(screen.container.querySelector("global-agent-instructions, nested")).toBeNull();
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const source =
      '<script>globalThis.__lecturnXss = 1</script><img src="x" onerror="globalThis.__lecturnXss = 2">';
    await using screen = await renderTimeline([message(source)]);
    expect(screen.text()).toContain(source);
    expect(screen.container.querySelector("script, img")).toBeNull();
    expect((globalThis as { __lecturnXss?: number }).__lecturnXss).toBeUndefined();
  });

  it("renders sanitized raw HTML in assistant messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<details onclick="globalThis.__lecturnXss = 1">',
          "<summary>Safe details</summary>",
          "<script>globalThis.__lecturnXss = 2</script>",
          '<img src="x" onerror="globalThis.__lecturnXss = 3">',
          '<a href="javascript:globalThis.__lecturnXss = 4">Unsafe link</a>',
          "</details>",
        ].join(""),
        { role: "assistant" },
      ),
    ]);
    expect(screen.container.querySelector("[data-markdown-details]")?.textContent).toContain(
      "Safe details",
    );
    expect(screen.text()).not.toContain("<details");
    expect(screen.container.querySelector("script, [onclick], [onerror]")).toBeNull();
    expect(screen.container.innerHTML).not.toContain("javascript:");
    await click(screen.button("Safe details"));
    expect((globalThis as { __lecturnXss?: number }).__lecturnXss).toBeUndefined();
  });

  it("hides the per-response fork action without threadForking", async () => {
    await using screen = await renderTimeline(
      [
        {
          ...message("Done", { role: "assistant", runId: RunId.make("run-1") }, "assistant-1"),
          projectedItem: v2Item("assistant_message", {
            id: "assistant-item-1",
            messageId: "assistant-1",
            text: "Done",
            streaming: false,
          }),
        } as Entry,
      ],
      { forkFromRunEnabled: false },
    );
    expect(screen.text()).toContain("Done");
    expect(screen.buttons("Fork from this response")).toHaveLength(0);
  });

  it.each([
    [true, 1],
    [false, 0],
  ])(
    "offers per-response fork on a run-less reply by its fork point (%s)",
    async (offered, count) => {
      const replyId = MessageId.make("imported-reply-1");
      await using screen = await renderTimeline(
        [
          {
            ...message("Imported answer", { role: "assistant" }, "imported-reply-1"),
            projectedItem: v2Item("assistant_message", {
              id: "imported-item-1",
              runId: null,
              messageId: replyId,
              text: "Imported answer",
              streaming: false,
            }),
          } as Entry,
        ],
        {
          forkPointByRunlessReplyId: offered
            ? new Map([
                [
                  replyId,
                  { type: "runless" as const, messageId: MessageId.make("imported-user-1") },
                ],
              ])
            : new Map(),
        },
      );
      expect(screen.text()).toContain("Imported answer");
      expect(screen.buttons("Fork from this response")).toHaveLength(count);
    },
  );
});

describe("compact reasoning math", () => {
  it("keeps formulas while flattening compact reasoning previews", () => {
    const tree = parseMarkdownWithMath("## Reasoning\n\nUse **norm** $|x|$ and \\[x^2\\]");
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children.map((node) => node.type)).toEqual([
      "text",
      "inlineMath",
      "text",
      "inlineMath",
    ]);
    expect(tree.children.map((node) => ("value" in node ? node.value : null))).toEqual([
      "Reasoning Use norm ",
      "|x|",
      " and ",
      "x^2",
    ]);
  });
});
