// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderInstanceId } from "@lecturn/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { readClaudeResumeState } from "../Layers/ClaudeAdapter.ts";
import {
  convertClaudeSessionMessages,
  makeClaudeExternalSessionImporter,
} from "./ClaudeExternalSessionImport.ts";

const INSTANCE = ProviderInstanceId.make("claude");
const FALLBACK_MS = Date.UTC(2026, 0, 1);
const SECRET = "sk-synthetic-SECRET-0123456789";

let second = 0;
/** Each message is stamped one second after the previous one built. */
function message(
  type: SessionMessage["type"],
  content: unknown,
  overrides: Partial<SessionMessage> & { readonly model?: string; readonly timestamp?: null } = {},
): SessionMessage {
  const { model, timestamp, ...rest } = overrides;
  second += 1;
  return {
    type,
    uuid: NodeCrypto.randomUUID(),
    session_id: "synthetic",
    message: { role: type, content, ...(model ? { model } : {}) },
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...(timestamp === null
      ? {}
      : { timestamp: DateTime.formatIso(DateTime.makeUnsafe(FALLBACK_MS + second * 1_000)) }),
    ...rest,
  };
}

describe("convertClaudeSessionMessages", () => {
  it("keeps prompts, replies and one summary activity per tool call, in order", () => {
    const entries = convertClaudeSessionMessages(
      [
        message("user", "Fix the build"),
        message("assistant", [
          { type: "thinking", thinking: `pondering ${SECRET}` },
          { type: "text", text: "Looking." },
          { type: "text", text: "Found it." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "  vp   test\n run " },
          },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Write",
            input: { file_path: "/synthetic/a.ts", content: SECRET },
          },
        ]),
        message("user", [{ type: "tool_result", tool_use_id: "toolu_1", content: SECRET }]),
        message("assistant", [{ type: "thinking", thinking: SECRET }]),
        message("assistant", [
          {
            type: "tool_use",
            id: "toolu_3",
            name: "Agent",
            input: { description: "Audit the tests", prompt: SECRET },
          },
          { type: "tool_use", id: "toolu_4", name: "mcp__vault__read", input: { token: SECRET } },
        ]),
        message("assistant", [{ type: "text", text: "subagent chatter" }], {
          parent_tool_use_id: "toolu_3",
        }),
        message("system", "compact boundary"),
        message("assistant", [{ type: "text", text: "Done." }]),
      ],
      FALLBACK_MS,
    );

    assert.deepStrictEqual(
      entries.map((entry) =>
        entry.kind === "message"
          ? `${entry.role}: ${entry.text}`
          : `${entry.tone}/${entry.activityKind}/${entry.itemType}: ${entry.summary} | ${entry.detail}`,
      ),
      [
        "user: Fix the build",
        "assistant: Looking.\n\nFound it.",
        "tool/tool.completed/command_execution: Command run | Bash: vp test run",
        "tool/tool.completed/file_change: File change | Write: /synthetic/a.ts",
        "tool/tool.completed/collab_agent_tool_call: Subagent task | Agent: Audit the tests",
        "tool/tool.completed/mcp_tool_call: MCP tool call | mcp__vault__read",
        "assistant: Done.",
      ],
    );
    assert.notInclude(JSON.stringify(entries), SECRET);
    const times = entries.map((entry) => Date.parse(entry.createdAt));
    assert.deepStrictEqual(times, times.toSorted());
  });

  it("renders attachments as placeholders and drops lines the user never typed", () => {
    const entries = convertClaudeSessionMessages(
      [
        message("user", "<command-name>/clear</command-name>"),
        message("user", "<local-command-stdout>ok</local-command-stdout>"),
        message("user", [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
        message("user", "This session is being continued from a previous conversation that ran"),
        message("user", "<ide_opened_file>The user opened /synthetic/a.ts</ide_opened_file>"),
        message("user", [
          { type: "text", text: "<ide_selection>lines 1 to 3 of a.ts</ide_selection>" },
        ]),
        message("assistant", [{ type: "text", text: "No response requested." }], {
          model: "<synthetic>",
        }),
        message("user", [
          { type: "text", text: "<system-reminder>injected</system-reminder>" },
          { type: "text", text: "What is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: SECRET } },
          { type: "document", source: { type: "base64", data: SECRET } },
        ]),
        message("user", "<div>pasted markup is still a prompt</div>"),
      ],
      FALLBACK_MS,
    );

    assert.deepStrictEqual(
      entries.map((entry) => (entry.kind === "message" ? entry.text : entry.summary)),
      ["What is this?\n\n[image]\n\n[attachment]", "<div>pasted markup is still a prompt</div>"],
    );
    assert.notInclude(JSON.stringify(entries), SECRET);
  });

  it("orders messages without timestamps after the last known time", () => {
    const entries = convertClaudeSessionMessages(
      [
        message("user", "one", { timestamp: null }),
        message("assistant", "two"),
        message("user", "three", { timestamp: null }),
      ],
      FALLBACK_MS,
    );
    const times = entries.map((entry) => Date.parse(entry.createdAt));
    assert.strictEqual(entries.length, 3);
    assert.isBelow(times[0]!, FALLBACK_MS);
    assert.strictEqual(times[2], times[1]! + 1);
  });
});

const makeHome = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-claude-import-"))),
  (home) => Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
);

describe("makeClaudeExternalSessionImporter", () => {
  it.effect("forks the whole session and returns a cursor the adapter resumes from", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const sourceId = NodeCrypto.randomUUID();
      const forkId = NodeCrypto.randomUUID();
      const forkInputs: Array<unknown> = [];
      const steps: Array<string> = [];
      const imported = yield* makeClaudeExternalSessionImporter({
        instanceId: INSTANCE,
        configDir: home,
        forkSession: async (input) => {
          forkInputs.push(input);
          steps.push("fork");
          return { sessionId: forkId };
        },
        getSessionInfo: async (sessionId) =>
          sessionId === sourceId
            ? { sessionId, summary: " Summary ", lastModified: 0, cwd: "/synthetic/source" }
            : undefined,
        getSessionMessages: async (sessionId) => {
          steps.push(sessionId === sourceId ? "read-source" : "read-fork");
          return sessionId === forkId
            ? [message("user", "hello"), message("assistant", "hi")]
            : [message("user", "the source's own lines are only checked")];
        },
      })({ sessionId: sourceId, cwd: "/synthetic/thread" });
      assert.deepStrictEqual(steps, ["read-source", "fork", "read-fork"]);

      // Neither an anchor nor the thread cwd: the SDK rejects a foreign `dir`.
      assert.deepStrictEqual(forkInputs, [
        { sourceSessionId: sourceId, environment: { CLAUDE_CONFIG_DIR: home } },
      ]);
      assert.deepStrictEqual(readClaudeResumeState(imported.resumeCursor), {
        resume: forkId,
        turnCount: 0,
      });
      assert.strictEqual(imported.title, "Summary");
      assert.strictEqual(imported.cwd, "/synthetic/source");
      assert.deepStrictEqual(
        imported.transcript.map((entry) => entry.kind === "message" && entry.text),
        ["hello", "hi"],
      );
    }),
  );

  it.effect("reports a session with nothing to show as empty before forking it", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      let forks = 0;
      const error = yield* makeClaudeExternalSessionImporter({
        instanceId: INSTANCE,
        configDir: home,
        forkSession: async () => {
          forks += 1;
          return { sessionId: NodeCrypto.randomUUID() };
        },
        getSessionInfo: async () => undefined,
        getSessionMessages: async () => [
          message("user", "<command-name>/clear</command-name>"),
          message("assistant", [{ type: "thinking", thinking: "nothing said" }]),
        ],
      })({ sessionId: NodeCrypto.randomUUID(), cwd: "/synthetic/thread" }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "empty-session");
      assert.strictEqual(forks, 0);
    }),
  );

  it.effect("titles an unsummarized session by its first prompt", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const imported = yield* makeClaudeExternalSessionImporter({
        instanceId: INSTANCE,
        configDir: home,
        forkSession: async () => ({ sessionId: NodeCrypto.randomUUID() }),
        getSessionInfo: async () => undefined,
        getSessionMessages: async () => [
          message("user", "<command-name>/init</command-name>"),
          message("user", "First\n  real prompt"),
        ],
      })({ sessionId: NodeCrypto.randomUUID(), cwd: "/synthetic/thread" });
      assert.strictEqual(imported.title, "First real prompt");
      assert.strictEqual(imported.cwd, "/synthetic/thread");
    }),
  );

  it.effect("reports a session missing from the home as session-not-found", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(home, "projects", "-synthetic"), { recursive: true }),
      );
      const sessionId = NodeCrypto.randomUUID();
      // The real fork, against an empty temp home.
      const error = yield* makeClaudeExternalSessionImporter({
        instanceId: INSTANCE,
        configDir: home,
        getSessionInfo: async () => undefined,
        getSessionMessages: async () => [],
      })({ sessionId, cwd: "/synthetic/thread" }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "session-not-found");
      assert.strictEqual(error.sessionId, sessionId);
      assert.strictEqual(error.providerInstanceId, INSTANCE);
    }),
  );

  it.effect("reports SDK failures as unreadable with their cause", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const cause = new Error("synthetic read failure");
      const error = yield* makeClaudeExternalSessionImporter({
        instanceId: INSTANCE,
        configDir: home,
        forkSession: async () => ({ sessionId: NodeCrypto.randomUUID() }),
        getSessionInfo: async () => undefined,
        getSessionMessages: async () => {
          throw cause;
        },
      })({ sessionId: NodeCrypto.randomUUID(), cwd: "/synthetic/thread" }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "unreadable");
      assert.strictEqual(error.cause, cause);
    }),
  );
});
