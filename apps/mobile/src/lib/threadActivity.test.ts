import {
  AppId,
  MessageId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  RuntimeRequestId,
  NodeId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type ThreadImportOrigin,
} from "@lecturn/contracts";
import { createAppToolApprovalPlacer } from "@lecturn/client-runtime/state/app-tool-approval-placement";
import { derivePendingThreadRequests } from "@lecturn/client-runtime/state/thread-requests";
import { appToolRawName, appToolSource } from "@lecturn/shared/appToolPresentation";
import { workEntryAppToolSummary } from "@lecturn/client-runtime/work-log/presentation";
import { deriveThreadCheckpointSummaries } from "@lecturn/client-runtime/state/thread-checkpoints";
import { getReviewSectionIdForCheckpoint } from "../features/review/reviewModel";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadImportLabel,
  deriveTerminalAssistantMessageIds,
  shouldShowImportTruncatedNote,
  workEntryRowLabel,
  buildThreadFeed,
  threadFeedCompactionLabels,
  createThreadFeedCache,
  deriveThreadFeedPresentation,
  messageFoldRunId,
  type ThreadFeedActivity,
  type ThreadFeedCache,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
  togglePendingUserInputOptionSelection,
  setPendingUserInputCustomAnswer,
  isPendingUserInputOptionSelected,
  buildPendingUserInputAnswers,
} from "./threadActivity";

const threadId = ThreadId.make("thread-1");
const sourceThreadId = ThreadId.make("thread-source");
const runId = RunId.make("run-1");

it("keeps historical plan detail accessible from its paged turn item", () => {
  const item = {
    ...base("historical-plan", "2026-08-29T00:00:00.000Z", 1),
    type: "proposed_plan",
    planId: "plan-historical",
    markdown: "Full historical plan text",
    streaming: false,
  } as OrchestrationV2TurnItem;

  const entries = buildThreadFeed([projected(item, 0)]);
  const activity = entries.flatMap((entry) =>
    entry.type === "activity-group" ? entry.activities : [],
  )[0];
  expect(activity?.detail).toBe("Full historical plan text");
  expect(activity?.getFullDetail()).toBe("Full historical plan text");
  expect(activity?.getCopyText()).toBe("Full historical plan text\n");
  expect(activity?.prominent).toBe(true);
  const presented = deriveThreadFeedPresentation(
    buildThreadFeed([
      projected(userMessage(), 0),
      projected(command(), 1),
      projected(item, 2),
      projected(assistantMessage(), 3),
    ]),
    null,
    new Set(),
  );
  expect(presented.map((entry) => entry.type)).toEqual([
    "message",
    "run-fold",
    "activity-group",
    "message",
  ]);
  expect(presented[2]).toMatchObject({ activities: [{ projectedItem: { item } }] });
});

it("shows a compact command as one mobile divider before, during, and after compaction", () => {
  const startedAt = "2026-06-20T00:00:01.000Z";
  const prompt = projected({ ...userMessage(), text: "/compact", idleCompaction: "onReturn" }, 0);
  const latestRun = { runId, status: "running" as const, startedAt, completedAt: null };
  const present = (items: OrchestrationV2ProjectedTurnItem[]) =>
    deriveThreadFeedPresentation(
      buildThreadFeed(items),
      latestRun,
      new Set(),
      new Set(),
      startedAt,
    );

  const waiting = present([prompt]);
  expect(waiting.map((entry) => entry.type)).toEqual(["message"]);
  expect(waiting[0]?.type === "message" ? waiting[0].message.idleCompaction : null).toBe(
    "onReturn",
  );
  for (const status of ["running", "completed", "failed"] as const) {
    const compaction = projected(
      {
        ...base("compaction", "2026-06-20T00:00:02.000Z", 1),
        type: "compaction",
        driver: ProviderDriverKind.make("claude"),
        status,
        beforeTokenCount: 100_000,
        ...(status === "completed" ? { afterTokenCount: 20_000 } : {}),
        ...(status === "failed" ? { summary: "Not enough messages to compact." } : {}),
      },
      1,
    );
    const rows = present([prompt, compaction]);
    expect(rows.map((entry) => entry.type)).toEqual(["activity-group"]);
    expect(
      rows[0]?.type === "activity-group" ? rows[0].activities[0]?.projectedItem.item : null,
    ).toMatchObject({ type: "compaction", status });
  }
});

it.each(["/compact", "Continue"])(
  "keeps a completed compaction divider visible while other settled work folds for %s",
  (promptText) => {
    const rows = deriveThreadFeedPresentation(
      buildThreadFeed([
        projected({ ...userMessage(), text: promptText }, 0),
        projected(command(), 1),
        projected(
          {
            ...base("compaction", "2026-06-20T00:00:03.000Z", 2),
            type: "compaction",
            driver: ProviderDriverKind.make("claude"),
            status: "completed",
            beforeTokenCount: 100_000,
            afterTokenCount: 20_000,
          },
          2,
        ),
      ]),
      {
        runId,
        status: "completed",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: "2026-06-20T00:00:03.000Z",
      },
      new Set(),
    );
    expect(rows.filter((entry) => entry.type === "run-fold")).toHaveLength(1);
    const activities = rows.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(activities.map((activity) => activity.projectedItem.item)).toMatchObject([
      {
        type: "compaction",
        status: "completed",
        beforeTokenCount: 100_000,
        afterTokenCount: 20_000,
      },
    ]);
    if (promptText === "/compact") {
      expect(rows.some((entry) => entry.type === "message")).toBe(false);
    }
  },
);

it("binds a persisted resume answer only to the next compaction in its run", () => {
  const requestId = RuntimeRequestId.make("resume-compaction");
  const question = projected(
    {
      ...base("resume-question", "2026-06-20T00:00:02.000Z", 1),
      type: "user_input_request",
      requestId,
      questions: [],
      questionAnswer: {
        requestId,
        questionTextById: {
          resume:
            "This session is 2h 10m old and uses 200,000 tokens. Compact it before continuing?",
        },
        answers: { resume: "Compact and continue" },
        attachmentsByQuestionId: {},
      },
    },
    1,
  );
  const compaction = (id: string, position: number, status: "running" | "completed") =>
    projected(
      {
        ...base(id, `2026-06-20T00:00:0${position + 1}.000Z`, position),
        type: "compaction",
        driver: ProviderDriverKind.make("claude"),
        status,
        beforeTokenCount: 200_000,
      },
      position,
    );
  for (const status of ["running", "completed"] as const) {
    // Rebuild from persisted items, without a live question or prior feed cache.
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      question,
      compaction("resume-compact", 2, "completed"),
      compaction("auto-compact", 3, status),
    ]);
    const labels = threadFeedCompactionLabels(feed);
    const compactRows = feed.filter(
      (entry) =>
        entry.type === "activity-group" &&
        entry.activities[0]?.projectedItem.item.type === "compaction",
    );
    expect(compactRows).toHaveLength(2);
    expect(labels.get(compactRows[0]!.id)).toEqual({
      title: "Context compacted after 2h 10m idle",
      compacting: "Compacting after 2h 10m idle…",
    });
    expect(labels.get(compactRows[1]!.id)).toBeUndefined();
  }
});

function base(id: string, updatedAt: string, ordinal: number) {
  const timestamp = DateTime.makeUnsafe(updatedAt);
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

function projected(
  item: OrchestrationV2TurnItem,
  position: number,
  visibility: OrchestrationV2ProjectedTurnItem["visibility"] = "local",
): OrchestrationV2ProjectedTurnItem {
  return {
    position,
    visibility,
    sourceThreadId: visibility === "local" ? threadId : sourceThreadId,
    sourceItemId: item.id,
    item,
  };
}

function userMessage(updatedAt = "2026-06-20T00:00:01.000Z") {
  return {
    ...base("item-user", updatedAt, 0),
    type: "user_message" as const,
    messageId: MessageId.make("message-user"),
    createdBy: "user" as const,
    creationSource: "mobile" as const,
    inputIntent: "turn_start" as const,
    text: "Run checks",
    attachments: [],
  };
}

function command(updatedAt = "2026-06-20T00:00:02.000Z") {
  return {
    ...base("item-command", updatedAt, 1),
    type: "command_execution" as const,
    input: "vp check",
    output: "ok",
    exitCode: 0,
  };
}

function assistantMessage(updatedAt = "2026-06-20T00:00:03.000Z") {
  return {
    ...base("item-assistant", updatedAt, 2),
    type: "assistant_message" as const,
    messageId: MessageId.make("message-assistant"),
    text: "Done",
    streaming: false,
  };
}

describe("buildThreadFeed", () => {
  it("keeps async answers in question history instead of user bubbles", () => {
    const requestId = RuntimeRequestId.make("question");
    const question: OrchestrationV2TurnItem = {
      ...base("question", "2026-06-20T00:00:01.000Z", 0),
      type: "user_input_request",
      requestId,
      questions: [],
      questionAnswer: { requestId, answers: { color: "Blue" }, attachmentsByQuestionId: {} },
    };
    const reply: OrchestrationV2TurnItem = {
      ...userMessage(),
      id: TurnItemId.make("answer"),
      messageId: MessageId.make(`async-answer:${requestId}`),
    };
    const feed = buildThreadFeed([projected(question, 0), projected(reply, 1)]);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      type: "activity-group",
      activities: [{ workEntry: { questionAnswer: question.questionAnswer } }],
    });
    expect(buildThreadFeed([projected(reply, 0)])[0]?.type).toBe("message");
  });

  it.each([false, true])(
    "keeps answered questions outside settled work (attachments only: %s)",
    (attachmentsOnly) => {
      const requestId = RuntimeRequestId.make("answered-question");
      const question: OrchestrationV2TurnItem = {
        ...base("answered-question", "2026-06-20T00:00:02.500Z", 2),
        type: "user_input_request",
        requestId,
        questions: [],
        questionAnswer: {
          requestId,
          questionTextById: { color: "Which color?" },
          answers: { color: attachmentsOnly ? "" : "Blue" },
          attachmentsByQuestionId: attachmentsOnly
            ? {
                color: [
                  {
                    type: "file",
                    id: "color-file",
                    name: "color.txt",
                    mimeType: "text/plain",
                    sizeBytes: 4,
                  },
                ],
              }
            : {},
        },
      };
      const feed = buildThreadFeed([
        projected(userMessage(), 0),
        projected(command(), 1),
        projected(question, 2),
        projected(assistantMessage(), 3),
      ]);
      const presented = deriveThreadFeedPresentation(feed, null, new Set());
      expect(presented.map((entry) => entry.type)).toEqual([
        "message",
        "run-fold",
        "activity-group",
        "message",
      ]);
      expect(presented[2]).toMatchObject({
        activities: [{ workEntry: { questionAnswer: question.questionAnswer } }],
      });
      expect(
        deriveThreadFeedPresentation(feed, null, new Set([runId])).map((entry) => entry.type),
      ).toEqual(["message", "run-fold", "activity-group", "activity-group", "message"]);
    },
  );

  it.each([false, true])(
    "carries a late checkpoint to only the final answer without changing cached messages (cache: %s)",
    (cached) => {
      const cache = cached ? createThreadFeedCache() : undefined;
      const earlier = {
        ...assistantMessage(),
        id: TurnItemId.make("earlier-item"),
        messageId: MessageId.make("earlier-message"),
        text: "Working on the files",
      };
      const final = assistantMessage("2026-06-20T00:00:04.000Z");
      const rows = [projected(earlier, 0), projected(final, 1)];
      const before = buildThreadFeed(rows, { cache });
      const [summary] = deriveThreadCheckpointSummaries({
        messages: [earlier, final].map((message) => ({
          ...message,
          id: message.messageId,
          role: "assistant",
          createdBy: "agent",
          creationSource: "provider",
          attachments: [],
          createdAt: message.startedAt,
        })),
        checkpoints: [
          {
            id: CheckpointId.make("checkpoint-final"),
            threadId,
            scopeId: CheckpointScopeId.make("scope"),
            runId,
            nodeId: NodeId.make("node"),
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 2,
            ref: CheckpointRef.make("checkpoint-ref"),
            status: "ready",
            capturedAt: final.updatedAt,
            files: [
              { path: "src/one.ts", kind: "modified", additions: 10, deletions: 2 },
              { path: "src/two.ts", kind: "added", additions: 5, deletions: 0 },
            ],
          },
        ],
      });
      expect(summary).toBeDefined();
      if (!summary) return;
      const after = buildThreadFeed(rows, { checkpointSummaries: [summary], cache });
      expect(after[0]).toBe(before[0]);
      expect(after[1]).toMatchObject({
        type: "message",
        message: { id: final.messageId, checkpointSummary: summary },
      });
      expect(before[1]).not.toHaveProperty("message.checkpointSummary");
      expect(getReviewSectionIdForCheckpoint(summary)).toBe("turn:2");
      const fallback = deriveThreadFeedPresentation(
        [after.at(-1)!],
        null,
        new Set(),
        new Set(),
        null,
        false,
        null,
        cache,
      );
      expect(fallback.at(-1)).toMatchObject({ message: { checkpointSummary: summary } });
      const workRows = [
        projected(userMessage(), 0),
        projected(command(), 1),
        projected({ ...command(), id: TurnItemId.make("second-command") }, 2),
        projected(final, 3),
      ];
      const workBefore = buildThreadFeed(workRows, { cache });
      deriveThreadFeedPresentation(
        workBefore,
        null,
        new Set(),
        new Set(),
        null,
        false,
        null,
        cache,
      );
      const workAfter = buildThreadFeed(workRows, { checkpointSummaries: [summary], cache });
      for (const expanded of [new Set<RunId>(), new Set([runId])]) {
        const presented = deriveThreadFeedPresentation(
          workAfter,
          null,
          expanded,
          new Set(),
          null,
          false,
          null,
          cache,
        );
        expect(presented.find((entry) => entry.type === "run-fold")).toMatchObject({
          checkpointSummary: summary,
        });
        expect(presented.at(-1)).not.toHaveProperty("message.checkpointSummary");
      }
      const active = deriveThreadFeedPresentation(
        workAfter,
        {
          runId,
          status: "running",
          startedAt: "2026-06-20T00:00:00.000Z",
          completedAt: null,
        },
        new Set(),
        new Set(),
        null,
        false,
        null,
        cache,
      );
      expect(active.find((entry) => entry.type === "work-toggle")).toMatchObject({
        checkpointSummary: summary,
      });
      expect(active.at(-1)).not.toHaveProperty("message.checkpointSummary");
      expect(workBefore.at(-1)).not.toHaveProperty("message.checkpointSummary");

      for (const checkpoint of [
        { ...summary, files: [] },
        ...(["missing", "error", "stale"] as const).map((status) => ({ ...summary, status })),
        { ...summary, runId: RunId.make("another-run") },
        { ...summary, assistantMessageId: MessageId.make("unloaded-message") },
      ]) {
        expect(buildThreadFeed(rows, { checkpointSummaries: [checkpoint], cache })).toEqual(before);
      }
      expect(buildThreadFeed(rows, { cache })).toEqual(before);
    },
  );

  it("omits cached tool output and patch bodies from expanded and copied activity", () => {
    const rawOutput = "RAW_TOOL_OUTPUT";
    const items: OrchestrationV2TurnItem[] = [
      { ...command(), output: rawOutput },
      {
        ...base("dynamic-output", "2026-06-20T00:00:03.000Z", 2),
        type: "dynamic_tool",
        toolName: "example",
        input: { query: "keep input" },
        output: { text: rawOutput },
      },
      {
        ...base("file-output", "2026-06-20T00:00:04.000Z", 3),
        type: "file_change",
        fileName: "src/example.ts",
        diffStr: rawOutput,
        oldStr: rawOutput,
        newStr: rawOutput,
      },
    ];
    const activities = buildThreadFeed(items.map((item, index) => projected(item, index))).flatMap(
      (entry) => (entry.type === "activity-group" ? entry.activities : []),
    );
    expect(activities).toHaveLength(3);
    for (const activity of activities) {
      expect(activity.workEntry.detail).toBeUndefined();
      expect(activity.getFullDetail()).not.toContain(rawOutput);
      expect(activity.getCopyText()).not.toContain(rawOutput);
    }
    expect(activities[0]?.detail).toBe("vp check");
    expect(activities[1]?.getFullDetail()).toContain("keep input");
    expect(activities[2]?.detail).toBe("src/example.ts");
    expect(items[0]).toMatchObject({ output: rawOutput });
  });

  it("anchors feedback before later committed turns", () => {
    const laterUser = {
      ...userMessage("2026-08-29T00:00:05.000Z"),
      id: TurnItemId.make("item-later-user"),
      messageId: MessageId.make("message-later-user"),
      ordinal: 2,
      text: "Later user turn",
    };
    const laterAssistant = {
      ...assistantMessage("2026-08-29T00:00:04.000Z"),
      id: TurnItemId.make("item-later-assistant"),
      messageId: MessageId.make("message-later-assistant"),
      ordinal: 3,
      text: "Later assistant turn",
    };
    const localMessage = (id: string, role: "user" | "assistant") => ({
      id: MessageId.make(id),
      role,
      text: id,
      turnId: null,
      streaming: false,
      createdAt: "2026-08-29T00:00:03.000Z",
      updatedAt: "2026-08-29T00:00:03.000Z",
    });
    const feed = buildThreadFeed(
      [
        projected(userMessage("2026-08-29T00:00:01.000Z"), 0),
        projected(laterUser, 1),
        projected(laterAssistant, 2),
      ],
      {
        anchoredMessages: [
          localMessage("feedback-user", "user"),
          localMessage("feedback-assistant", "assistant"),
          localMessage("message-later-user", "user"),
        ],
      },
    );
    const messages = feed.filter((entry) => entry.type === "message");

    expect(messages.map((entry) => entry.id)).toEqual([
      "message-user",
      "feedback-user",
      "feedback-assistant",
      "message-later-user",
      "message-later-assistant",
    ]);
    expect(
      messages
        .filter((entry) => entry.id.startsWith("feedback-"))
        .every((entry) => entry.message.projectedItem === undefined),
    ).toBe(true);
  });

  it("preserves authoritative V2 order instead of sorting reconstructed collections", () => {
    const rows = [
      projected(userMessage("2026-06-20T00:00:03.000Z"), 0),
      projected(command("2026-06-20T00:00:01.000Z"), 1),
      projected(assistantMessage("2026-06-20T00:00:02.000Z"), 2),
    ];

    const feed = buildThreadFeed(rows);
    expect(feed.map((entry) => entry.type)).toEqual(["message", "activity-group", "message"]);
    expect(feed.map((entry) => entry.id)).toEqual([
      "message-user",
      "local:thread-1:item-command",
      "message-assistant",
    ]);
    const activity = feed.find((entry) => entry.type === "activity-group")?.activities[0];
    expect(activity?.projectedItem).toBe(rows[1]);
    expect(activity?.getFullDetail()).toContain('"input": "vp check"');
  });

  it("keeps adjacent work from different V2 attempts in separate groups", () => {
    const firstRootNodeId = NodeId.make("node-attempt-1");
    const secondRootNodeId = NodeId.make("node-attempt-2");
    const firstCommand = { ...command(), nodeId: firstRootNodeId };
    const secondCommand = {
      ...command("2026-06-20T00:00:03.000Z"),
      id: TurnItemId.make("item-command-retry"),
      ordinal: 2,
      nodeId: secondRootNodeId,
    };
    const attempts = [
      {
        id: RunAttemptId.make("attempt-1"),
        runId,
        attemptOrdinal: 1,
        rootNodeId: firstRootNodeId,
        providerInstanceId: ProviderInstanceId.make("provider-instance-1"),
        providerThreadId: ProviderThreadId.make("provider-thread-1"),
        providerTurnId: null,
        reason: "initial",
        status: "completed",
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:01.000Z"),
        completedAt: DateTime.makeUnsafe("2026-06-20T00:00:02.000Z"),
      },
      {
        id: RunAttemptId.make("attempt-2"),
        runId,
        attemptOrdinal: 2,
        rootNodeId: secondRootNodeId,
        providerInstanceId: ProviderInstanceId.make("provider-instance-1"),
        providerThreadId: ProviderThreadId.make("provider-thread-1"),
        providerTurnId: null,
        reason: "retry",
        status: "completed",
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:02.000Z"),
        completedAt: DateTime.makeUnsafe("2026-06-20T00:00:03.000Z"),
      },
    ] satisfies ReadonlyArray<OrchestrationV2RunAttempt>;

    const feed = buildThreadFeed([projected(firstCommand, 0), projected(secondCommand, 1)], {
      attempts,
    });

    expect(feed).toHaveLength(2);
    expect(
      feed.map((entry) =>
        entry.type === "activity-group" ? entry.activities[0]?.attemptId : null,
      ),
    ).toEqual(["attempt-1", "attempt-2"]);
  });

  it("retains inherited and synthetic rows with their original projected identity", () => {
    const inherited = projected(command(), 0, "inherited");
    const { providerThreadId: _providerThreadId, ...forkBase } = base(
      "item-fork",
      "2026-06-20T00:00:03.000Z",
      2,
    );
    const synthetic = projected(
      {
        ...forkBase,
        type: "fork",
        source: { type: "run", threadId: sourceThreadId, runId },
        targetThreadId: threadId,
      },
      1,
      "synthetic",
    );

    const feed = buildThreadFeed([inherited, synthetic]);
    const activities = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(activities.map((activity) => activity.projectedItem)).toEqual([inherited, synthetic]);
    expect(activities.map((activity) => activity.projectedItem.visibility)).toEqual([
      "inherited",
      "synthetic",
    ]);
    expect(activities.at(-1)?.prominent).toBe(true);
  });

  it("names the fold that hides a progress message, with or without a run", () => {
    const middle = {
      ...assistantMessage("2026-06-20T00:00:02.500Z"),
      id: TurnItemId.make("item-middle"),
      messageId: MessageId.make("message-middle"),
      text: "Needle found in the build config.",
    };
    const items = [userMessage(), command(), middle, assistantMessage()];
    for (const runless of [false, true]) {
      const feed = buildThreadFeed(
        items.map((item, position) =>
          projected(runless ? { ...item, runId: null } : item, position),
        ),
      );
      const foldRunId = messageFoldRunId(feed, "message-middle");
      expect(foldRunId, String(runless)).toBe(runless ? "runless:message-user" : runId);
      const ids = (expanded: ReadonlySet<RunId>) =>
        deriveThreadFeedPresentation(feed, null, expanded).map((entry) => entry.id);
      expect(ids(new Set())).not.toContain("message-middle");
      expect(ids(new Set([foldRunId!]))).toContain("message-middle");
    }
    expect(messageFoldRunId(buildThreadFeed([projected(userMessage(), 0)]), "message-user")).toBe(
      null,
    );
  });

  it("folds progress messages while keeping the final assistant answer visible", () => {
    const opening = {
      ...assistantMessage("2026-06-20T00:00:01.500Z"),
      id: TurnItemId.make("item-opening"),
      messageId: MessageId.make("message-opening"),
      text: "I will check the deployment configuration.",
    };
    const middle = {
      ...assistantMessage("2026-06-20T00:00:02.500Z"),
      id: TurnItemId.make("item-middle"),
      messageId: MessageId.make("message-middle"),
      text: "The configuration is valid; checking the build next.",
    };
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(opening, 1),
      projected(command(), 2),
      projected(middle, 3),
      projected(assistantMessage(), 4),
    ]);
    const latestRun = {
      runId,
      status: "completed" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:03.000Z",
    };

    const collapsed = deriveThreadFeedPresentation(feed, latestRun, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual([
      "message-user",
      "run-fold:run-1",
      "message-assistant",
    ]);
    expect(collapsed[1]).toMatchObject({
      type: "run-fold",
      createdAt: "2026-06-20T00:00:01.500Z",
      label: "Worked for 2.0s",
    });

    const expanded = deriveThreadFeedPresentation(feed, latestRun, new Set([runId]));
    expect(expanded.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "message",
      "activity-group",
      "message",
      "message",
    ]);
    expect(expanded[4]).toMatchObject({ message: { id: middle.messageId, text: middle.text } });

    const active = deriveThreadFeedPresentation(
      feed,
      { ...latestRun, status: "running", completedAt: null },
      new Set(),
    );
    expect(active.filter((entry) => entry.type === "message").map((entry) => entry.id)).toEqual([
      "message-user",
      "message-opening",
      "message-middle",
      "message-assistant",
    ]);
  });

  // regression: #21393 show plans and fold settled progress notes
  it("folds progress even when a response has no tool calls", () => {
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(
        {
          ...assistantMessage("2026-06-20T00:00:02.000Z"),
          id: TurnItemId.make("item-opening"),
          messageId: MessageId.make("message-opening"),
          text: "The result is ready.",
        },
        1,
      ),
      projected(assistantMessage(), 2),
    ]);

    const presented = deriveThreadFeedPresentation(feed, null, new Set());
    expect(presented.map((entry) => entry.id)).toEqual([
      "message-user",
      "run-fold:run-1",
      "message-assistant",
    ]);
  });

  it("folds subagents while keeping created-thread and fork cards visible", () => {
    const { providerThreadId: _providerThreadId, ...forkBase } = base(
      "item-fork",
      "2026-06-20T00:00:02.000Z",
      2,
    );
    const resourceItems = [
      {
        ...base("item-subagent", "2026-06-20T00:00:01.500Z", 1),
        type: "subagent",
        subagentId: NodeId.make("child-agent"),
        origin: "app_owned",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        childThreadId: sourceThreadId,
        prompt: "Inspect the deployment configuration",
        result: "Configuration is valid",
      },
      {
        ...forkBase,
        type: "fork",
        source: { type: "run", threadId, runId },
        targetThreadId: sourceThreadId,
      },
      {
        ...base("item-created-thread", "2026-06-20T00:00:04.000Z", 4),
        type: "thread_created",
        targetThreadId: sourceThreadId,
        targetRunId: null,
        targetProviderInstanceId: ProviderInstanceId.make("codex"),
        targetModel: "gpt-5.4",
      },
    ] satisfies ReadonlyArray<OrchestrationV2TurnItem>;
    const projectedResources = [
      projected(resourceItems[0]!, 1),
      projected(resourceItems[1]!, 2),
      projected(resourceItems[2]!, 4),
    ];
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projectedResources[0]!,
      projectedResources[1]!,
      projected(command("2026-06-20T00:00:03.000Z"), 3),
      projectedResources[2]!,
      projected(assistantMessage("2026-06-20T00:00:05.000Z"), 5),
    ]);

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    expect(collapsed.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "activity-group",
      "activity-group",
      "message",
    ]);
    expect(collapsed[1]).toMatchObject({
      type: "run-fold",
      createdAt: "2026-06-20T00:00:01.500Z",
    });
    expect(
      collapsed.flatMap((entry) =>
        entry.type === "activity-group"
          ? entry.activities.map((activity) => activity.projectedItem)
          : [],
      ),
    ).toEqual(projectedResources.slice(1));
    const expanded = deriveThreadFeedPresentation(feed, null, new Set([runId]));
    expect(
      expanded.some(
        (entry) =>
          entry.type === "activity-group" &&
          entry.activities.some((activity) => activity.projectedItem.item.type === "subagent"),
      ),
    ).toBe(true);
  });

  it("keeps a settled run's still-running subagents visible while its other work folds", () => {
    const subagent = (
      id: string,
      updatedAt: string,
      ordinal: number,
      status: OrchestrationV2TurnItem["status"],
    ): OrchestrationV2TurnItem => ({
      ...base(id, updatedAt, ordinal),
      providerTurnId: ProviderTurnId.make("provider-turn-1"),
      status,
      completedAt: status === "running" ? null : DateTime.makeUnsafe(updatedAt),
      type: "subagent",
      subagentId: NodeId.make(id),
      origin: "app_owned",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: sourceThreadId,
      prompt: `Inspect ${id}`,
      result: null,
    });
    const latestRun = {
      runId,
      status: "completed" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:05.000Z",
    };
    const present = (children: ReadonlyArray<OrchestrationV2TurnItem>) =>
      deriveThreadFeedPresentation(
        buildThreadFeed([
          projected(userMessage(), 0),
          projected(command("2026-06-20T00:00:02.000Z"), 1),
          ...children.map((child, index) => projected(child, index + 2)),
          projected(assistantMessage("2026-06-20T00:00:05.000Z"), 5),
        ]),
        latestRun,
        new Set(),
      );
    const visibleSubagentIds = (presented: ReadonlyArray<ThreadFeedEntry>) =>
      presented.flatMap((entry) =>
        entry.type === "activity-group"
          ? entry.activities.flatMap((activity) =>
              activity.projectedItem.item.type === "subagent"
                ? [activity.projectedItem.item.id]
                : [],
            )
          : [],
      );

    const live = present([subagent("item-live", "2026-06-20T00:00:03.000Z", 2, "running")]);
    expect(live.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "activity-group",
      "message",
    ]);
    expect(visibleSubagentIds(live)).toEqual(["item-live"]);

    const mixed = present([
      subagent("item-done", "2026-06-20T00:00:03.000Z", 2, "completed"),
      subagent("item-live", "2026-06-20T00:00:04.000Z", 3, "running"),
    ]);
    expect(visibleSubagentIds(mixed)).toEqual(["item-done", "item-live"]);

    const finished = present([subagent("item-done", "2026-06-20T00:00:03.000Z", 2, "completed")]);
    expect(finished.map((entry) => entry.type)).toEqual(["message", "run-fold", "message"]);
  });

  it("folds each run of a provider-native subagent thread like a normal turn", () => {
    const runless = <T extends OrchestrationV2TurnItem>(item: T, id: string, ordinal: number) => ({
      ...item,
      id: TurnItemId.make(id),
      runId: null,
      ordinal,
    });
    const prompt = (id: string, ordinal: number, at: string) =>
      runless(
        { ...userMessage(at), messageId: MessageId.make(id), creationSource: "provider" as const },
        id,
        ordinal,
      );
    const answer = (id: string, ordinal: number, at: string) =>
      runless({ ...assistantMessage(at), messageId: MessageId.make(id) }, id, ordinal);
    const { exitCode: _exitCode, ...completedCommand } = command("2026-06-20T00:01:17.000Z");
    const feed = (resumeRunning: boolean) =>
      buildThreadFeed(
        [
          prompt("launch", 1, "2026-06-20T00:00:00.000Z"),
          runless(command("2026-06-20T00:00:04.000Z"), "launch-ls", 2),
          answer("launch-answer", 3, "2026-06-20T00:00:08.000Z"),
          prompt("resume", 4, "2026-06-20T00:01:12.000Z"),
          resumeRunning
            ? runless(
                { ...completedCommand, status: "running", completedAt: null, output: "" },
                "resume-ls",
                5,
              )
            : runless(command("2026-06-20T00:01:17.000Z"), "resume-ls", 5),
          ...(resumeRunning ? [] : [answer("resume-answer", 6, "2026-06-20T00:01:20.000Z")]),
        ].map((item, position) => projected(item, position)),
      );
    const shape = (entries: ReadonlyArray<ThreadFeedEntry>) =>
      entries.map((entry) =>
        entry.type === "run-fold"
          ? `fold:${entry.label}`
          : entry.type === "message"
            ? `${entry.message.role}:${entry.message.id}`
            : entry.type,
      );

    const settled = deriveThreadFeedPresentation(feed(false), null, new Set());
    expect(shape(settled)).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8.0s",
      "assistant:resume-answer",
    ]);
    const launchFold = settled.find((entry) => entry.type === "run-fold");
    if (launchFold?.type !== "run-fold") throw new Error("Expected the launch fold");
    expect(
      shape(deriveThreadFeedPresentation(feed(false), null, new Set([launchFold.runId]))),
    ).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "activity-group",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8.0s",
      "assistant:resume-answer",
    ]);

    expect(
      shape(
        deriveThreadFeedPresentation(
          feed(true),
          null,
          new Set(),
          new Set(),
          "2026-06-20T00:01:12.000Z",
          true,
        ),
      ),
    ).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "assistant:launch-answer",
      "user:resume",
      "activity-group",
    ]);
  });

  it("keeps imported V1 turns folded once the thread's first V2 run starts", () => {
    const imported = <T extends OrchestrationV2TurnItem>(item: T, id: string) => ({
      ...item,
      id: TurnItemId.make(id),
      runId: null,
    });
    const presented = (start: OrchestrationV2TurnItem) =>
      deriveThreadFeedPresentation(
        buildThreadFeed(
          [
            imported(userMessage("2026-06-20T00:00:00.000Z"), "imported-prompt"),
            imported(
              {
                ...assistantMessage("2026-06-20T00:00:02.000Z"),
                messageId: MessageId.make("update"),
              },
              "imported-update",
            ),
            imported(command("2026-06-20T00:00:04.000Z"), "imported-ls"),
            imported(
              {
                ...assistantMessage("2026-06-20T00:00:08.000Z"),
                messageId: MessageId.make("answer"),
              },
              "imported-answer",
            ),
            start,
          ].map((item, position) => projected(item, position)),
        ),
        { runId, status: "running", startedAt: "2026-06-20T00:01:00.000Z", completedAt: null },
        new Set(),
        new Set(),
        "2026-06-20T00:01:00.000Z",
      )
        .slice(0, 3)
        .map((entry) => (entry.type === "message" ? entry.message.role : entry.type));

    expect(
      presented({
        ...userMessage("2026-06-20T00:01:00.000Z"),
        id: TurnItemId.make("new-prompt"),
        messageId: MessageId.make("new-prompt"),
      }),
    ).toEqual(["user", "run-fold", "assistant"]);
    expect(
      presented({
        ...base("wake", "2026-06-20T00:01:00.000Z", 4),
        type: "notification",
        source: { kind: "background_task" },
        outcome: "completed",
        summary: "Background task finished",
      }),
    ).toEqual(["user", "run-fold", "assistant"]);
  });

  it("keeps a provider-native subagent's runless tool call live while it works", () => {
    const startedAt = "2026-06-20T00:00:01.000Z";
    const { exitCode: _exitCode, ...completedCommand } = command();
    const runningCommand: OrchestrationV2TurnItem = {
      ...completedCommand,
      runId: null,
      status: "running",
      completedAt: null,
      output: "",
    };
    const feed = buildThreadFeed([
      projected({ ...userMessage(), runId: null }, 0),
      projected(runningCommand, 1),
    ]);

    const presented = deriveThreadFeedPresentation(
      feed,
      null,
      new Set(),
      new Set(),
      startedAt,
      true,
    );
    expect(presented.find((entry) => entry.type === "activity-group")).toMatchObject({
      id: "live-activity-row",
      activities: [{ live: true, groupStandIn: { label: "Running vp" } }],
    });
    expect(presented.some((entry) => entry.type === "thinking")).toBe(false);
  });

  it("does not show Thinking once the open run's provider turn has ended", () => {
    const startedAt = "2026-04-01T00:00:01.000Z";
    const run = { runId, status: "running" as const, startedAt, completedAt: null };
    expect(
      deriveThreadFeedPresentation(
        [],
        { ...run, turnEnded: true },
        new Set(),
        new Set(),
        startedAt,
      ),
    ).toEqual([]);
  });
});

describe("retained v2 feed presentation", () => {
  it("retains unchanged rows while the assistant streams", () => {
    const rows = [
      projected(userMessage(), 0),
      projected(command(), 1),
      projected({ ...assistantMessage(), streaming: true }, 2),
    ];
    const latestRun = {
      runId,
      status: "running" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: null,
    };
    const before = buildThreadFeed(rows);
    const beforePresentation = deriveThreadFeedPresentation(
      before,
      latestRun,
      new Set(),
      new Set(),
      latestRun.startedAt,
    );
    const after = buildThreadFeed([
      rows[0]!,
      rows[1]!,
      projected(
        { ...assistantMessage("2026-06-20T00:00:04.000Z"), text: "Still working", streaming: true },
        2,
      ),
    ]);
    const afterPresentation = deriveThreadFeedPresentation(
      after,
      latestRun,
      new Set(),
      new Set(),
      latestRun.startedAt,
    );
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(afterPresentation[0]).toBe(beforePresentation[0]);
    expect(afterPresentation[1]).toBe(beforePresentation[1]);
  });

  it.each([
    { envelope: "direct", output: { taskId: "a" } },
    { envelope: "structured", output: { structuredContent: { taskId: "a" } } },
    { envelope: "text", output: { content: [{ type: "text", text: '{"taskId":"a"}' }] } },
  ])(
    "folds matched $envelope delegations without hiding pending, failed or unmatched calls",
    ({ output }) => {
      const agent = (
        id: string,
        index: number,
        origin = "app_owned" as "app_owned" | "provider_native",
      ) =>
        projected(
          {
            ...base(id, "2026-06-20T00:00:01.000Z", index),
            type: "subagent",
            subagentId: NodeId.make(id),
            origin,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            childThreadId: ThreadId.make(`child-${id}`),
            prompt: "Identical task",
            result: "Done",
          },
          index,
        );
      const delegation = (
        id: string,
        index: number,
        overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>> = {},
      ) =>
        projected(
          {
            ...base(id, "2026-06-20T00:00:02.000Z", index),
            type: "dynamic_tool",
            toolName: "lecturn.delegate_task",
            input: { task: "Identical task" },
            output,
            ...overrides,
          },
          index,
        );
      const feed = buildThreadFeed([
        agent("a", 1),
        delegation("matched", 2),
        agent("b", 3),
        delegation("pending", 4, { status: "running", output: null }),
        delegation("unmatched", 5, { output: { taskId: "missing" } }),
        delegation("failed", 6, { status: "failed" }),
        delegation("error-output", 7, { output: { taskId: "a", isError: true } }),
        delegation("other-run", 8, { runId: RunId.make("other-run") }),
        agent("native", 9, "provider_native"),
        delegation("native-delegation", 10, { output: { taskId: "native" } }),
      ]);
      const groups = feed.flatMap((entry) =>
        entry.type === "activity-group"
          ? [entry.activities.map((activity) => activity.projectedItem.item.id)]
          : [],
      );
      expect(groups[0]).toEqual(["a", "b"]);
      expect(groups.flat()).toEqual([
        "a",
        "b",
        "pending",
        "unmatched",
        "failed",
        "error-output",
        "other-run",
        "native",
        "native-delegation",
      ]);
      const presented = deriveThreadFeedPresentation(
        feed,
        null,
        new Set([runId, RunId.make("other-run")]),
      );
      expect(
        presented.find(
          (entry) =>
            entry.type === "activity-group" && entry.activities[0]?.projectedItem.item.id === "a",
        )?.continuesWorkLog,
      ).toBeUndefined();
    },
  );

  it("groups only adjacent subagents in the same run, keeping their child links", () => {
    const agent = (id: string, index: number, agentRunId = runId) =>
      projected(
        {
          ...base(id, `2026-06-20T00:00:0${index}.000Z`, index),
          type: "subagent",
          runId: agentRunId,
          subagentId: NodeId.make(id),
          origin: "app_owned",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          childThreadId: ThreadId.make(`child-${id}`),
          prompt: "Solve the puzzle",
          result: "Done",
        },
        index,
      );
    const feed = buildThreadFeed([
      agent("a", 1),
      agent("b", 2),
      projected(command("2026-06-20T00:00:03.000Z"), 3),
      agent("c", 4),
      agent("d", 5, RunId.make("other-run")),
    ]);
    expect(
      feed.flatMap((entry) =>
        entry.type === "activity-group"
          ? [entry.activities.map((activity) => activity.projectedItem.item.id)]
          : [],
      ),
    ).toEqual([["a", "b"], ["item-command"], ["c"], ["d"]]);
    const presented = deriveThreadFeedPresentation(
      feed,
      null,
      new Set([runId, RunId.make("other-run")]),
    );
    const groups = presented.flatMap((entry) =>
      entry.type === "activity-group" && entry.activities[0]?.projectedItem.item.type === "subagent"
        ? [entry]
        : [],
    );
    expect(groups.map((entry) => entry.activities.length)).toEqual([2, 1, 1]);
    expect(groups[0]?.activities.map((activity) => activity.projectedItem.item)).toMatchObject([
      { childThreadId: "child-a" },
      { childThreadId: "child-b" },
    ]);
  });
});

const singleSelectQuestion = {
  id: "runtime",
  header: "Runtime",
  question: "Which runtime should be used?",
  options: [
    { label: "Go", description: "One binary" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;

describe("subagent continued by a later turn", () => {
  const run2 = RunId.make("run-2");
  const at = (second: number) => `2026-10-09T10:00:${String(second).padStart(2, "0")}.000Z`;
  const item = (id: string, itemRunId: RunId, ordinal: number, second: number) => ({
    ...base(id, at(second), ordinal),
    runId: itemRunId,
  });
  const user = (id: string, itemRunId: RunId, ordinal: number, second: number) => ({
    ...item(id, itemRunId, ordinal, second),
    type: "user_message" as const,
    messageId: MessageId.make(id),
    createdBy: "user" as const,
    creationSource: "mobile" as const,
    inputIntent: "turn_start" as const,
    text: `Prompt ${id}`,
    attachments: [],
  });
  const assistant = (id: string, itemRunId: RunId, ordinal: number, second: number) => ({
    ...item(id, itemRunId, ordinal, second),
    type: "assistant_message" as const,
    messageId: MessageId.make(id),
    text: `Answer ${id}`,
    streaming: false,
  });
  const reasoning = (id: string, itemRunId: RunId, ordinal: number, second: number) => ({
    ...item(id, itemRunId, ordinal, second),
    type: "reasoning" as const,
    text: "Thinking",
    streaming: false,
  });
  const items: OrchestrationV2TurnItem[] = [
    user("prompt-1", runId, 1_000_001, 0),
    reasoning("reasoning-1", runId, 1_000_002, 1),
    {
      ...item("subagent", run2, 1_000_003, 2),
      type: "subagent",
      subagentId: NodeId.make("subagent"),
      origin: "provider_native",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: null,
      prompt: "Research the bug",
      result: "Found it",
    },
    assistant("answer-1", runId, 1_000_004, 3),
    user("prompt-2", run2, 2_000_001, 30),
    reasoning("reasoning-2", run2, 2_000_002, 31),
    assistant("answer-2", run2, 2_000_003, 32),
    {
      ...item("send-message", run2, 2_000_004, 33),
      type: "dynamic_tool",
      toolName: "SendMessage",
      input: { to: "subagent" },
      output: "Sent",
    },
    assistant("closing-2", run2, 2_000_005, 41),
  ];

  it("keeps each turn's fold between its own prompt and answer", () => {
    const presented = deriveThreadFeedPresentation(
      buildThreadFeed(items.map((entry, index) => projected(entry, index))),
      { runId: run2, status: "completed", startedAt: at(30), completedAt: at(41) },
      new Set(),
    );
    expect(presented.map((entry) => entry.id)).toEqual([
      "prompt-1",
      `run-fold:${runId}`,
      "answer-1",
      "prompt-2",
      `run-fold:${run2}`,
      "closing-2",
    ]);
  });
});

describe("pending user input answers", () => {
  it("preserves exact editor text, including a deliberately cleared answer", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    expect(
      buildPendingUserInputAnswers([question], {
        runtime: { customAnswer: question.initialAnswer },
      }),
    ).toEqual({ runtime: question.initialAnswer });
    expect(
      buildPendingUserInputAnswers([question], {
        runtime: { customAnswer: "  Edited message\n\n" },
      }),
    ).toEqual({ runtime: "  Edited message\n\n" });
    expect(buildPendingUserInputAnswers([question], { runtime: { customAnswer: "" } })).toEqual({
      runtime: "",
    });
    expect(buildPendingUserInputAnswers([question], { runtime: { customAnswer: " \n" } })).toEqual({
      runtime: " \n",
    });
    expect(setPendingUserInputCustomAnswer(question, { selectedOptionValues: ["Go"] }, "")).toEqual(
      { customAnswer: "" },
    );
  });
});

describe("provider question values", () => {
  const question = {
    ...singleSelectQuestion,
    allowCustomAnswer: false,
    options: [
      { label: "Same label", value: "  exact first  ", description: "First" },
      { label: "Same label", value: "second", description: "Second" },
    ],
  } as const;

  it("submits raw option values and distinguishes duplicate labels", () => {
    const first = togglePendingUserInputOptionSelection(question, undefined, "  exact first  ");
    expect(isPendingUserInputOptionSelected(question, first, "  exact first  ")).toBe(true);
    expect(isPendingUserInputOptionSelected(question, first, "second")).toBe(false);
    expect(buildPendingUserInputAnswers([question], { runtime: first })).toEqual({
      runtime: "  exact first  ",
    });
    expect(togglePendingUserInputOptionSelection(question, first, "Same label")).toBe(first);
  });

  it("rejects arbitrary text when the provider only accepts offered options", () => {
    expect(setPendingUserInputCustomAnswer(question, undefined, "Other")).toEqual({});
    expect(
      buildPendingUserInputAnswers([question], { runtime: { customAnswer: "Other" } }),
    ).toBeNull();
    expect(
      buildPendingUserInputAnswers([question], { runtime: { selectedOptionValues: ["unknown"] } }),
    ).toBeNull();
    expect(
      buildPendingUserInputAnswers([question], {
        runtime: { selectedOptionValues: ["second"], customAnswer: "stale draft" },
      }),
    ).toEqual({ runtime: "second" });
  });
});

it("accepts ready attachment-only answers while preserving selected options", () => {
  const question = {
    id: "q",
    header: "Spec",
    question: "Provide a specification",
    options: [{ label: "Yes", description: "Approve" }],
    multiSelect: false,
  };
  expect(buildPendingUserInputAnswers([question], { q: { attachmentCount: 1 } })).toEqual({
    q: "",
  });
  expect(
    buildPendingUserInputAnswers([question], {
      q: { attachmentCount: 1, selectedOptionValues: ["Yes"] },
    }),
  ).toEqual({ q: "Yes" });
  expect(
    buildPendingUserInputAnswers([question], {
      q: { attachmentCount: 1, attachmentsBlocked: true },
    }),
  ).toBeNull();
  expect(
    buildPendingUserInputAnswers([{ ...question, allowCustomAnswer: false }], {
      q: { attachmentCount: 1 },
    }),
  ).toBeNull();
});

it("stops stranded thinking after a steer and follows the next thought or tool", () => {
  const at = "2026-06-20T00:00:02.000Z";
  const thought = (id: string): OrchestrationV2TurnItem => ({
    ...base(id, at, 1),
    type: "reasoning",
    status: "running",
    completedAt: null,
    streaming: true,
    text: id,
  });
  const first = thought("first-thought");
  const next = thought("next-thought");
  const steer = { ...userMessage(at), inputIntent: "steer" as const };
  const tool = { ...command(at), status: "running" as const, completedAt: null };
  const rows = (items: ReadonlyArray<OrchestrationV2TurnItem>, expanded = new Set<string>()) =>
    deriveThreadFeedPresentation(
      buildThreadFeed(items.map((item, position) => projected(item, position))),
      { runId, status: "running", startedAt: at, completedAt: null },
      new Set(),
      expanded,
      at,
    );
  expect(rows([first]).find((row) => row.type === "work-toggle")).toMatchObject({
    summary: "Thinking",
    thought: "first-thought",
    live: true,
    shimmer: true,
  });
  const afterSteer = rows([first, steer]);
  expect(afterSteer.find((row) => row.type === "work-toggle")).toMatchObject({
    live: false,
    shimmer: false,
  });
  expect(afterSteer.at(-1)?.type).toBe("thinking");
  const header = afterSteer.find((row) => row.type === "work-toggle");
  if (header?.type !== "work-toggle") throw new Error("Expected thought toggle");
  const expanded = rows([first, steer], new Set([header.groupId]));
  expect(expanded.find((row) => row.type === "work-toggle")).toMatchObject({ summary: "Thought" });
  expect(expanded.find((row) => row.type === "activity-group")).toMatchObject({
    activities: [{ lifecycleStatus: "completed", workEntry: { toolLifecycleStatus: "completed" } }],
  });
  for (const items of [
    [first, steer, next],
    [first, next],
    [first, steer, next, tool],
  ]) {
    const live = rows(items).filter((row) => row.type === "work-toggle" && row.shimmer);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject(
      items.at(-1)!.type === "reasoning"
        ? { summary: "Thinking", thought: "next-thought" }
        : { summary: "Running vp" },
    );
  }
  expect(first.status).toBe("running");
});

it.each(["provider_error", "usage_limit"] as const)(
  "keeps a historical %s failure and preceding work visible without disclosures",
  (failureClass) => {
    const at = "2026-06-20T00:00:03.000Z";
    const error: OrchestrationV2TurnItem = {
      ...base("failure", at, 2),
      type: "error",
      status: "failed",
      failure: {
        class: failureClass,
        message: "The provider stopped this turn.\nRetry later.",
        code: null,
        retryable: true,
      },
    };
    const command: OrchestrationV2TurnItem = {
      ...base("command", "2026-06-20T00:00:02.000Z", 1),
      type: "command_execution",
      input: "pwd",
      output: "",
      exitCode: 0,
    };
    const sourceFeed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(command, 1),
      projected(error, 2),
    ]);
    const feed = deriveThreadFeedPresentation(
      sourceFeed,
      { runId: RunId.make("newer-run"), status: "completed", startedAt: at, completedAt: at },
      new Set(),
    );
    const whileWorking = deriveThreadFeedPresentation(
      sourceFeed,
      { runId: RunId.make("newer-run"), status: "running", startedAt: at, completedAt: null },
      new Set(),
    );
    for (const entry of feed) {
      expect(whileWorking.find((row) => row.id === entry.id)).toBe(entry);
    }
    expect(feed.some((entry) => entry.type === "run-fold" || entry.type === "work-toggle")).toBe(
      false,
    );
    const activities = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(activities.map((activity) => activity.projectedItem.item.id)).toEqual([
      "command",
      "failure",
    ]);
    expect(activities.at(-1)).toMatchObject({
      detail: error.failure.message,
      createdAt: at,
      canExpand: false,
      prominent: true,
    });
  },
);

describe("imported thread history (Lecturn)", () => {
  const importedAt = "2026-04-01T00:00:10.000Z";
  const claudeImport: ThreadImportOrigin = {
    providerInstanceId: ProviderInstanceId.make("claude"),
    driverKind: ProviderDriverKind.make("claudeAgent"),
    sessionId: "session-1",
    cwd: "/repo",
    title: "Ship the importer",
    importedAt,
    historyTruncated: false,
  };
  const newRunId = RunId.make("run-new");
  const latestRun = {
    runId: newRunId,
    status: "completed" as const,
    startedAt: "2026-04-01T00:01:01.000Z",
    completedAt: "2026-04-01T00:01:09.000Z",
  };

  function message(
    id: string,
    role: "user" | "assistant",
    at: string,
    ordinal: number,
    messageRunId: RunId | null,
  ): OrchestrationV2TurnItem {
    return role === "user"
      ? {
          ...base(`item-${id}`, at, ordinal),
          runId: messageRunId,
          type: "user_message",
          messageId: MessageId.make(id),
          createdBy: "user",
          creationSource: "mobile",
          inputIntent: "turn_start",
          text: id,
          attachments: [],
        }
      : {
          ...base(`item-${id}`, at, ordinal),
          runId: messageRunId,
          type: "assistant_message",
          messageId: MessageId.make(id),
          text: id,
          streaming: false,
        };
  }

  function tool(id: string, at: string, ordinal: number, toolRunId: RunId | null) {
    return {
      ...base(id, at, ordinal),
      runId: toolRunId,
      type: "command_execution" as const,
      input: `echo ${id}`,
      output: "ok",
      exitCode: 0,
    } satisfies OrchestrationV2TurnItem;
  }

  function importedRows(options: { readonly olderTool?: boolean } = {}) {
    const items: OrchestrationV2TurnItem[] = [
      message("imported-user", "user", "2026-04-01T00:00:01.000Z", 0, null),
      ...(options.olderTool
        ? [tool("imported-tool-older", "2026-04-01T00:00:01.500Z", 1, null)]
        : []),
      tool("imported-tool", "2026-04-01T00:00:02.000Z", 2, null),
      message("imported-assistant-first", "assistant", "2026-04-01T00:00:03.000Z", 3, null),
      message("imported-assistant-last", "assistant", "2026-04-01T00:00:04.000Z", 4, null),
      message("new-user", "user", "2026-04-01T00:01:00.000Z", 5, newRunId),
      tool("new-tool", "2026-04-01T00:01:05.000Z", 6, newRunId),
      message("new-assistant", "assistant", "2026-04-01T00:01:08.000Z", 7, newRunId),
    ];
    return buildThreadFeed(items.map((item, position) => projected(item, position)));
  }

  it("folds an imported exchange like a run and divides it from new work", () => {
    const feed = importedRows();
    const collapsed = deriveThreadFeedPresentation(
      feed,
      latestRun,
      new Set(),
      new Set(),
      null,
      false,
      claudeImport,
    );
    // The settled fold keeps only the imported exchange's terminal reply (upstream #21393).
    expect(collapsed.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "message",
      "import-divider",
      "message",
      "run-fold",
      "message",
    ]);
    // Imported timestamps are rewritten by the import, so the fold claims no duration.
    expect(collapsed[1]).toMatchObject({
      type: "run-fold",
      runId: "imported:imported-user",
      label: "Worked",
      expanded: false,
    });
    expect(collapsed[3]).toMatchObject({
      type: "import-divider",
      label: expect.stringContaining("Imported from Claude Code · "),
    });

    const expanded = deriveThreadFeedPresentation(
      feed,
      latestRun,
      new Set([RunId.make("imported:imported-user")]),
      new Set(),
      null,
      false,
      claudeImport,
    );
    expect(expanded[1]).toMatchObject({ type: "run-fold", expanded: true });
    // The imported run's one call is its own row, with no group header.
    expect(expanded.some((entry) => entry.type === "activity-group")).toBe(true);
  });

  it("keeps an imported fold's key when an older page prepends into its run", () => {
    const foldKeys = (feed: ReadonlyArray<ThreadFeedEntry>) =>
      deriveThreadFeedPresentation(
        feed,
        latestRun,
        new Set(),
        new Set(),
        null,
        false,
        claudeImport,
      ).flatMap((entry) => (entry.type === "run-fold" ? [entry.runId] : []));
    expect(foldKeys(importedRows())).toEqual(["imported:imported-user", newRunId]);
    expect(foldKeys(importedRows({ olderTool: true }))).toEqual([
      "imported:imported-user",
      newRunId,
    ]);
  });

  it("folds a thread without an import origin per runless prompt, undivided", () => {
    // Upstream folds each runless prompt (V1-migrated turns) on its own key,
    // even after a V2 run exists; only the import divider needs the origin.
    const rows = deriveThreadFeedPresentation(importedRows(), latestRun, new Set());
    expect(rows.some((entry) => entry.type === "import-divider")).toBe(false);
    expect(rows.flatMap((entry) => (entry.type === "run-fold" ? [entry.runId] : []))).toEqual([
      "runless:imported-user",
      newRunId,
    ]);
  });

  it("ends an imported run and every run with a terminal assistant message", () => {
    const feed = importedRows();
    expect([...deriveTerminalAssistantMessageIds(feed, claudeImport)]).toEqual([
      "imported-assistant-last",
      "new-assistant",
    ]);
    // Without the origin the imported rows belong to no run and carry no
    // end-of-turn affordances.
    expect([...deriveTerminalAssistantMessageIds(feed)]).toEqual(["new-assistant"]);
    // V1-migrated history is run-less too: each of its turns ends the same way.
    expect([...deriveTerminalAssistantMessageIds(feed, null, true)]).toEqual([
      "imported-assistant-last",
      "new-assistant",
    ]);
  });

  it("marks the end of imported history when no new work exists yet", () => {
    const feed = buildThreadFeed([
      projected(message("imported-user", "user", "2026-04-01T00:00:01.000Z", 0, null), 0),
      projected(message("imported-assistant", "assistant", "2026-04-01T00:00:04.000Z", 1, null), 1),
    ]);
    const rows = deriveThreadFeedPresentation(
      feed,
      null,
      new Set(),
      new Set(),
      null,
      false,
      claudeImport,
    );
    expect(rows.map((entry) => entry.id)).toEqual([
      "imported-user",
      "imported-assistant",
      "import-divider",
    ]);
  });

  it("draws no divider for a fork that kept the origin but none of its rows", () => {
    const forkRunId = RunId.make("fork-run");
    const feed = buildThreadFeed([
      projected(message("fork-user", "user", "2026-04-01T00:02:01.000Z", 0, forkRunId), 0),
      projected(
        message("fork-assistant", "assistant", "2026-04-01T00:02:02.000Z", 1, forkRunId),
        1,
      ),
    ]);
    const rows = deriveThreadFeedPresentation(
      feed,
      null,
      new Set(),
      new Set(),
      null,
      false,
      claudeImport,
    );
    expect(rows.map((entry) => entry.id)).toEqual(["fork-user", "fork-assistant"]);
  });

  it("never presents an imported row as live runless work", () => {
    const running = {
      ...tool("imported-running", "2026-04-01T00:00:05.000Z", 1, null),
      status: "running" as const,
      completedAt: null,
    } satisfies OrchestrationV2TurnItem;
    const feed = buildThreadFeed([
      projected(message("imported-user", "user", "2026-04-01T00:00:01.000Z", 0, null), 0),
      projected(running, 1),
    ]);
    const presented = (origin: ThreadImportOrigin | null) =>
      deriveThreadFeedPresentation(
        feed,
        null,
        new Set(),
        new Set(),
        "2026-04-01T00:00:01.000Z",
        true,
        origin,
      );
    const liveWork = (row: ThreadFeedEntry) =>
      (row.type === "work-toggle" && row.live) ||
      (row.type === "activity-group" && row.activities.some((activity) => activity.live === true));
    expect(presented(claudeImport).some(liveWork)).toBe(false);
    expect(presented(null).some(liveWork)).toBe(true);
  });

  it("names the product an import came from", () => {
    expect(buildThreadImportLabel(claudeImport)).toBe("Imported from Claude Code");
    expect(
      buildThreadImportLabel({ ...claudeImport, driverKind: ProviderDriverKind.make("codex") }),
    ).toBe("Imported from Codex");
  });

  it("notes truncated history only above the oldest imported message", () => {
    const truncated = { ...claudeImport, historyTruncated: true };
    const importedMessage = { runId: null, createdAt: "2026-04-01T00:00:01.000Z" };
    expect(
      shouldShowImportTruncatedNote({
        importedFrom: truncated,
        hasMoreHistory: false,
        firstMessage: importedMessage,
      }),
    ).toBe(true);
    // Older pages are still unloaded, so the first message shown is not the oldest.
    expect(
      shouldShowImportTruncatedNote({
        importedFrom: truncated,
        hasMoreHistory: true,
        firstMessage: importedMessage,
      }),
    ).toBe(false);
    expect(
      shouldShowImportTruncatedNote({
        importedFrom: claudeImport,
        hasMoreHistory: false,
        firstMessage: importedMessage,
      }),
    ).toBe(false);
    expect(
      shouldShowImportTruncatedNote({
        importedFrom: truncated,
        hasMoreHistory: false,
        firstMessage: { runId: null, createdAt: "2026-04-01T00:02:00.000Z" },
      }),
    ).toBe(false);
    expect(
      shouldShowImportTruncatedNote({
        importedFrom: null,
        hasMoreHistory: false,
        firstMessage: importedMessage,
      }),
    ).toBe(false);
  });
});

describe("MCP apps", () => {
  const app = {
    attachmentId: "attachment-app",
    server: "weather",
    tool: "get_weather",
    resourceUri: "ui://weather/dashboard",
  };
  const appCall = (status: OrchestrationV2TurnItem["status"]): OrchestrationV2TurnItem => ({
    ...base("item-app", "2026-06-20T00:00:02.500Z", 2),
    status,
    type: "dynamic_tool",
    toolName: "weather.get_weather",
    input: { city: "Oslo" },
    output: { lecturnMcpApp: app, result: { content: [] } },
  });
  const feed = (status: OrchestrationV2TurnItem["status"]) =>
    buildThreadFeed([
      projected(userMessage(), 0),
      projected(appCall(status), 1),
      projected(assistantMessage("2026-06-20T00:00:04.000Z"), 2),
    ]);

  it("drops the tool row of a card no connected app serves", () => {
    expect(feed("completed").map((entry) => entry.type)).toEqual(["message", "mcp-app", "message"]);
  });

  it("keeps a connected app's tool row above its card, outside the run fold", () => {
    const counterCard = {
      attachmentId: "attachment-counter",
      server: "lecturn",
      tool: "ex_counter_increment",
      resourceUri: "ui://ex/counter-card",
    };
    const appToolCall = {
      ...appCall("completed"),
      toolName: "mcp__lecturn__ex_counter_increment",
      output: { lecturnMcpApp: counterCard, result: { content: [] } },
      toolSource: appToolSource({ appId: "dev.example", name: "Example", toolPrefix: "ex" }),
    } as OrchestrationV2TurnItem;
    const appFeed = () =>
      buildThreadFeed([
        projected(userMessage(), 0),
        projected(command(), 1),
        projected(appToolCall, 2),
        projected(assistantMessage("2026-06-20T00:00:04.000Z"), 3),
      ]);
    const latestRun = {
      runId,
      status: "completed" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:04.000Z",
    };
    const entries = appFeed();
    expect(entries.map((entry) => entry.type)).toEqual([
      "message",
      "activity-group",
      "activity-group",
      "mcp-app",
      "message",
    ]);
    const row = entries[2];
    expect(row?.type === "activity-group" ? row.activities.map((a) => a.id) : []).toEqual([
      "local:thread-1:item-app",
    ]);
    expect(entries[3]).toMatchObject({ type: "mcp-app", app: counterCard, itemId: "item-app" });
    expect(appFeed().map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
    const collapsed = deriveThreadFeedPresentation(entries, latestRun, new Set());
    expect(collapsed.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "activity-group",
      "mcp-app",
      "message",
    ]);
  });
});

describe("connected-app tool rows", () => {
  const source = appToolSource({
    appId: "dev.rocketwright.app",
    name: "RocketWright",
    toolPrefix: "rw",
  });
  const appCall = (title: string, output?: unknown): OrchestrationV2TurnItem =>
    ({
      ...base("item-motors", "2026-06-20T00:00:02.500Z", 2),
      type: "dynamic_tool",
      title,
      toolName: "mcp__lecturn__rw_motor_search",
      toolSource: source,
      input: { query: "H128" },
      ...(output === undefined ? {} : { output }),
    }) as OrchestrationV2TurnItem;
  const activityOf = (item: OrchestrationV2TurnItem) => {
    const entry = buildThreadFeed([projected(item, 0)]).find(
      (candidate) => candidate.type === "activity-group",
    );
    return entry?.type === "activity-group" ? entry.activities[0] : undefined;
  };
  const rawName = (activity: ThreadFeedActivity | undefined) => {
    const item = activity?.projectedItem.item;
    return item?.type === "dynamic_tool" ? appToolRawName(item) : undefined;
  };

  it("labels the row with the tool's title and the app's summary, keeping the called name", () => {
    const activity = activityOf(
      appCall("Find motors", { _meta: { "lecturn/summary": "3 candidates" } }),
    );
    expect(activity && workEntryRowLabel(activity.workEntry)).toBe("Find motors");
    expect(activity && workEntryAppToolSummary(activity.workEntry)).toBe("3 candidates");
    expect(rawName(activity)).toBe("rw_motor_search");
  });

  it("keeps today's row when the app declared neither", () => {
    const activity = activityOf(appCall("rw_motor_search"));
    expect(activity && workEntryAppToolSummary(activity.workEntry)).toBeUndefined();
    expect(rawName(activity)).toBeUndefined();
  });
});

describe("an app approval that committed before the call it holds", () => {
  const source = appToolSource({
    appId: "dev.rocketwright.app",
    name: "RocketWright",
    toolPrefix: "rw",
  });
  const requestId = RuntimeRequestId.make("request-engine");
  const engineCall = (completedAt: string | null): OrchestrationV2TurnItem => ({
    ...base("item-engine", "2026-06-20T00:00:02.000Z", 3),
    status: completedAt === null ? "running" : "completed",
    completedAt: completedAt === null ? null : DateTime.makeUnsafe(completedAt),
    type: "dynamic_tool",
    title: "Simulate engine",
    toolName: "mcp__lecturn__rw_engine_simulate",
    toolSource: source,
    input: {},
  });
  const engineApproval = (answered: boolean): OrchestrationV2TurnItem => ({
    ...base("item-approval", "2026-06-20T00:00:03.000Z", 2),
    status: answered ? "completed" : "waiting",
    completedAt: answered ? DateTime.makeUnsafe("2026-06-20T00:00:05.000Z") : null,
    type: "approval_request",
    requestId,
    requestKind: "permission",
    appName: "RocketWright",
    prompt: "Approve Simulate engine · Burn duration not set",
  });
  const request = (answered: boolean): OrchestrationV2RuntimeRequest => ({
    id: requestId,
    nodeId: NodeId.make("node-approval"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "permission",
    status: answered ? "resolved" : "pending",
    responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
    createdAt: DateTime.makeUnsafe("2026-06-20T00:00:03.000Z"),
    resolvedAt: answered ? DateTime.makeUnsafe("2026-06-20T00:00:05.000Z") : null,
    connectedAppTool: {
      appId: AppId.make("dev.rocketwright.app"),
      appName: "RocketWright",
      toolName: "rw_engine_simulate",
      reason: "Burn duration not set",
      source: "app",
    },
  });
  const feedItemIds = (feed: ReadonlyArray<ThreadFeedEntry>) =>
    feed.flatMap((entry) =>
      entry.type === "activity-group"
        ? entry.activities.map((activity) => activity.projectedItem.item.id)
        : entry.type === "message"
          ? [entry.id]
          : [],
    );

  it("lists the approval under its call, while it waits and once answered", () => {
    // The shared thread-detail atom places the rows before the feed is built.
    const place = createAppToolApprovalPlacer();
    const stages = [
      { answered: false, callDone: null },
      { answered: true, callDone: null },
      { answered: true, callDone: "2026-06-20T00:00:06.000Z" },
    ];
    for (const { answered, callDone } of stages) {
      const rows = [userMessage(), engineApproval(answered), engineCall(callDone)].map(
        (item, position) => projected(item, position),
      );
      expect(feedItemIds(buildThreadFeed(place(rows, [request(answered)])))).toEqual([
        "message-user",
        "item-engine",
        "item-approval",
      ]);
    }
  });

  it("leaves the approval and the call it holds to the composer card until it is answered", () => {
    const place = createAppToolApprovalPlacer();
    const feedAt = (answered: boolean, callDone: string | null) => {
      const items = [userMessage(), engineApproval(answered), engineCall(callDone)];
      const requests = [request(answered)];
      const { approvals } = derivePendingThreadRequests({
        runtimeRequests: requests,
        turnItems: items,
      });
      return feedItemIds(
        buildThreadFeed(
          place(
            items.map((item, position) => projected(item, position)),
            requests,
          ),
          { cardApprovals: approvals },
        ),
      );
    };
    expect(feedAt(false, null)).toEqual(["message-user"]);
    expect(feedAt(true, null)).toEqual(["message-user", "item-engine", "item-approval"]);
    expect(feedAt(true, "2026-06-20T00:00:06.000Z")).toEqual([
      "message-user",
      "item-engine",
      "item-approval",
    ]);
  });

  it("keeps a provider's own waiting approval in the feed beside its card", () => {
    const { connectedAppTool: _, ...providerRequest } = request(false);
    const items = [userMessage(), engineApproval(false)];
    const { approvals } = derivePendingThreadRequests({
      runtimeRequests: [providerRequest],
      turnItems: items,
    });
    expect(approvals).toHaveLength(1);
    const feed = buildThreadFeed(
      items.map((item, position) => projected(item, position)),
      { cardApprovals: approvals },
    );
    expect(feedItemIds(feed)).toEqual(["message-user", "item-approval"]);
  });
});

describe("streamed feed updates", () => {
  const runs = [RunId.make("run-1"), RunId.make("run-2"), RunId.make("run-3")] as const;
  const at = (second: number) => `2026-06-20T00:00:${String(second).padStart(2, "0")}.000Z`;
  const item = (id: string, second: number, run: RunId) => ({
    ...base(id, at(second), second),
    runId: run,
  });
  const user = (
    id: string,
    second: number,
    run: RunId,
  ): Extract<OrchestrationV2TurnItem, { type: "user_message" }> => ({
    ...item(id, second, run),
    type: "user_message",
    messageId: MessageId.make(`message-${id}`),
    createdBy: "user",
    creationSource: "mobile",
    inputIntent: "turn_start",
    text: `Prompt ${id}`,
    attachments: [],
  });
  const reply = (id: string, second: number, run: RunId, text = "Done", streaming = false) =>
    ({
      ...item(id, second, run),
      ...(streaming ? { status: "running" as const, completedAt: null } : {}),
      type: "assistant_message",
      messageId: MessageId.make(`message-${id}`),
      text,
      streaming,
    }) satisfies OrchestrationV2TurnItem;
  const shell = (id: string, second: number, run: RunId): OrchestrationV2TurnItem => ({
    ...item(id, second, run),
    type: "command_execution",
    input: `echo ${id}`,
    output: id,
    exitCode: 0,
  });
  const requestId = RuntimeRequestId.make("request-color");
  const question = (answered: boolean): OrchestrationV2TurnItem => ({
    ...item("question", 12, runs[1]),
    type: "user_input_request",
    requestId,
    questions: [],
    ...(answered
      ? { questionAnswer: { requestId, answers: { color: "Blue" }, attachmentsByQuestionId: {} } }
      : {}),
  });
  const answer: OrchestrationV2TurnItem = {
    ...user("answer", 40, runs[1]),
    messageId: MessageId.make(`async-answer:${requestId}`),
  };
  const delegation: OrchestrationV2TurnItem = {
    ...item("delegation", 3, runs[0]),
    type: "dynamic_tool",
    toolName: "lecturn.delegate_task",
    input: { task: "Check" },
    output: { taskId: "child" },
  };
  const lateChild: OrchestrationV2TurnItem = {
    ...item("late-child", 30, runs[0]),
    type: "subagent",
    subagentId: NodeId.make("child"),
    origin: "app_owned",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    childThreadId: sourceThreadId,
    prompt: "Check",
    result: "Fine",
  };
  const resumed: OrchestrationV2TurnItem = {
    ...lateChild,
    ...item("resumed", 3, runs[2]),
    subagentId: NodeId.make("resumed"),
    origin: "provider_native",
    childThreadId: null,
  };
  const history: OrchestrationV2TurnItem[] = [
    user("u1", 1, runs[0]),
    shell("s1", 2, runs[0]),
    delegation,
    reply("a1", 4, runs[0]),
    user("u2", 10, runs[1]),
    shell("s2", 11, runs[1]),
    question(false),
    reply("a2", 13, runs[1]),
    user("u3", 20, runs[2]),
    shell("s3", 21, runs[2]),
  ];
  const running = {
    runId: runs[2],
    status: "running" as const,
    startedAt: at(20),
    completedAt: null,
  };
  const settled = { ...running, status: "completed" as const, completedAt: at(50) };
  // Each step is what one streamed event leaves behind, including the edits
  // that reach back into earlier runs.
  const steps: ReadonlyArray<{
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly latestRun: ThreadFeedLatestRun;
  }> = [
    { items: [...history, reply("a3", 22, runs[2], "W", true)], latestRun: running },
    { items: [...history, reply("a3", 22, runs[2], "Wor", true)], latestRun: running },
    {
      items: [...history, reply("a3", 22, runs[2], "Working", true), shell("s4", 23, runs[2])],
      latestRun: running,
    },
    {
      items: [
        ...history,
        reply("a3", 22, runs[2], "Working", true),
        shell("s4", 23, runs[2]),
        lateChild,
      ],
      latestRun: running,
    },
    {
      items: [
        ...history.map((entry) => (entry.id === "question" ? question(true) : entry)),
        reply("a3", 22, runs[2], "Working", true),
        shell("s4", 23, runs[2]),
        lateChild,
        answer,
      ],
      latestRun: running,
    },
    {
      items: [
        ...history.slice(0, 9),
        shell("inserted", 20, runs[2]),
        ...history.slice(9),
        reply("a3", 22, runs[2], "Working", true),
        shell("s4", 23, runs[2]),
      ],
      latestRun: running,
    },
    {
      items: [...history, reply("a3", 22, runs[2], "Working on it"), shell("s4", 23, runs[2])],
      latestRun: running,
    },
    {
      items: [...history, reply("a3", 22, runs[2], "Working on it"), shell("s4", 23, runs[2])],
      latestRun: settled,
    },
    {
      items: [
        ...history,
        reply("a3", 22, runs[2], "Working on it"),
        shell("s4", 23, runs[2]),
        shell("late-s1", 45, runs[0]),
      ],
      latestRun: settled,
    },
    // The first run's fold above was timed to the late item; dropping it must reach back too.
    {
      items: [...history, reply("a3", 22, runs[2], "Working on it"), shell("s4", 23, runs[2])],
      latestRun: settled,
    },
    // The latest run resumes a subagent from the first run: the item moves to
    // the latest run but keeps its place, so it folds with the first run.
    {
      items: [
        ...history.slice(0, 3),
        resumed,
        ...history.slice(3),
        reply("a3", 22, runs[2], "Working on it"),
        shell("s4", 23, runs[2]),
      ],
      latestRun: running,
    },
    {
      items: [
        ...history.slice(0, 3),
        resumed,
        ...history.slice(3),
        reply("a3", 22, runs[2], "Working on it"),
        shell("s4", 23, runs[2]),
        reply("a4", 24, runs[2], "Still", true),
      ],
      latestRun: running,
    },
  ];
  // Like the projection reducer, an unchanged item at an unchanged position keeps its row.
  const rowsByItem = new Map<
    OrchestrationV2TurnItem,
    Map<number, OrchestrationV2ProjectedTurnItem>
  >();
  const row = (entry: OrchestrationV2TurnItem, position: number) => {
    const byPosition = rowsByItem.get(entry) ?? new Map<number, OrchestrationV2ProjectedTurnItem>();
    rowsByItem.set(entry, byPosition);
    const cached = byPosition.get(position) ?? projected(entry, position);
    byPosition.set(position, cached);
    return cached;
  };
  const present = (
    step: (typeof steps)[number],
    expandedRunIds: ReadonlySet<RunId>,
    cache?: ThreadFeedCache,
  ) =>
    deriveThreadFeedPresentation(
      buildThreadFeed(step.items.map(row), { cache }),
      step.latestRun,
      expandedRunIds,
      new Set(),
      step.latestRun.status === "running" ? at(20) : null,
      false,
      null,
      cache,
    );

  it.each([
    { folds: "collapsed", expandedRunIds: new Set<RunId>() },
    { folds: "expanded", expandedRunIds: new Set<RunId>(runs) },
  ])("matches a fresh build after every update with $folds runs", ({ expandedRunIds }) => {
    const cache = createThreadFeedCache();
    const streamed = steps.map((step) => present(step, expandedRunIds, cache));
    const fresh = steps.map((step) => present(step, expandedRunIds));
    // Closures on activities are not part of what a row shows.
    const values = (rows: ReadonlyArray<ThreadFeedEntry>) => JSON.parse(JSON.stringify(rows));
    for (const [index, rows] of streamed.entries()) {
      expect(values(rows), `step ${index}`).toEqual(values(fresh[index]!));
    }
  });

  it("hides a delegation once its child reaches back into the earlier run", () => {
    const showsDelegation = (step: (typeof steps)[number]) =>
      buildThreadFeed(step.items.map(row)).some(
        (entry) =>
          entry.type === "activity-group" &&
          entry.activities.some((activity) => activity.projectedItem.item.id === "delegation"),
      );
    expect(showsDelegation(steps[2]!)).toBe(true);
    expect(showsDelegation(steps[3]!)).toBe(false);
  });
});

// Lecturn rows the incremental cache must reproduce exactly: the import
// divider, a connected app's tool row and card, and approvals the composer
// card holds.
describe("cached feeds with Lecturn rows", () => {
  const runs = [RunId.make("run-1"), RunId.make("run-2")] as const;
  const at = (second: number) => `2026-06-20T00:01:${String(second).padStart(2, "0")}.000Z`;
  const item = (id: string, second: number, run: RunId | null) => ({
    ...base(id, at(second), second),
    runId: run,
  });
  const user = (id: string, second: number, run: RunId | null): OrchestrationV2TurnItem => ({
    ...item(id, second, run),
    type: "user_message",
    messageId: MessageId.make(`message-${id}`),
    createdBy: "user",
    creationSource: "mobile",
    inputIntent: "turn_start",
    text: `Prompt ${id}`,
    attachments: [],
  });
  const reply = (
    id: string,
    second: number,
    run: RunId | null,
    text = "Done",
    streaming = false,
  ): OrchestrationV2TurnItem => ({
    ...item(id, second, run),
    ...(streaming ? { status: "running" as const, completedAt: null } : {}),
    type: "assistant_message",
    messageId: MessageId.make(`message-${id}`),
    text,
    streaming,
  });
  const shell = (id: string, second: number, run: RunId | null): OrchestrationV2TurnItem => ({
    ...item(id, second, run),
    type: "command_execution",
    input: `echo ${id}`,
    output: id,
    exitCode: 0,
  });
  const source = appToolSource({ appId: "dev.example", name: "Example", toolPrefix: "ex" });
  const appCall = (
    id: string,
    second: number,
    run: RunId,
    done: boolean,
  ): OrchestrationV2TurnItem =>
    ({
      ...item(id, second, run),
      ...(done ? {} : { status: "running" as const, completedAt: null }),
      type: "dynamic_tool",
      toolName: "mcp__lecturn__ex_counter_increment",
      toolSource: source,
      input: {},
      output: done
        ? {
            lecturnMcpApp: {
              attachmentId: `attachment-${id}`,
              server: "lecturn",
              tool: "ex_counter_increment",
              resourceUri: "ui://ex/counter-card",
            },
            result: { content: [] },
          }
        : null,
    }) as OrchestrationV2TurnItem;
  const running = (run: RunId, second: number): ThreadFeedLatestRun => ({
    runId: run,
    status: "running",
    startedAt: at(second),
    completedAt: null,
  });
  const done = (latest: ThreadFeedLatestRun, second: number): ThreadFeedLatestRun => ({
    ...latest,
    status: "completed",
    completedAt: at(second),
  });

  interface Step {
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly latestRun: ThreadFeedLatestRun;
    readonly requests?: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  }

  function expectCachedMatchesFresh(
    steps: ReadonlyArray<Step>,
    importedFrom: ThreadImportOrigin | null = null,
  ) {
    // Like the projection reducer, an unchanged item at an unchanged position keeps its row.
    const rowsByItem = new Map<
      OrchestrationV2TurnItem,
      Map<number, OrchestrationV2ProjectedTurnItem>
    >();
    const row = (entry: OrchestrationV2TurnItem, position: number) => {
      const byPosition = rowsByItem.get(entry) ?? new Map();
      rowsByItem.set(entry, byPosition);
      const cached = byPosition.get(position) ?? projected(entry, position);
      byPosition.set(position, cached);
      return cached;
    };
    const values = (rows: ReadonlyArray<ThreadFeedEntry>) => JSON.parse(JSON.stringify(rows));
    for (const expandedRunIds of [new Set<RunId>(), new Set<RunId>(runs)]) {
      const cache = createThreadFeedCache();
      const present = (step: Step, stepCache?: ThreadFeedCache) => {
        const { approvals } = derivePendingThreadRequests({
          runtimeRequests: step.requests ?? [],
          turnItems: step.items,
        });
        const feed = buildThreadFeed(step.items.map(row), {
          cardApprovals: approvals,
          ...(stepCache ? { cache: stepCache } : {}),
        });
        return {
          feed,
          rows: deriveThreadFeedPresentation(
            feed,
            step.latestRun,
            expandedRunIds,
            new Set(),
            step.latestRun.status === "running" ? step.latestRun.startedAt : null,
            false,
            importedFrom,
            stepCache,
          ),
        };
      };
      for (const [index, step] of steps.entries()) {
        const cached = present(step, cache);
        const fresh = present(step);
        const label = `step ${index}, ${expandedRunIds.size > 0 ? "expanded" : "collapsed"}`;
        expect(values(cached.feed), label).toEqual(values(fresh.feed));
        expect(values(cached.rows), label).toEqual(values(fresh.rows));
      }
    }
  }

  it("keeps the import divider exact while new work streams in", () => {
    const importedFrom: ThreadImportOrigin = {
      providerInstanceId: ProviderInstanceId.make("claude"),
      driverKind: ProviderDriverKind.make("claudeAgent"),
      sessionId: "session-1",
      cwd: "/repo",
      title: "Imported",
      importedAt: at(9),
      historyTruncated: false,
    };
    // Two imported exchanges, so a restart can land inside imported history.
    const imported = [
      user("i-user-1", 1, null),
      shell("i-shell-1", 2, null),
      reply("i-reply-1", 3, null),
      user("i-user-2", 4, null),
      shell("i-shell-2", 5, null),
      reply("i-reply-2", 6, null),
    ];
    const first = running(runs[0], 10);
    const second = running(runs[1], 20);
    const u1 = user("u1", 10, runs[0]);
    const s1 = shell("s1", 11, runs[0]);
    const a1 = reply("a1", 12, runs[0]);
    const u2 = user("u2", 20, runs[1]);
    const s2 = shell("s2", 21, runs[1]);
    const steps: Step[] = [
      { items: imported, latestRun: done({ ...first, startedAt: at(1) }, 6) },
      { items: [...imported, shell("i-shell-3", 7, null)], latestRun: done(first, 7) },
      { items: [...imported, u1], latestRun: first },
      { items: [...imported, u1, reply("a1", 12, runs[0], "Wor", true)], latestRun: first },
      { items: [...imported, u1, s1, a1], latestRun: done(first, 13) },
      { items: [...imported, u1, s1, a1, u2], latestRun: second },
      { items: [...imported, u1, s1, a1, u2, s2], latestRun: second },
      {
        items: [...imported, u1, s1, a1, u2, s2, reply("a2", 22, runs[1])],
        latestRun: done(second, 23),
      },
    ];
    expectCachedMatchesFresh(steps, importedFrom);
  });

  it("reuses a prefix holding an app tool row and its card", () => {
    const first = running(runs[0], 1);
    const second = running(runs[1], 10);
    const u1 = user("u1", 1, runs[0]);
    const s1 = shell("s1", 2, runs[0]);
    const app1 = appCall("app1", 3, runs[0], true);
    const a1 = reply("a1", 4, runs[0]);
    const u2 = user("u2", 10, runs[1]);
    const app2 = appCall("app2", 12, runs[1], true);
    const s2 = shell("s2", 13, runs[1]);
    const steps: Step[] = [
      { items: [u1, s1, appCall("app1", 3, runs[0], false)], latestRun: first },
      { items: [u1, s1, app1], latestRun: first },
      // The next row lands right after the card, so the card's restart is the one reused.
      { items: [u1, s1, app1, a1], latestRun: done(first, 5) },
      { items: [u1, s1, app1, a1, u2], latestRun: second },
      { items: [u1, s1, app1, a1, u2, appCall("app2", 12, runs[1], false)], latestRun: second },
      { items: [u1, s1, app1, a1, u2, app2], latestRun: second },
      { items: [u1, s1, app1, a1, u2, app2, s2], latestRun: second },
      {
        items: [u1, s1, app1, a1, u2, app2, s2, reply("a2", 14, runs[1])],
        latestRun: done(second, 15),
      },
    ];
    expectCachedMatchesFresh(steps);
  });

  it("follows approvals the composer card takes over and gives back", () => {
    const requestId = RuntimeRequestId.make("request-engine");
    const engineCall = (callDone: boolean): OrchestrationV2TurnItem => ({
      ...item("engine", 12, runs[1]),
      ...(callDone ? {} : { status: "running" as const, completedAt: null }),
      type: "dynamic_tool",
      title: "Simulate engine",
      toolName: "mcp__lecturn__ex_engine_simulate",
      toolSource: source,
      input: {},
    });
    const approval = (answered: boolean): OrchestrationV2TurnItem => ({
      ...item("approval", 11, runs[1]),
      status: answered ? "completed" : "waiting",
      completedAt: answered ? DateTime.makeUnsafe(at(13)) : null,
      type: "approval_request",
      requestId,
      requestKind: "permission",
      appName: "Example",
      prompt: "Approve Simulate engine",
    });
    const request = (answered: boolean): OrchestrationV2RuntimeRequest => ({
      id: requestId,
      nodeId: NodeId.make("node-approval"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "permission",
      status: answered ? "resolved" : "pending",
      responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
      createdAt: DateTime.makeUnsafe(at(11)),
      resolvedAt: answered ? DateTime.makeUnsafe(at(13)) : null,
      connectedAppTool: {
        appId: AppId.make("dev.example"),
        appName: "Example",
        toolName: "ex_engine_simulate",
        reason: "Burn duration not set",
        source: "app",
      },
    });
    const first = running(runs[0], 1);
    const second = running(runs[1], 10);
    const run1 = [user("u1", 1, runs[0]), shell("s1", 2, runs[0]), reply("a1", 3, runs[0])];
    const run2 = [user("u2", 10, runs[1]), shell("s2", 10, runs[1])];
    const [waiting, answered] = [approval(false), approval(true)];
    const [callRunning, callDone] = [engineCall(false), engineCall(true)];
    const [pending, resolved] = [[request(false)], [request(true)]];
    const steps: Step[] = [
      { items: run1, latestRun: done(first, 4) },
      { items: [...run1, ...run2], latestRun: second },
      { items: [...run1, ...run2, waiting], latestRun: second, requests: pending },
      { items: [...run1, ...run2, waiting, callRunning], latestRun: second, requests: pending },
      { items: [...run1, ...run2, answered, callRunning], latestRun: second, requests: resolved },
      { items: [...run1, ...run2, answered, callDone], latestRun: second, requests: resolved },
      {
        items: [...run1, ...run2, answered, callDone, reply("a2", 14, runs[1])],
        latestRun: done(second, 15),
        requests: resolved,
      },
    ];
    expectCachedMatchesFresh(steps);
  });
});
