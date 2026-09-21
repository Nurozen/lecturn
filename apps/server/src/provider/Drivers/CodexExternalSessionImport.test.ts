import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import { describe, expect } from "vite-plus/test";

import { CodexResumeCursorSchema } from "../Layers/CodexSessionRuntime.ts";
import {
  type CodexImportTurn,
  codexTurnsToTranscript,
  makeCodexExternalSessionImporter,
} from "./CodexExternalSessionImport.ts";

const SECRET = "sk-live-DO-NOT-LEAK-7f3a";
const isCodexResumeCursor = Schema.is(CodexResumeCursorSchema);

function turn(overrides: Partial<CodexImportTurn> & { id: string }): CodexImportTurn {
  return { status: "completed", startedAt: 1_750_000_000, items: [], ...overrides };
}

const userMessage = (text: string) => ({
  type: "userMessage",
  id: "user",
  content: [{ type: "text", text, text_elements: [] }],
});
const agentMessage = (text: string) => ({ type: "agentMessage", id: "agent", text });
const commandExecution = {
  type: "commandExecution",
  id: "command",
  command: "cat .env",
  commandActions: [],
  cwd: "/repo",
  status: "completed",
  aggregatedOutput: `API_KEY=${SECRET}`,
  exitCode: 0,
};

describe("codexTurnsToTranscript", () => {
  it("keeps messages and turns tool items into completed-tool activities, in order", () => {
    const transcript = codexTurnsToTranscript(
      [
        turn({
          id: "turn-1",
          items: [
            userMessage("Fix the flaky test"),
            { type: "reasoning", id: "reasoning", summary: ["thinking"], content: [] },
            commandExecution,
            {
              type: "fileChange",
              id: "patch",
              status: "completed",
              changes: [{ path: "/repo/a.ts", kind: { type: "update" }, diff: `+${SECRET}` }],
            },
            {
              type: "mcpToolCall",
              id: "mcp",
              server: "github",
              tool: "get_issue",
              status: "completed",
              arguments: { token: SECRET },
              result: { content: [{ type: "text", text: SECRET }] },
            },
            {
              type: "dynamicToolCall",
              id: "dynamic",
              tool: "lookup",
              status: "completed",
              arguments: { q: SECRET },
            },
            { type: "webSearch", id: "search", query: "effect schema docs" },
            { type: "plan", id: "plan", text: "1. do it" },
            { type: "contextCompaction", id: "compaction" },
            agentMessage("Fixed."),
          ],
        }),
      ],
      0,
    );

    expect(
      transcript.map((entry) =>
        entry.kind === "message"
          ? [entry.role, entry.text]
          : [entry.itemType, entry.summary, entry.detail],
      ),
    ).toEqual([
      ["user", "Fix the flaky test"],
      ["command_execution", "Ran command", "cat .env"],
      ["file_change", "File change", undefined],
      ["mcp_tool_call", "github · get_issue", undefined],
      ["dynamic_tool_call", "Tool call", undefined],
      ["web_search", "Web search", "effect schema docs"],
      ["assistant", "Fixed."],
    ]);
    for (const entry of transcript) {
      if (entry.kind === "activity") {
        expect(entry).toMatchObject({ tone: "tool", activityKind: "tool.completed" });
      }
    }
    expect(JSON.stringify(transcript)).not.toContain(SECRET);
  });

  it("skips item types it does not know and items that do not decode", () => {
    const transcript = codexTurnsToTranscript(
      [
        turn({
          id: "turn-1",
          items: [
            { type: "holographicProjection", id: "future", command: SECRET },
            { type: "mcpToolCall", id: "drifted" },
            "not-an-item",
            null,
            agentMessage("Still here."),
          ],
        }),
      ],
      0,
    );
    expect(transcript).toEqual([
      {
        kind: "message",
        role: "assistant",
        text: "Still here.",
        createdAt: "2025-06-15T15:06:40.000Z",
      },
    ]);
  });

  it("joins a user message's text parts and stands in for its images", () => {
    const [message] = codexTurnsToTranscript(
      [
        turn({
          id: "turn-1",
          items: [
            {
              type: "userMessage",
              id: "user",
              content: [
                { type: "text", text: "What is this?" },
                { type: "image", url: `data:image/png;base64,${SECRET}` },
                { type: "localImage", path: "/tmp/shot.png" },
                { type: "mention", name: "file", path: "/repo/a.ts" },
                { type: "text", text: "And this?" },
              ],
            },
          ],
        }),
      ],
      0,
    );
    expect(message).toMatchObject({
      role: "user",
      text: "What is this?\n[image]\n[image]\nAnd this?",
    });
  });

  it("stamps items with their turn's start, else the latest time seen", () => {
    const transcript = codexTurnsToTranscript(
      [
        turn({ id: "old", startedAt: null, items: [userMessage("one")] }),
        turn({
          id: "timed",
          startedAt: 1_750_000_000,
          completedAt: 1_750_000_600,
          items: [userMessage("two"), agentMessage("three")],
        }),
        turn({ id: "untimed", startedAt: null, items: [userMessage("four")] }),
      ],
      1_749_000_000,
    );
    expect(transcript.map((entry) => entry.createdAt)).toEqual([
      "2025-06-04T01:20:00.000Z",
      "2025-06-15T15:06:40.000Z",
      "2025-06-15T15:06:40.000Z",
      "2025-06-15T15:16:40.000Z",
    ]);
  });
});

describe("makeCodexExternalSessionImporter", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const sourceThread = {
    id: "source",
    name: null,
    preview: "\n  Fix the flaky test  \nand the other one\n",
    cwd: "/source/repo",
    createdAt: 1_750_000_000,
    historyMode: "paginated",
  };
  const forkThread = (id: string) => ({
    thread: {
      id,
      name: null,
      preview: "",
      cwd: "/thread/cwd",
      createdAt: 1,
      historyMode: "paginated",
    },
  });
  const rpcError = (message: string) =>
    Effect.fail(
      new CodexErrors.CodexAppServerRequestError({ code: -32600, errorMessage: message }),
    );

  /** Answers each request through `respond` and records every call. */
  function importer(
    respond: (method: string) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>,
  ) {
    const calls: Array<readonly [string, unknown]> = [];
    const run = makeCodexExternalSessionImporter({
      instanceId,
      openClient: Effect.succeed({
        raw: {
          request: (method: string, payload?: unknown) => {
            calls.push([method, payload]);
            return respond(method);
          },
        },
      }),
    });
    return { calls, run: run({ sessionId: "source", cwd: "/thread/cwd" }) };
  }

  it.effect("forks the session and reads the transcript back from the fork", () =>
    Effect.gen(function* () {
      let pages = 0;
      const { calls, run } = importer((method) => {
        if (method === "thread/fork") return Effect.succeed(forkThread("fork-1"));
        if (method === "thread/read") return Effect.succeed({ thread: sourceThread });
        return Effect.succeed(
          // Newest first.
          ++pages === 1
            ? { data: [turn({ id: "t2", items: [agentMessage("hello")] })], nextCursor: "page-2" }
            : { data: [turn({ id: "t1", items: [userMessage("hi")] })], nextCursor: null },
        );
      });
      const imported = yield* run;

      expect(isCodexResumeCursor(imported.resumeCursor)).toBe(true);
      expect(imported.resumeCursor).toEqual({ threadId: "fork-1" });
      expect(imported.title).toBe("Fix the flaky test");
      expect(imported.cwd).toBe("/source/repo");
      expect(imported.transcript.map((entry) => entry.kind === "message" && entry.text)).toEqual([
        "hi",
        "hello",
      ]);
      expect(calls).toEqual([
        ["thread/fork", { threadId: "source", cwd: "/thread/cwd", excludeTurns: true }],
        [
          "thread/turns/list",
          { threadId: "fork-1", itemsView: "full", sortDirection: "desc", limit: 100 },
        ],
        [
          "thread/turns/list",
          {
            threadId: "fork-1",
            itemsView: "full",
            sortDirection: "desc",
            limit: 100,
            cursor: "page-2",
          },
        ],
        ["thread/read", { threadId: "source", includeTurns: false }],
      ]);
    }),
  );

  it.effect("forks again at the last completed turn when the session was cut off", () =>
    Effect.gen(function* () {
      let forks = 0;
      const { calls, run } = importer((method) => {
        if (method === "thread/fork") return Effect.succeed(forkThread(`fork-${++forks}`));
        if (method === "thread/read") return Effect.succeed({ thread: sourceThread });
        return Effect.succeed({
          data: [
            turn({ id: "t2", status: "interrupted", items: [userMessage("never answered")] }),
            turn({ id: "t1", items: [userMessage("hi"), agentMessage("hello")] }),
          ],
        });
      });
      const imported = yield* run;

      expect(imported.resumeCursor).toEqual({ threadId: "fork-2" });
      expect(imported.transcript.map((entry) => entry.kind === "message" && entry.text)).toEqual([
        "hi",
        "hello",
      ]);
      expect(
        calls.filter(([method]) => method === "thread/fork").map(([, payload]) => payload),
      ).toEqual([
        { threadId: "source", cwd: "/thread/cwd", excludeTurns: true },
        { threadId: "source", cwd: "/thread/cwd", lastTurnId: "t1", excludeTurns: true },
      ]);
    }),
  );

  it.effect("stops paging once it holds more messages than an import keeps", () =>
    Effect.gen(function* () {
      // Two messages a turn, 100 turns a page, numbered newest first.
      const page = (index: number) => ({
        data: Array.from({ length: 100 }, (_, offset) => {
          const age = index * 100 + offset;
          return turn({
            id: `t-${age}`,
            items: [userMessage(`ask ${age}`), agentMessage(`answer ${age}`)],
          });
        }),
        nextCursor: `page-${index + 1}`,
      });
      let pages = 0;
      const { calls, run } = importer((method) => {
        if (method === "thread/fork") return Effect.succeed(forkThread("fork-1"));
        if (method === "thread/read") return Effect.succeed({ thread: sourceThread });
        return Effect.succeed(page(pages++));
      });
      const imported = yield* run;

      // Page one holds exactly the cap, so one more page proves truncation.
      expect(calls.filter(([method]) => method === "thread/turns/list")).toHaveLength(2);
      const texts = imported.transcript.map((entry) => entry.kind === "message" && entry.text);
      expect(texts).toHaveLength(400);
      expect(texts.slice(0, 2)).toEqual(["ask 199", "answer 199"]);
      expect(texts.slice(-2)).toEqual(["ask 0", "answer 0"]);
    }),
  );

  it.effect("keeps the non-paginated fallback, cutting an unfinished tail", () =>
    Effect.gen(function* () {
      let forks = 0;
      const { calls, run } = importer((method) => {
        if (method === "thread/fork") {
          const fork = forkThread(`fork-${++forks}`);
          return Effect.succeed({ thread: { ...fork.thread, historyMode: null } });
        }
        // Chronological, as thread/read reports turns.
        return Effect.succeed({
          thread: {
            ...sourceThread,
            turns: [
              turn({ id: "t1", items: [userMessage("hi"), agentMessage("hello")] }),
              turn({ id: "t2", status: "interrupted", items: [userMessage("never answered")] }),
            ],
          },
        });
      });
      const imported = yield* run;

      expect(imported.resumeCursor).toEqual({ threadId: "fork-2" });
      expect(imported.transcript.map((entry) => entry.kind === "message" && entry.text)).toEqual([
        "hi",
        "hello",
      ]);
      expect(calls.some(([method]) => method === "thread/turns/list")).toBe(false);
    }),
  );

  it.effect("reports an empty session when no turn completed", () =>
    Effect.gen(function* () {
      const { calls, run } = importer((method) =>
        method === "thread/fork"
          ? Effect.succeed(forkThread("fork-1"))
          : Effect.succeed({
              data: [turn({ id: "t1", status: "interrupted", items: [userMessage("hi")] })],
            }),
      );
      const error = yield* Effect.flip(run);
      expect(error).toMatchObject({ reason: "empty-session", sessionId: "source" });
      expect(calls.filter(([method]) => method === "thread/fork")).toHaveLength(1);
    }),
  );

  it.effect("reports an unknown thread as not found", () =>
    Effect.gen(function* () {
      const { run } = importer(() => rpcError("no rollout found for thread id source"));
      const error = yield* Effect.flip(run);
      expect(error.reason).toBe("session-not-found");
      expect(error.providerInstanceId).toBe(instanceId);
    }),
  );

  it.effect("reports a fork Codex refuses as unreadable and keeps the cause", () =>
    Effect.gen(function* () {
      const message = "invalid paginated history lineage for source: missing source rollout";
      const { run } = importer(() => rpcError(message));
      const error = yield* Effect.flip(run);
      expect(error.reason).toBe("unreadable");
      expect(error.cause).toMatchObject({ message });
    }),
  );
});
