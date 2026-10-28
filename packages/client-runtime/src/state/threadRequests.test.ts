import {
  AppId,
  type ConnectedAppToolApprovalInfo,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  createQuestionHistoryProjector,
  derivePendingThreadRequests,
  seedUserInputDraftAnswers,
} from "./threadRequests.ts";

const requestId = RuntimeRequestId.make("async-question");
const nodeId = NodeId.make("async-question-node");

describe("initial user input drafts", () => {
  const questions = [
    { id: "editor", initialAnswer: "  Proposed commit\n\n" },
    { id: "empty", initialAnswer: "" },
    { id: "ordinary" },
    { id: "choices", initialAnswer: "Ignore this", allowCustomAnswer: false },
  ];

  it("seeds editable answers and preserves edits and selections on later snapshots", () => {
    const seeded = seedUserInputDraftAnswers(questions, {});
    expect(seeded).toEqual({
      editor: { customAnswer: "  Proposed commit\n\n" },
      empty: { customAnswer: "" },
    });
    const edits = {
      ...seeded,
      editor: { customAnswer: "" },
      empty: { selectedOptionValues: ["empty"], customAnswer: "" },
    };
    expect(seedUserInputDraftAnswers(questions, edits)).toEqual(edits);
    expect(
      seedUserInputDraftAnswers(questions, { editor: { customAnswer: "Edited commit" } }).editor,
    ).toEqual({ customAnswer: "Edited commit" });
    expect(seedUserInputDraftAnswers(questions, {}).editor).toEqual({
      customAnswer: "  Proposed commit\n\n",
    });
  });
});
const projection: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  runtimeRequests: [
    {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: v2Now,
      resolvedAt: null,
    },
  ],
  turnItems: [
    {
      id: TurnItemId.make("async-question-item"),
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "user_input_request",
      requestId,
      responseMode: "message",
      questions: [
        {
          id: "next",
          header: "Next",
          question: "What should happen next?",
          required: true,
          allowCustomAnswer: false,
          options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
        },
      ],
    },
  ],
};

describe("pending v2 questions", () => {
  it("keeps message responses available after the originating runtime exits", () => {
    expect(projection.providerSessions).toEqual([]);
    expect(derivePendingThreadRequests(projection).userInputs).toEqual([
      {
        requestId,
        createdAt: "2026-06-20T00:00:00.000Z",
        responseCapability: "message",
        responseMode: "message",
        dismissible: true,
        questions: [
          {
            id: "next",
            header: "Next",
            question: "What should happen next?",
            required: true,
            allowCustomAnswer: false,
            multiSelect: false,
            options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
          },
        ],
      },
    ]);
  });

  it("only marks asynchronous questions as dismissible", () => {
    const live = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        responseCapability: {
          type: "live" as const,
          providerSessionId: ProviderSessionId.make("live-session"),
        },
      })),
      turnItems: projection.turnItems.map((item) =>
        item.type === "user_input_request" ? { ...item, responseMode: undefined } : item,
      ),
    };
    expect(derivePendingThreadRequests(live).userInputs[0]?.dismissible).toBe(false);
  });

  it("removes answered requests from the composer while retaining their answers in projection data", () => {
    const answered = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        status: "resolved" as const,
        resolvedAt: v2Now,
        answers: { next: "  continue  " },
      })),
    };
    expect(derivePendingThreadRequests(answered).userInputs).toEqual([]);
    expect(answered.runtimeRequests[0]?.answers).toEqual({ next: "  continue  " });
  });
});

it("restores old text answers without mutating history or replacing unchanged rows", () => {
  const project = createQuestionHistoryProjector();
  const item = projection.turnItems[0]!;
  const row = {
    item,
    position: 0,
    sourceItemId: item.id,
    sourceThreadId: item.threadId,
    visibility: "local" as const,
  };
  const rows = [row];
  const pending = { visibleTurnItems: rows, runtimeRequests: projection.runtimeRequests };
  expect(project(pending)).toBe(rows);
  const answered = {
    ...pending,
    runtimeRequests: [
      {
        ...projection.runtimeRequests[0]!,
        status: "resolved" as const,
        answers: { next: "Continue" },
      },
    ],
  };
  const result = project(answered);
  expect(result[0]?.item).toMatchObject({
    questionAnswer: {
      answers: { next: "Continue" },
      attachmentsByQuestionId: {},
      questionTextById: { next: "What should happen next?" },
    },
  });
  expect(row.item).not.toHaveProperty("questionAnswer");
  expect(project(answered)).toBe(result);
  expect(project({ ...answered, visibleTurnItems: [...rows] })[0]).toBe(result[0]);
});

describe("pending connected-app tool approvals", () => {
  const appRequestId = RuntimeRequestId.make("app-approval");
  const appNodeId = NodeId.make("app-approval-node");
  const connectedAppTool: ConnectedAppToolApprovalInfo = {
    appId: AppId.make("dev.rocketwright.app"),
    appName: "RocketWright",
    toolName: "rw_engine_simulate",
    reason: "Simulates 120 s of burn",
    source: "app",
  };
  const appProjection = (
    options: ReadonlyArray<{
      decision: "accept" | "acceptForSession" | "decline" | "cancel";
      label: string;
    }> | null,
  ): OrchestrationV2ThreadProjection => ({
    ...v2Projection,
    runtimeRequests: [
      {
        id: appRequestId,
        nodeId: appNodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "permission",
        status: "pending",
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("calling-session"),
        },
        createdAt: v2Now,
        resolvedAt: null,
        connectedAppTool,
      },
    ],
    turnItems:
      options === null
        ? []
        : [
            {
              id: TurnItemId.make("app-approval-item"),
              threadId: v2Projection.thread.id,
              runId: null,
              nodeId: appNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "waiting",
              title: null,
              startedAt: v2Now,
              completedAt: null,
              updatedAt: v2Now,
              type: "approval_request",
              requestId: appRequestId,
              requestKind: "permission",
              appName: "RocketWright",
              prompt: "Approve rw_engine_simulate · Simulates 120 s of burn",
              options: [...options],
            },
          ],
  });

  it("is answerable and names the app tool it is for", () => {
    const [approval] = derivePendingThreadRequests(
      appProjection([
        { decision: "accept", label: "Approve" },
        { decision: "decline", label: "Decline" },
      ]),
    ).approvals;
    expect(approval).toMatchObject({
      requestId: appRequestId,
      requestKind: "permission",
      responseCapability: "live",
      appName: "RocketWright",
      connectedAppTool,
      options: [
        { decision: "accept", label: "Approve" },
        { decision: "decline", label: "Decline" },
      ],
    });
  });

  it("never offers to allow an app tool for the whole session", () => {
    const decisions = (projection: OrchestrationV2ThreadProjection) =>
      derivePendingThreadRequests(projection).approvals[0]?.options?.map(
        (option) => option.decision,
      );
    expect(
      decisions(
        appProjection([
          { decision: "accept", label: "Approve" },
          { decision: "acceptForSession", label: "Always allow this session" },
          { decision: "decline", label: "Decline" },
        ]),
      ),
    ).toEqual(["accept", "decline"]);
    // The approval item can be outside the loaded turn items; the defaults would offer it.
    expect(decisions(appProjection(null))).toEqual(["decline", "accept", "cancel"]);
  });

  it("leaves provider approvals without the field", () => {
    const provider = appProjection(null);
    const [approval] = derivePendingThreadRequests({
      ...provider,
      runtimeRequests: provider.runtimeRequests.map(
        ({ connectedAppTool: _connectedAppTool, ...request }) => request,
      ),
    }).approvals;
    expect(approval).not.toHaveProperty("connectedAppTool");
    expect(approval).not.toHaveProperty("options");
  });
});
