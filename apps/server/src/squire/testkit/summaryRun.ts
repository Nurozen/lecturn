import {
  OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  type SquireFileEntry,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import type { SquireRunSnapshot } from "../SquireSummaryInput.ts";

export const summaryThreadId = ThreadId.make("thr_fix_invoice_rounding");
export const summaryRunId = RunId.make("run-1");

const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
let ordinal = 0;

/** A turn item of this run, decoded so the test data stays valid. */
export function turnItem(type: OrchestrationV2TurnItem["type"], fields: Record<string, unknown>) {
  ordinal++;
  return decodeItem({
    id: `item-${ordinal}`,
    threadId: summaryThreadId,
    runId: summaryRunId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
    type,
    ...fields,
  });
}

export const userMessage = (text: string) =>
  turnItem("user_message", {
    messageId: `msg-user-${ordinal + 1}`,
    inputIntent: "turn_start",
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  });
export const assistantMessage = (text: string) =>
  turnItem("assistant_message", { messageId: `msg-agent-${ordinal + 1}`, text, streaming: false });
export const command = (input: string, exitCode?: number) =>
  turnItem("command_execution", { input, ...(exitCode === undefined ? {} : { exitCode }) });
export const fileChange = (fileName: string, operation?: string) =>
  turnItem("file_change", {
    fileName,
    ...(operation ? { changes: [{ operation, path: fileName }] } : {}),
  });

export function runSnapshot(overrides: Partial<SquireRunSnapshot> = {}): SquireRunSnapshot {
  return {
    thread: {
      threadId: summaryThreadId,
      title: "Fix invoice rounding",
      project: "billing-service",
      projectId: ProjectId.make("project-billing"),
      provider: ProviderDriverKind.make("claudeAgent"),
    },
    runId: summaryRunId,
    status: "completed",
    pendingRequest: null,
    interruptedBy: null,
    turnItems: [],
    files: [] satisfies ReadonlyArray<SquireFileEntry>,
    insertions: 0,
    deletions: 0,
    pullRequest: null,
    ...overrides,
  };
}
