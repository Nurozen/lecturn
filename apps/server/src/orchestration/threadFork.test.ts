import { describe, expect, it } from "vite-plus/test";
import {
  CheckpointRef,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  EventId,
  type ChatAttachment,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ThreadForkProviderSource,
} from "@t3tools/contracts";

import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import type { ProjectionTurn } from "../persistence/Services/ProjectionTurns.ts";
import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";
import {
  assembleThreadFork,
  type AssembleThreadForkInput,
  type AssembleThreadForkResult,
} from "./threadFork.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sourceThreadId = ThreadId.make("thread-source");
const childThreadId = ThreadId.make("thread-child");
const otherThreadId = ThreadId.make("thread-other");
const projectId = ProjectId.make("project-fork");

const t = (minute: number, second = 0) =>
  `2026-05-01T00:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

const turn1 = TurnId.make("turn-1");
const turn2 = TurnId.make("turn-2");
const turn3 = TurnId.make("turn-3");
const turn4 = TurnId.make("turn-4");

const msgUser1 = MessageId.make("aaaaaaa1-0000-4000-8000-000000000001");
const msgAssistant1 = MessageId.make("assistant:aaaaaaa1-0000-4000-8000-000000000002");
const msgPre = MessageId.make("aaaaaaa1-0000-4000-8000-000000000000");
const msgUser2 = MessageId.make("aaaaaaa1-0000-4000-8000-000000000003");
const msgAssistant2 = MessageId.make("assistant:aaaaaaa1-0000-4000-8000-000000000004");
const msgUser3 = MessageId.make("aaaaaaa1-0000-4000-8000-000000000005");
const msgAssistant3 = MessageId.make("assistant:aaaaaaa1-0000-4000-8000-000000000006");
const msgUser4 = MessageId.make("aaaaaaa1-0000-4000-8000-000000000007");

const planOld1 = "plan-source-1";
const planOld3 = "plan-source-3";
const planOtherThread = "plan-other-1";

const activity1 = EventId.make("aaaaaaa2-0000-4000-8000-000000000001");
const activityPre = EventId.make("aaaaaaa2-0000-4000-8000-000000000000");
const activity3 = EventId.make("aaaaaaa2-0000-4000-8000-000000000003");

const sourceAttachment: ChatAttachment = {
  type: "image",
  id: "thread-source-bbbbbbb1-0000-4000-8000-000000000001-png",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 1024,
};

const placeholderRef = "provider-diff:evt-placeholder-2";

const sourceMessages: OrchestrationThread["messages"] = [
  {
    id: msgPre,
    role: "user",
    text: "pre-turn draft",
    turnId: null,
    streaming: false,
    createdAt: t(0),
    updatedAt: t(0),
  },
  {
    id: msgUser1,
    role: "user",
    text: "first ask",
    attachments: [sourceAttachment],
    turnId: turn1,
    streaming: false,
    createdAt: t(1),
    updatedAt: t(1),
  },
  {
    id: msgAssistant1,
    role: "assistant",
    text: "first answer",
    turnId: turn1,
    streaming: false,
    createdAt: t(1, 30),
    updatedAt: t(1, 30),
  },
  {
    id: msgUser2,
    role: "user",
    text: "second ask",
    turnId: turn2,
    streaming: false,
    createdAt: t(2),
    updatedAt: t(2),
  },
  {
    id: msgAssistant2,
    role: "assistant",
    text: "second answer",
    turnId: turn2,
    streaming: false,
    createdAt: t(2, 30),
    updatedAt: t(2, 30),
  },
  {
    id: msgUser3,
    role: "user",
    text: "third ask",
    turnId: turn3,
    streaming: false,
    createdAt: t(3),
    updatedAt: t(3),
  },
  {
    id: msgAssistant3,
    role: "assistant",
    text: "third answer",
    turnId: turn3,
    streaming: false,
    createdAt: t(3, 30),
    updatedAt: t(3, 30),
  },
  {
    id: msgUser4,
    role: "user",
    text: "fourth ask",
    turnId: turn4,
    streaming: false,
    createdAt: t(4),
    updatedAt: t(4),
  },
];

const sourceProposedPlans: OrchestrationThread["proposedPlans"] = [
  {
    id: planOld1,
    turnId: turn1,
    planMarkdown: "# plan one",
    implementedAt: null,
    implementationThreadId: null,
    createdAt: t(1, 15),
    updatedAt: t(1, 15),
  },
  {
    id: planOld3,
    turnId: turn3,
    planMarkdown: "# plan three",
    implementedAt: t(3, 45),
    implementationThreadId: sourceThreadId,
    createdAt: t(3, 15),
    updatedAt: t(3, 45),
  },
];

const sourceActivities: ReadonlyArray<OrchestrationThreadActivity> = [
  {
    id: activityPre,
    tone: "info",
    kind: "thread.note",
    summary: "created",
    payload: { note: "created" },
    turnId: null,
    createdAt: t(0, 30),
  },
  {
    id: activity1,
    tone: "tool",
    kind: "tool.ran",
    summary: "ran a tool",
    payload: { tool: "bash" },
    turnId: turn1,
    createdAt: t(1, 20),
  },
  {
    id: activity3,
    tone: "info",
    kind: "tool.ran",
    summary: "ran another tool",
    payload: { tool: "bash" },
    turnId: turn3,
    createdAt: t(3, 20),
  },
];

const sourceTurns: ReadonlyArray<ProjectionTurn> = [
  {
    threadId: sourceThreadId,
    turnId: turn1,
    pendingMessageId: msgUser1,
    sourceProposedPlanThreadId: null,
    sourceProposedPlanId: null,
    assistantMessageId: msgAssistant1,
    state: "completed",
    requestedAt: t(1),
    startedAt: t(1, 5),
    completedAt: t(1, 30),
    checkpointTurnCount: 1,
    checkpointRef: checkpointRefForThreadTurn(sourceThreadId, 1),
    checkpointStatus: "ready",
    checkpointFiles: [{ path: "src/a.ts", kind: "modified", additions: 3, deletions: 1 }],
    providerTurnRef: "prov-turn-1",
  },
  {
    threadId: sourceThreadId,
    turnId: turn2,
    pendingMessageId: msgUser2,
    // Same-thread plan execution: this turn ran planOld1 from the source.
    sourceProposedPlanThreadId: sourceThreadId,
    sourceProposedPlanId: planOld1,
    assistantMessageId: msgAssistant2,
    state: "completed",
    requestedAt: t(2),
    startedAt: t(2, 5),
    completedAt: t(2, 30),
    checkpointTurnCount: 2,
    checkpointRef: CheckpointRef.make(placeholderRef),
    checkpointStatus: "missing",
    checkpointFiles: [],
    providerTurnRef: null,
  },
  {
    threadId: sourceThreadId,
    turnId: turn3,
    pendingMessageId: msgUser3,
    // Cross-thread plan execution: preserved verbatim on the copy.
    sourceProposedPlanThreadId: otherThreadId,
    sourceProposedPlanId: planOtherThread,
    assistantMessageId: msgAssistant3,
    state: "completed",
    requestedAt: t(3),
    startedAt: t(3, 5),
    completedAt: t(3, 30),
    checkpointTurnCount: 3,
    checkpointRef: checkpointRefForThreadTurn(sourceThreadId, 3),
    checkpointStatus: "ready",
    checkpointFiles: [],
    providerTurnRef: "prov-turn-3",
  },
  {
    threadId: sourceThreadId,
    turnId: turn4,
    pendingMessageId: msgUser4,
    sourceProposedPlanThreadId: null,
    sourceProposedPlanId: null,
    assistantMessageId: null,
    state: "running",
    requestedAt: t(4),
    startedAt: t(4, 5),
    completedAt: null,
    checkpointTurnCount: null,
    checkpointRef: null,
    checkpointStatus: null,
    checkpointFiles: [],
    providerTurnRef: null,
  },
];

const sourceThread: OrchestrationThread = {
  id: sourceThreadId,
  projectId,
  title: "Parent thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: "/tmp/fork-worktree",
  linkedPullRequest: {
    projectId,
    repository: "t3tools/t3code",
    number: 42,
    url: "https://github.com/t3tools/t3code/pull/42",
  },
  latestTurn: null,
  createdAt: t(0),
  updatedAt: t(4),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: sourceMessages,
  proposedPlans: sourceProposedPlans,
  activities: [],
  checkpoints: [],
  session: null,
};

const sourceBinding: ProviderRuntimeBinding = {
  threadId: sourceThreadId,
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  resumeCursor: { threadId: "native-source-thread" },
};

function makeMintUuid(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
}

function makeInput(overrides?: Partial<AssembleThreadForkInput>): AssembleThreadForkInput {
  return {
    source: sourceThread,
    sourceTurns,
    sourceActivities,
    sourceForkSource: null,
    sourceBinding,
    childThreadId,
    throughTurnId: turn3,
    sourceMessageId: msgAssistant3,
    title: null,
    createdAt: t(10),
    requiresAnchor: false,
    mintUuid: makeMintUuid(),
    ...overrides,
  };
}

function assertOk(
  result: AssembleThreadForkResult,
): asserts result is Extract<AssembleThreadForkResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected ok assembly, got failure: ${JSON.stringify(result.failure)}`);
  }
}

describe("assembleThreadFork", () => {
  it("forks at the last completed turn: keeps all completed turns, ordinal; a trailing running turn defeats atEnd", () => {
    const result = assembleThreadFork(makeInput());
    assertOk(result);
    const { command } = result;

    expect(command.type).toBe("thread.fork");
    expect(command.threadId).toBe(childThreadId);
    expect(command.sourceThreadId).toBe(sourceThreadId);
    expect(command.throughTurnId).toBe(turn3);
    expect(command.createdAt).toBe(t(10));
    expect(command.history.turns.map((turn) => turn.turnId)).toEqual([turn1, turn2, turn3]);
    expect(command.forkSource).not.toBeNull();
    // turn-4 is still running behind the fork point, so this is not "at end".
    expect(command.forkSource?.atEnd).toBe(false);
    expect(command.forkSource?.throughTurnOrdinal).toBe(3);
    expect(command.forkSource?.providerTurnRef).toBe("prov-turn-3");
    expect(command.forkSource?.providerInstanceId).toBe(sourceBinding.providerInstanceId);
    expect(command.forkSource?.resumeCursor).toEqual(sourceBinding.resumeCursor);
  });

  it("forks at the first turn: keeps pre-first-turn rows and turn one only", () => {
    const result = assembleThreadFork(makeInput({ throughTurnId: turn1, sourceMessageId: null }));
    assertOk(result);
    const { command } = result;

    expect(command.history.turns.map((turn) => turn.turnId)).toEqual([turn1]);
    expect(command.history.messages.map((message) => message.text)).toEqual([
      "pre-turn draft",
      "first ask",
      "first answer",
    ]);
    expect(command.history.messages[0]?.turnId).toBeNull();
    expect(command.history.activities.map((activity) => activity.summary)).toEqual([
      "created",
      "ran a tool",
    ]);
    expect(command.history.proposedPlans.map((plan) => plan.planMarkdown)).toEqual(["# plan one"]);
    expect(command.forkSource?.atEnd).toBe(false);
    expect(command.forkSource?.throughTurnOrdinal).toBe(1);
    expect(command.forkedFrom.messageId).toBeNull();
  });

  it("builds the child creation fields and lineage from the source", () => {
    const result = assembleThreadFork(makeInput());
    assertOk(result);
    const { command } = result;

    expect(command.thread).toEqual({
      projectId,
      title: "Parent thread (fork)",
      modelSelection: sourceThread.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: "/tmp/fork-worktree",
    });
    expect(command.forkedFrom).toEqual({
      threadId: sourceThreadId,
      turnId: turn3,
      turnCount: 3,
      messageId: msgAssistant3,
    });

    const titled = assembleThreadFork(makeInput({ title: "My fork" }));
    assertOk(titled);
    expect(titled.command.thread.title).toBe("My fork");
  });

  it("mints fresh ids disjoint from the parent for messages, activities and plans", () => {
    const result = assembleThreadFork(makeInput());
    assertOk(result);
    const { command } = result;

    const oldMessageIds = new Set(sourceMessages.map((message) => message.id));
    for (const message of command.history.messages) {
      expect(oldMessageIds.has(message.id)).toBe(false);
      if (message.role === "assistant") {
        expect(message.id.startsWith("assistant:")).toBe(true);
        expect(UUID_PATTERN.test(message.id.slice("assistant:".length))).toBe(true);
      } else {
        expect(UUID_PATTERN.test(message.id)).toBe(true);
      }
    }

    const oldActivityIds = new Set(sourceActivities.map((activity) => activity.id));
    for (const activity of command.history.activities) {
      expect(oldActivityIds.has(activity.id)).toBe(false);
    }

    const oldPlanIds = new Set(sourceProposedPlans.map((plan) => plan.id));
    for (const plan of command.history.proposedPlans) {
      expect(oldPlanIds.has(plan.id)).toBe(false);
    }

    // Ids are unique within the copy too.
    const allIds = [
      ...command.history.messages.map((message) => message.id),
      ...command.history.activities.map((activity) => activity.id),
      ...command.history.proposedPlans.map((plan) => plan.id),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("preserves timestamps on every copied row", () => {
    const result = assembleThreadFork(makeInput());
    assertOk(result);
    const { command } = result;

    expect(command.history.messages.map((message) => message.createdAt)).toEqual(
      sourceMessages.slice(0, 7).map((message) => message.createdAt),
    );
    expect(command.history.messages.map((message) => message.updatedAt)).toEqual(
      sourceMessages.slice(0, 7).map((message) => message.updatedAt),
    );
    expect(command.history.turns.map((turn) => turn.requestedAt)).toEqual([t(1), t(2), t(3)]);
    expect(command.history.turns.map((turn) => turn.startedAt)).toEqual([
      t(1, 5),
      t(2, 5),
      t(3, 5),
    ]);
    expect(command.history.turns.map((turn) => turn.completedAt)).toEqual([
      t(1, 30),
      t(2, 30),
      t(3, 30),
    ]);
    expect(command.history.proposedPlans.map((plan) => plan.createdAt)).toEqual([
      t(1, 15),
      t(3, 15),
    ]);
    expect(command.history.activities.map((activity) => activity.createdAt)).toEqual([
      t(0, 30),
      t(1, 20),
      t(3, 20),
    ]);
  });

  it("rewrites turn message refs onto the minted ids", () => {
    const result = assembleThreadFork(makeInput());
    assertOk(result);
    const { command } = result;

    const copiedByText = new Map(
      command.history.messages.map((message) => [message.text, message.id]),
    );
    const [copiedTurn1, copiedTurn2, copiedTurn3] = command.history.turns;
    expect(copiedTurn1?.pendingMessageId).toBe(copiedByText.get("first ask"));
    expect(copiedTurn1?.assistantMessageId).toBe(copiedByText.get("first answer"));
    expect(copiedTurn2?.pendingMessageId).toBe(copiedByText.get("second ask"));
    expect(copiedTurn2?.assistantMessageId).toBe(copiedByText.get("second answer"));
    expect(copiedTurn3?.assistantMessageId).toBe(copiedByText.get("third answer"));
    // The checkpoint summary carries the same rewritten assistant id.
    expect(copiedTurn3?.checkpoint?.assistantMessageId).toBe(copiedByText.get("third answer"));
  });

  it("rewrites same-thread plan refs through the plan-id map and preserves cross-thread refs", () => {
    const result = assembleThreadFork(makeInput());
    assertOk(result);
    const { command } = result;

    const copiedPlanOne = command.history.proposedPlans.find(
      (plan) => plan.planMarkdown === "# plan one",
    );
    expect(copiedPlanOne).toBeDefined();

    const [, copiedTurn2, copiedTurn3] = command.history.turns;
    expect(copiedTurn2?.sourceProposedPlan).toEqual({
      threadId: childThreadId,
      planId: copiedPlanOne?.id,
    });
    expect(copiedTurn3?.sourceProposedPlan).toEqual({
      threadId: otherThreadId,
      planId: planOtherThread,
    });
  });

  it("re-namespaces canonical checkpoint refs and aliases them plus turn/0", () => {
    const result = assembleThreadFork(makeInput());
    assertOk(result);
    const { command, aliasRefs } = result;

    const [copiedTurn1, copiedTurn2, copiedTurn3] = command.history.turns;
    expect(copiedTurn1?.checkpoint?.checkpointRef).toBe(
      checkpointRefForThreadTurn(childThreadId, 1),
    );
    expect(copiedTurn1?.checkpoint?.checkpointTurnCount).toBe(1);
    expect(copiedTurn1?.checkpoint?.status).toBe("ready");
    expect(copiedTurn1?.checkpoint?.files).toEqual([
      { path: "src/a.ts", kind: "modified", additions: 3, deletions: 1 },
    ]);
    // Placeholder rows are copied verbatim: ref untouched, status preserved.
    expect(copiedTurn2?.checkpoint?.checkpointRef).toBe(placeholderRef);
    expect(copiedTurn2?.checkpoint?.status).toBe("missing");
    expect(copiedTurn3?.checkpoint?.checkpointRef).toBe(
      checkpointRefForThreadTurn(childThreadId, 3),
    );

    expect(aliasRefs).toHaveLength(3);
    expect(aliasRefs).toEqual(
      expect.arrayContaining([
        {
          from: checkpointRefForThreadTurn(sourceThreadId, 0),
          to: checkpointRefForThreadTurn(childThreadId, 0),
        },
        {
          from: checkpointRefForThreadTurn(sourceThreadId, 1),
          to: checkpointRefForThreadTurn(childThreadId, 1),
        },
        {
          from: checkpointRefForThreadTurn(sourceThreadId, 3),
          to: checkpointRefForThreadTurn(childThreadId, 3),
        },
      ]),
    );
  });

  it("aliases nothing when the slice holds no canonical refs", () => {
    const result = assembleThreadFork(
      makeInput({
        throughTurnId: turn2,
        sourceTurns: sourceTurns.slice(1, 2).map((turn) => ({
          ...turn,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
        })),
      }),
    );
    assertOk(result);
    expect(result.aliasRefs).toEqual([]);
    expect(result.command.history.turns[0]?.checkpoint?.checkpointRef).toBe(placeholderRef);
  });

  it("remaps attachments deterministically into the child namespace", () => {
    const first = assembleThreadFork(makeInput());
    const second = assembleThreadFork(makeInput());
    assertOk(first);
    assertOk(second);

    expect(first.attachmentCopies).toHaveLength(1);
    const copy = first.attachmentCopies[0];
    expect(copy?.attachment).toEqual(sourceAttachment);
    expect(UUID_PATTERN.test(copy?.uuid ?? "")).toBe(true);
    expect(copy?.finalId).toBe(`thread-child-${copy?.uuid}-png`);
    // Deterministic across retries.
    expect(second.attachmentCopies[0]?.uuid).toBe(copy?.uuid);
    expect(second.attachmentCopies[0]?.finalId).toBe(copy?.finalId);

    // The copied message row carries the child-namespaced id and nothing of
    // the parent's.
    const copiedFirstAsk = first.command.history.messages.find(
      (message) => message.text === "first ask",
    );
    expect(copiedFirstAsk?.attachments).toEqual([{ ...sourceAttachment, id: copy?.finalId }]);
    const copiedPre = first.command.history.messages.find(
      (message) => message.text === "pre-turn draft",
    );
    expect(copiedPre?.attachments).toBeUndefined();

    // A different child yields a different deterministic id.
    const otherChild = assembleThreadFork(makeInput({ childThreadId: otherThreadId }));
    assertOk(otherChild);
    expect(otherChild.attachmentCopies[0]?.uuid).not.toBe(copy?.uuid);
  });

  it("computes throughTurnOrdinal from assistant-emitting turns and atEnd only for the last turn row", () => {
    const midFork = assembleThreadFork(makeInput({ throughTurnId: turn2 }));
    assertOk(midFork);
    expect(midFork.command.forkSource?.throughTurnOrdinal).toBe(2);
    expect(midFork.command.forkSource?.atEnd).toBe(false);
    expect(midFork.command.forkSource?.providerTurnRef).toBeNull();

    // turn-4 is running and may already hold native content, so forking
    // through turn-3 is NOT at end — only the literal last turn row is.
    const endFork = assembleThreadFork(makeInput({ throughTurnId: turn3 }));
    assertOk(endFork);
    expect(endFork.command.forkSource?.atEnd).toBe(false);

    // An interrupted turn that still emitted an assistant message occupies a
    // slot in the provider's native assistant-message list, so it advances
    // the positional ordinal; one that produced nothing does not.
    const interruptedWithOutput = assembleThreadFork(
      makeInput({
        sourceTurns: sourceTurns.map((turn) =>
          turn.turnId === turn2 ? { ...turn, state: "interrupted" as const } : turn,
        ),
      }),
    );
    assertOk(interruptedWithOutput);
    expect(interruptedWithOutput.command.forkSource?.throughTurnOrdinal).toBe(3);

    const interruptedSilent = assembleThreadFork(
      makeInput({
        sourceTurns: sourceTurns.map((turn) =>
          turn.turnId === turn2
            ? { ...turn, state: "interrupted" as const, assistantMessageId: null }
            : turn,
        ),
      }),
    );
    assertOk(interruptedSilent);
    expect(interruptedSilent.command.forkSource?.throughTurnOrdinal).toBe(2);
  });

  it("bounds null-turn rows by the fork turn's completion time", () => {
    const queuedMessage = {
      id: MessageId.make("aaaaaaa1-0000-4000-8000-000000000099"),
      role: "user" as const,
      text: "queued after fork",
      turnId: null,
      streaming: false,
      createdAt: t(5),
      updatedAt: t(5),
    };
    const queuedActivity = {
      id: EventId.make("aaaaaaa2-0000-4000-8000-000000000099"),
      tone: "info" as const,
      kind: "thread.note",
      summary: "queued after fork",
      payload: {},
      turnId: null,
      createdAt: t(5),
    };
    const result = assembleThreadFork(
      makeInput({
        source: { ...sourceThread, messages: [...sourceMessages, queuedMessage] },
        sourceActivities: [...sourceActivities, queuedActivity],
      }),
    );
    assertOk(result);

    // The user message queued after the fork point stays with the source;
    // the genuinely pre-first-turn rows still ride along.
    const messageTexts = result.command.history.messages.map((message) => message.text);
    expect(messageTexts).toContain("pre-turn draft");
    expect(messageTexts).not.toContain("queued after fork");
    const activitySummaries = result.command.history.activities.map((activity) => activity.summary);
    expect(activitySummaries).toContain("created");
    expect(activitySummaries).not.toContain("queued after fork");
  });

  it("fails assembly when a copied attachment id cannot be derived", () => {
    const result = assembleThreadFork(makeInput({ childThreadId: ThreadId.make("!!!") }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toEqual({
        kind: "attachment-id-underivable",
        attachmentId: sourceAttachment.id,
      });
    }
  });

  it("fails assembly when two source refs would alias onto one child ref", () => {
    const conflictingTurns = sourceTurns.map((turn) =>
      turn.turnId === turn1
        ? {
            ...turn,
            checkpointRef: checkpointRefForThreadTurn(otherThreadId, 3),
            checkpointTurnCount: 3,
          }
        : turn,
    );
    const result = assembleThreadFork(makeInput({ sourceTurns: conflictingTurns }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toEqual({
        kind: "duplicate-alias-target",
        checkpointRef: checkpointRefForThreadTurn(childThreadId, 3),
      });
    }
  });

  it("falls back to the source's persisted forkSource when it has no live binding", () => {
    const persisted: ThreadForkProviderSource = {
      providerInstanceId: ProviderInstanceId.make("claude"),
      resumeCursor: { resume: "grandparent-session" },
      providerTurnRef: "prov-grandparent",
      throughTurnOrdinal: 2,
      atEnd: true,
    };
    const result = assembleThreadFork(
      makeInput({ sourceBinding: null, sourceForkSource: persisted }),
    );
    assertOk(result);
    expect(result.command.forkSource?.providerInstanceId).toBe(persisted.providerInstanceId);
    expect(result.command.forkSource?.resumeCursor).toEqual(persisted.resumeCursor);
    // Anchor, ordinal and atEnd still describe THIS fork point, not the
    // parent's own lineage.
    expect(result.command.forkSource?.providerTurnRef).toBe("prov-turn-3");
    expect(result.command.forkSource?.throughTurnOrdinal).toBe(3);
    expect(result.command.forkSource?.atEnd).toBe(false);

    const cold = assembleThreadFork(makeInput({ sourceBinding: null, sourceForkSource: null }));
    assertOk(cold);
    expect(cold.command.forkSource).toBeNull();
  });

  it("rejects an anchorless mid-thread fork when the provider requires anchors", () => {
    const rejected = assembleThreadFork(makeInput({ throughTurnId: turn2, requiresAnchor: true }));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.failure).toEqual({ kind: "anchor-unavailable", turnId: turn2 });
    }

    // Providers with a positional fallback assemble the same anchorless
    // mid-thread fork; the adapter substitutes its own anchor downstream.
    const tolerated = assembleThreadFork(
      makeInput({ throughTurnId: turn2, requiresAnchor: false }),
    );
    assertOk(tolerated);
    expect(tolerated.command.forkSource?.providerTurnRef).toBeNull();
    expect(tolerated.command.forkSource?.atEnd).toBe(false);

    // A fork at the literal last turn row passes even without an anchor —
    // but only when nothing (running or interrupted) trails it.
    const anchorlessBehindRunning = assembleThreadFork(
      makeInput({
        requiresAnchor: true,
        throughTurnId: turn3,
        sourceTurns: sourceTurns.map((turn) =>
          turn.turnId === turn3 ? { ...turn, providerTurnRef: null } : turn,
        ),
      }),
    );
    expect(anchorlessBehindRunning.ok).toBe(false);

    const anchorlessEnd = assembleThreadFork(
      makeInput({
        requiresAnchor: true,
        throughTurnId: turn3,
        sourceTurns: sourceTurns
          .slice(0, 3)
          .map((turn) => (turn.turnId === turn3 ? { ...turn, providerTurnRef: null } : turn)),
      }),
    );
    assertOk(anchorlessEnd);
    expect(anchorlessEnd.command.forkSource?.providerTurnRef).toBeNull();
  });

  it("rejects running turns, unknown turns and deleted sources", () => {
    const running = assembleThreadFork(makeInput({ throughTurnId: turn4 }));
    expect(running.ok).toBe(false);
    if (!running.ok) {
      expect(running.failure).toEqual({
        kind: "turn-not-completed",
        turnId: turn4,
        state: "running",
      });
    }

    const unknownTurn = TurnId.make("turn-unknown");
    const unknown = assembleThreadFork(makeInput({ throughTurnId: unknownTurn }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.failure).toEqual({ kind: "turn-not-found", turnId: unknownTurn });
    }

    const deleted = assembleThreadFork(makeInput({ source: { ...sourceThread, deletedAt: t(9) } }));
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) {
      expect(deleted.failure).toEqual({ kind: "source-deleted", threadId: sourceThreadId });
    }
  });
});
