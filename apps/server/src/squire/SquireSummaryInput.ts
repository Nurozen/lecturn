import type {
  OrchestrationV2Actor,
  OrchestrationV2CheckpointFileSummary,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItem,
  RunId,
  SquireFileEntry,
  SquireSummaryInput,
  SquireSummaryModelOutput,
  SquireTurnOutcome,
  SquireTurnSummary,
} from "@lecturn/contracts";

const MAX_FILE_ENTRIES = 10;
const MAX_COMMAND_ENTRIES = 5;

type ToolCall = SquireSummaryInput["toolCalls"][number];

/** One run as orchestration state has it, before conversion to the summary input. */
export interface SquireRunSnapshot {
  readonly thread: SquireSummaryInput["thread"];
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly pendingRequest: SquireSummaryInput["session"]["pendingRuntimeRequest"];
  readonly interruptedBy: OrchestrationV2Actor | null;
  /** This run's items in ordinal order. */
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  /** The run's changed files with exact kinds, repo-relative, in diff order. */
  readonly files: ReadonlyArray<SquireFileEntry>;
  readonly insertions: number;
  readonly deletions: number;
  readonly pullRequest: SquireSummaryInput["pullRequest"];
}

// Items that are conversation bookkeeping, not work the agent did.
const NON_TOOL_ITEMS: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "notification",
  "user_message",
  "assistant_message",
  "reasoning",
  "proposed_plan",
  "todo_list",
  "user_input_request",
  "approval_request",
  "checkpoint",
  "run_interrupt_request",
  "run_interrupt_result",
  "system_notice",
  "error",
  "compaction",
  "handoff",
  "fork",
  "thread_created",
  "secret_request",
]);

const fileChangeKind = (operation: string | undefined): "create" | "delete" | "edit" => {
  const normalized = operation?.toLowerCase();
  if (normalized === "add" || normalized === "create" || normalized === "added") return "create";
  if (normalized === "delete" || normalized === "remove" || normalized === "deleted") {
    return "delete";
  }
  return "edit";
};

function toolCallsOf(item: OrchestrationV2TurnItem): ReadonlyArray<ToolCall> {
  switch (item.type) {
    case "command_execution": {
      const command = item.input.trim();
      return command ? [{ kind: "command", command, exitCode: item.exitCode ?? null }] : [];
    }
    case "file_change": {
      const changes = item.changes ?? [];
      if (changes.length === 0) return [{ kind: "edit", path: item.fileName }];
      return changes.map((change) => ({
        kind: fileChangeKind(change.operation),
        path: change.path,
      }));
    }
    default:
      return NON_TOOL_ITEMS.has(item.type)
        ? []
        : [{ kind: "other", name: item.title?.trim() || item.type }];
  }
}

export function squireSummaryInputFromRun(run: SquireRunSnapshot): SquireSummaryInput {
  const messages: Array<SquireSummaryInput["messages"][number]> = [];
  for (const item of run.turnItems) {
    if (item.type === "user_message") messages.push({ role: "user", text: item.text });
    if (item.type === "assistant_message" && item.text.trim()) {
      messages.push({ role: "assistant", text: item.text });
    }
  }
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
  if (lastAssistant >= 0) messages[lastAssistant] = { ...messages[lastAssistant]!, final: true };

  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const file of run.files) counts[file.change]++;

  return {
    thread: run.thread,
    turnId: run.runId,
    session: {
      status: run.status,
      pendingRuntimeRequest: run.pendingRequest,
      interruptedBy: run.interruptedBy,
    },
    messages,
    toolCalls: run.turnItems.flatMap(toolCallsOf),
    files: run.files,
    diffStats: { ...counts, insertions: run.insertions, deletions: run.deletions },
    pullRequest: run.pullRequest,
  };
}

/**
 * Parses `git diff --name-status --no-renames`, NUL-separated (`-z`) or
 * line-based. A type change or unmerged entry reads as modified.
 */
export function parseSquireNameStatus(text: string): ReadonlyArray<SquireFileEntry> {
  const tokens = text.includes("\0")
    ? text.split("\0")
    : text.split("\n").flatMap((line) => line.split("\t"));
  const entries: Array<SquireFileEntry> = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const status = tokens[index]!.trim();
    const path = tokens[index + 1]!;
    if (!status || !path.trim()) continue;
    const change = status.startsWith("A")
      ? "added"
      : status.startsWith("D")
        ? "deleted"
        : "modified";
    entries.push({ path, change });
  }
  return entries;
}

/**
 * Files from the run's checkpoint summary, whose kinds are always
 * `modified`, with kinds taken from the run's own file-change items. The
 * fallback when the checkpoint's name-status diff cannot be read.
 */
export function squireFilesFromCheckpoint(
  checkpointFiles: ReadonlyArray<OrchestrationV2CheckpointFileSummary>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<SquireFileEntry> {
  const kinds = new Map<string, SquireFileEntry["change"]>();
  for (const item of turnItems) {
    for (const call of toolCallsOf(item)) {
      if (call.kind === "create") kinds.set(call.path, kinds.get(call.path) ?? "added");
      if (call.kind === "delete") {
        // Created and deleted in one run leaves no file, so the checkpoint omits it.
        kinds.set(call.path, kinds.get(call.path) === "added" ? "modified" : "deleted");
      }
    }
  }
  return checkpointFiles.map((file) => ({
    path: file.path,
    change: kinds.get(file.path) ?? "modified",
  }));
}

const EMPTY_MODEL_FIELDS: SquireSummaryModelOutput = {
  goal: "",
  completed: [],
  remaining: [],
  blocked: [],
  pendingQuestion: null,
  suggestedNextStep: null,
};

/**
 * The summary with only deterministic fields filled: a `partial` summary.
 * Entries keep input order; the first 10 files and 5 commands are kept and
 * the file counts cover every file. A command with no exit code yet is left
 * out, because a command entry's pass/fail needs one.
 */
export function squireDeterministicSummary(
  input: SquireSummaryInput,
  outcome: SquireTurnOutcome,
): SquireTurnSummary {
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const file of input.files) counts[file.change]++;
  const commands = input.toolCalls.flatMap((call) =>
    call.kind === "command" && call.exitCode !== null
      ? [{ command: call.command.trim(), exitCode: call.exitCode, pass: call.exitCode === 0 }]
      : [],
  );
  return {
    threadId: input.thread.threadId,
    threadTitle: input.thread.title,
    project: input.thread.project,
    ...(input.thread.projectId !== undefined ? { projectId: input.thread.projectId } : {}),
    provider: input.thread.provider,
    turnId: input.turnId,
    outcome,
    summaryStatus: "partial",
    ...EMPTY_MODEL_FIELDS,
    pendingQuestion: requestQuestion(input, outcome),
    files: { entries: input.files.slice(0, MAX_FILE_ENTRIES), counts },
    commands: commands.slice(0, MAX_COMMAND_ENTRIES),
    pullRequest: input.pullRequest,
  };
}

// For waiting-on-input the question is the pending request's own text, not the model's.
const requestQuestion = (input: SquireSummaryInput, outcome: SquireTurnOutcome) =>
  outcome === "waiting-on-input" ? (input.session.pendingRuntimeRequest?.question ?? null) : null;

const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "\u201c": "\u201d",
  "\u2018": "\u2019",
};

// Models asked for "the question" often wrap it in quote marks; the render adds none.
const unquoted = (text: string) => {
  const close = QUOTE_PAIRS[text[0] ?? ""];
  const inner = text.slice(1, -1).trim();
  // An inner closing mark means the ends belong to two quotes, as in `"A" or "B"`.
  return close !== undefined && text.endsWith(close) && inner && !inner.includes(close)
    ? inner
    : text;
};

/** Adds the model-written fields to a deterministic summary; it becomes `complete`. */
export function squireSummaryWithModel(
  deterministic: SquireTurnSummary,
  model: SquireSummaryModelOutput,
): SquireTurnSummary {
  return {
    ...deterministic,
    ...model,
    summaryStatus: "complete",
    pendingQuestion:
      deterministic.outcome === "waiting-on-input" && deterministic.pendingQuestion !== null
        ? deterministic.pendingQuestion
        : model.pendingQuestion && unquoted(model.pendingQuestion),
  };
}
