import * as Schema from "effect/Schema";
import { SquireSummaryInput } from "@lecturn/contracts";

export const squireSummaryInputFixture = Schema.decodeSync(SquireSummaryInput)({
  thread: { threadId: "thread-1", title: "Fix login", project: "web", provider: "codex" },
  turnId: "run-1",
  session: { status: "completed", pendingRuntimeRequest: null, interruptedBy: null },
  messages: [
    { role: "user", text: "Fix the login redirect" },
    { role: "assistant", text: "Fixed the redirect. Should I open a PR?", final: true },
  ],
  toolCalls: [{ kind: "edit", path: "src/login.ts" }],
  files: [{ path: "src/login.ts", change: "modified" }],
  diffStats: { added: 0, modified: 1, deleted: 0, insertions: 4, deletions: 1 },
  pullRequest: null,
});

export const squireSummaryReplyFixture = {
  goal: " Fix the login redirect ",
  completed: ["Fixed the login redirect in src/login.ts", " "],
  remaining: [],
  blocked: [],
  pendingQuestion: "Should I open a PR?",
  suggestedNextStep: "",
};

export const squireSummaryExpectedFixture = {
  goal: "Fix the login redirect",
  completed: ["Fixed the login redirect in src/login.ts"],
  remaining: [],
  blocked: [],
  pendingQuestion: "Should I open a PR?",
  suggestedNextStep: null,
};
