import { SquireSummaryInput, type SquireFileEntry } from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  parseSquireNameStatus,
  squireDeterministicSummary,
  squireFilesFromCheckpoint,
  squireSummaryInputFromRun,
  squireSummaryWithModel,
} from "./SquireSummaryInput.ts";
import {
  assistantMessage,
  command,
  fileChange,
  runSnapshot,
  turnItem,
  userMessage,
} from "./testkit/summaryRun.ts";

const decodeInput = Schema.decodeUnknownSync(SquireSummaryInput);

const files = (count: number): ReadonlyArray<SquireFileEntry> =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/file-${index}.ts`,
    change: index % 3 === 0 ? "added" : index % 3 === 1 ? "modified" : "deleted",
  }));

describe("squireSummaryInputFromRun", () => {
  it("converts a run's items into a valid summary input", () => {
    const input = squireSummaryInputFromRun(
      runSnapshot({
        turnItems: [
          userMessage("Fix the rounding."),
          fileChange("src/invoice/roundHalfEven.ts", "add"),
          fileChange("src/invoice/InvoiceTotals.ts"),
          command("  vp test run src/invoice  ", 0),
          command("vp run typecheck", 2),
          command("sleep 100"),
          turnItem("reasoning", { text: "thinking", streaming: false }),
          assistantMessage("First pass."),
          assistantMessage("Fixed. Want me to open a PR?"),
        ],
        files: files(2),
        insertions: 61,
        deletions: 9,
      }),
    );
    expect(() => decodeInput(input)).not.toThrow();
    expect(input.messages).toEqual([
      { role: "user", text: "Fix the rounding." },
      { role: "assistant", text: "First pass." },
      { role: "assistant", text: "Fixed. Want me to open a PR?", final: true },
    ]);
    expect(input.toolCalls).toEqual([
      { kind: "create", path: "src/invoice/roundHalfEven.ts" },
      { kind: "edit", path: "src/invoice/InvoiceTotals.ts" },
      { kind: "command", command: "vp test run src/invoice", exitCode: 0 },
      { kind: "command", command: "vp run typecheck", exitCode: 2 },
      { kind: "command", command: "sleep 100", exitCode: null },
    ]);
    expect(input.diffStats).toEqual({
      added: 1,
      modified: 1,
      deleted: 0,
      insertions: 61,
      deletions: 9,
    });
    expect(input.session).toEqual({
      status: "completed",
      pendingRuntimeRequest: null,
      interruptedBy: null,
    });
  });

  it("names other tool items by title, falling back to their type", () => {
    const input = squireSummaryInputFromRun(
      runSnapshot({
        turnItems: [
          turnItem("web_search", { patterns: ["half-even"] }),
          turnItem("file_search", { title: "Search invoices", pattern: "round" }),
        ],
      }),
    );
    expect(input.toolCalls).toEqual([
      { kind: "other", name: "web_search" },
      { kind: "other", name: "Search invoices" },
    ]);
  });
});

describe("parseSquireNameStatus", () => {
  it("reads NUL-separated and line output with exact kinds", () => {
    const expected = [
      { path: "src/a.ts", change: "added" },
      { path: "src/with space.ts", change: "modified" },
      { path: "src/c.ts", change: "deleted" },
      { path: "bin/tool", change: "modified" },
    ];
    expect(
      parseSquireNameStatus("A\0src/a.ts\0M\0src/with space.ts\0D\0src/c.ts\0T\0bin/tool\0"),
    ).toEqual(expected);
    expect(
      parseSquireNameStatus("A\tsrc/a.ts\nM\tsrc/with space.ts\nD\tsrc/c.ts\nT\tbin/tool\n"),
    ).toEqual(expected);
    expect(parseSquireNameStatus("")).toEqual([]);
  });
});

describe("squireFilesFromCheckpoint", () => {
  it("takes kinds from the run's file-change items", () => {
    const summary = (path: string) => ({ path, kind: "modified", additions: 1, deletions: 0 });
    expect(
      squireFilesFromCheckpoint(
        [summary("src/new.ts"), summary("src/old.ts"), summary("src/edited.ts")],
        [
          fileChange("src/new.ts", "add"),
          fileChange("src/old.ts", "delete"),
          fileChange("src/edited.ts", "update"),
        ],
      ),
    ).toEqual([
      { path: "src/new.ts", change: "added" },
      { path: "src/old.ts", change: "deleted" },
      { path: "src/edited.ts", change: "modified" },
    ]);
  });
});

describe("squireDeterministicSummary", () => {
  it("keeps input order, the first 10 files and 5 commands, and counts over every file", () => {
    const input = squireSummaryInputFromRun(
      runSnapshot({
        turnItems: Array.from({ length: 7 }, (_, index) => command(`step ${index}`, index % 2)),
        files: files(14),
      }),
    );
    const summary = squireDeterministicSummary(input, "finished");
    expect(summary.files.entries).toEqual(files(14).slice(0, 10));
    expect(summary.files.counts).toEqual({ added: 5, modified: 5, deleted: 4 });
    expect(summary.commands.map((entry) => entry.command)).toEqual([
      "step 0",
      "step 1",
      "step 2",
      "step 3",
      "step 4",
    ]);
    expect(summary.commands[1]).toEqual({ command: "step 1", exitCode: 1, pass: false });
    expect(summary.summaryStatus).toBe("partial");
    expect(summary.goal).toBe("");
  });

  it("uses the pending request's text as the question while waiting on input", () => {
    const input = squireSummaryInputFromRun(
      runSnapshot({
        status: "waiting",
        pendingRequest: { kind: "user_input", requestId: "req-1", question: "Which currency?" },
      }),
    );
    const deterministic = squireDeterministicSummary(input, "waiting-on-input");
    expect(deterministic.pendingQuestion).toBe("Which currency?");
    const complete = squireSummaryWithModel(deterministic, {
      goal: "Plan the rollout",
      completed: [],
      remaining: [],
      blocked: [],
      pendingQuestion: "Something the model made up?",
      suggestedNextStep: null,
    });
    expect(complete.summaryStatus).toBe("complete");
    expect(complete.pendingQuestion).toBe("Which currency?");
    expect(complete.files).toBe(deterministic.files);
  });

  it("trims one layer of matching quote marks from the model's question", () => {
    const deterministic = squireDeterministicSummary(
      squireSummaryInputFromRun(runSnapshot({})),
      "finished",
    );
    const question = (pendingQuestion: string) =>
      squireSummaryWithModel(deterministic, {
        goal: "Fix rounding",
        completed: [],
        remaining: [],
        blocked: [],
        pendingQuestion,
        suggestedNextStep: null,
      }).pendingQuestion;
    expect(question('"Want me to open a PR?"')).toBe("Want me to open a PR?");
    expect(question("\u201cWant me to open a PR?\u201d")).toBe("Want me to open a PR?");
    expect(question("'\"Nested?\"'")).toBe('"Nested?"');
    expect(question('"Run it" or skip it?')).toBe('"Run it" or skip it?');
    expect(question('"Ship A" or "Ship B"')).toBe('"Ship A" or "Ship B"');
    expect(question('""')).toBe('""');
  });
});
