import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  isImportedHistoryMessage,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ImportedTranscriptEntry, ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import {
  buildImportedThreadHistoryV2,
  ExternalSessionImporterV2,
  IMPORT_HISTORY_MAX_ACTIVITIES,
  IMPORT_HISTORY_MAX_MESSAGES,
  IMPORT_MESSAGE_TEXT_MAX_LENGTH,
  IMPORT_MESSAGE_TRUNCATION_SUFFIX,
  layerFromProviderInstanceRegistry,
  planThreadImport,
  type ThreadImportCommand,
} from "./ThreadImport.ts";

const threadId = ThreadId.make("thread:imported");
const importedAtIso = "2026-05-02T00:00:00.000Z";
const importedAt = DateTime.makeUnsafe(importedAtIso);
const t = (minute: number, second = 0) =>
  `2026-05-01T00:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

const message = (
  role: "user" | "assistant",
  text: string,
  createdAt: string,
): ImportedTranscriptEntry => ({ kind: "message", role, text, createdAt });

const activity = (summary: string, createdAt: string): ImportedTranscriptEntry => ({
  kind: "activity",
  tone: "tool",
  activityKind: "tool.completed",
  summary,
  itemType: "command_execution",
  detail: "bun test",
  createdAt,
});

const build = (transcript: ReadonlyArray<ImportedTranscriptEntry>, at = importedAt) =>
  buildImportedThreadHistoryV2({ threadId, transcript, importedAt: at });

const iso = (value: DateTime.Utc) => DateTime.formatIso(value);

describe("buildImportedThreadHistoryV2", () => {
  it("copies messages and activities as run-less history with deterministic ids", () => {
    const history = build([
      message("user", "fix the bug", t(1)),
      activity("Ran command", t(2)),
      message("assistant", "fixed", t(3)),
    ]);
    assert.isFalse(history.historyTruncated);
    assert.deepEqual(
      history.messages.map((row) => [row.role, row.text, row.runId, iso(row.createdAt)]),
      [
        ["user", "fix the bug", null, t(1)],
        ["assistant", "fixed", null, t(3)],
      ],
    );
    assert.deepEqual(
      history.turnItems.map((item) => [item.type, item.runId, item.ordinal]),
      [
        ["user_message", null, 1],
        ["command_execution", null, 2],
        ["assistant_message", null, 3],
      ],
    );
    const command = history.turnItems[1];
    assert.equal(command?.type === "command_execution" ? command.input : undefined, "bun test");
    assert.equal(command?.title, "Ran command");
    // Replaying the plan yields the same ids.
    assert.deepEqual(
      build([
        message("user", "fix the bug", t(1)),
        activity("Ran command", t(2)),
        message("assistant", "fixed", t(3)),
      ]).messages.map((row) => row.id),
      history.messages.map((row) => row.id),
    );
    // Every imported message counts as imported history for its thread.
    const thread = {
      importedFrom: {
        providerInstanceId: ProviderInstanceId.make("claude"),
        driverKind: ProviderDriverKind.make("claudeAgent"),
        sessionId: "session-1",
        cwd: "/repo",
        title: "Session",
        importedAt: importedAtIso,
        historyTruncated: false,
      },
    };
    assert.isTrue(history.messages.every((row) => isImportedHistoryMessage(thread, row)));
  });

  it("keeps the last messages and only the activities inside their window", () => {
    const transcript: ImportedTranscriptEntry[] = [];
    const total = IMPORT_HISTORY_MAX_MESSAGES + 3;
    for (let index = 0; index < total; index += 1) {
      const at = DateTime.formatIso(DateTime.makeUnsafe(Date.parse(t(0)) + index * 60_000));
      transcript.push(message(index % 2 === 0 ? "user" : "assistant", `message ${index}`, at));
      transcript.push(activity(`work ${index}`, at));
    }
    const history = build(transcript, DateTime.makeUnsafe("2027-01-01T00:00:00.000Z"));
    assert.isTrue(history.historyTruncated);
    assert.equal(history.messages.length, IMPORT_HISTORY_MAX_MESSAGES);
    assert.equal(history.messages[0]?.text, "message 3");
    assert.equal(history.messages.at(-1)?.text, `message ${total - 1}`);
    const tools = history.turnItems.filter((item) => item.type === "command_execution");
    assert.equal(tools.length, IMPORT_HISTORY_MAX_MESSAGES);
    assert.equal(tools[0]?.title, "work 3");
  });

  it("caps the activity count to the latest rows", () => {
    const transcript: ImportedTranscriptEntry[] = [message("user", "go", t(0))];
    for (let index = 0; index < IMPORT_HISTORY_MAX_ACTIVITIES + 2; index += 1) {
      transcript.push(activity(`work ${index}`, t(1)));
    }
    const history = build(transcript);
    assert.isTrue(history.historyTruncated);
    assert.equal(history.messages.length, 1);
    const tools = history.turnItems.filter((item) => item.type === "command_execution");
    assert.equal(tools.length, IMPORT_HISTORY_MAX_ACTIVITIES);
    assert.equal(tools[0]?.title, "work 2");
  });

  it("caps long message text with a visible suffix", () => {
    const history = build([
      message("user", "x".repeat(IMPORT_MESSAGE_TEXT_MAX_LENGTH + 50), t(1)),
      message("assistant", "short", t(2)),
    ]);
    assert.isTrue(history.historyTruncated);
    const capped = history.messages[0]?.text ?? "";
    assert.equal(capped.length, IMPORT_MESSAGE_TEXT_MAX_LENGTH);
    assert.isTrue(capped.endsWith(IMPORT_MESSAGE_TRUNCATION_SUFFIX));
    assert.equal(history.messages[1]?.text, "short");
  });

  it("clamps timestamps to the import time and keeps transcript order under ties", () => {
    const history = build(
      [
        message("user", "first", t(5)),
        activity("tied work", t(6)),
        message("assistant", "tied answer", t(6)),
        message("user", "tied follow-up", t(6)),
        // Later than the import itself (clock skew between provider and server).
        message("assistant", "from the future", t(30)),
      ],
      DateTime.makeUnsafe(t(10)),
    );
    const stamps = history.turnItems.map((item) => DateTime.toEpochMillis(item.updatedAt));
    assert.deepEqual(
      stamps,
      stamps.toSorted((left, right) => left - right),
    );
    assert.equal(new Set(stamps).size, stamps.length);
    assert.equal(iso(history.turnItems.at(-1)!.updatedAt), t(10));
    assert.equal(iso(history.turnItems[0]!.updatedAt), t(5));
  });

  it("drops activities that cannot form a valid row and maps tool kinds", () => {
    const history = build([
      message("user", "go", t(1)),
      {
        kind: "activity",
        tone: "info",
        activityKind: "tool.completed",
        summary: "  ",
        createdAt: t(2),
      },
      {
        kind: "activity",
        tone: "tool",
        activityKind: "tool.completed",
        summary: "Edited file",
        itemType: "file_change",
        detail: "src/a.ts",
        createdAt: t(3),
      },
      {
        kind: "activity",
        tone: "error",
        activityKind: "tool.completed",
        summary: "Called MCP",
        itemType: "mcp_tool_call",
        createdAt: t(4),
      },
    ]);
    assert.deepEqual(
      history.turnItems.map((item) => [item.type, item.status]),
      [
        ["user_message", "completed"],
        ["file_change", "completed"],
        ["dynamic_tool", "failed"],
      ],
    );
  });
});

const instanceId = ProviderInstanceId.make("claude");
const modelSelection: ModelSelection = { instanceId, model: "claude-sonnet-4-6" };
const command: ThreadImportCommand = {
  type: "thread.import",
  createdBy: "user",
  creationSource: "web",
  commandId: CommandId.make("cmd-import"),
  threadId,
  projectId: ProjectId.make("project-1"),
  providerInstanceId: instanceId,
  sessionId: "external-session",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
};

describe("planThreadImport", () => {
  it("creates the thread, binds the native fork and records the import origin", () => {
    const plan = planThreadImport({
      command,
      imported: {
        nativeThreadId: "forked-session",
        driverKind: ProviderDriverKind.make("claudeAgent"),
        title: "Session title",
        threadTitle: "Session title",
        cwd: "/elsewhere",
        transcript: [message("user", "hi", t(1)), message("assistant", "hello", t(2))],
      },
      providerThreadId: ProviderThreadId.make("provider-thread:fork"),
      now: importedAt,
    });
    assert.equal(plan.createdThread.importedFrom, undefined);
    assert.equal(plan.createdThread.title, "Session title");
    assert.deepEqual(plan.importedThread.importedFrom, {
      providerInstanceId: instanceId,
      driverKind: ProviderDriverKind.make("claudeAgent"),
      sessionId: "external-session",
      cwd: "/elsewhere",
      title: "Session title",
      importedAt: importedAtIso,
      historyTruncated: false,
    });
    assert.deepEqual(plan.providerThread.nativeThreadRef, {
      driver: ProviderDriverKind.make("claudeAgent"),
      nativeId: "forked-session",
      strength: "strong",
    });
    assert.equal(plan.providerThread.status, "not_loaded");
    assert.equal(plan.providerThread.firstRunOrdinal, null);
    assert.equal(plan.history.messages.length, 2);
    // An explicit title wins over the session's.
    assert.equal(
      planThreadImport({
        command: { ...command, title: "Mine" },
        imported: {
          nativeThreadId: "forked-session",
          driverKind: ProviderDriverKind.make("claudeAgent"),
          title: "Session title",
          threadTitle: "Session title",
          cwd: "/elsewhere",
          transcript: [message("user", "hi", t(1))],
        },
        providerThreadId: ProviderThreadId.make("provider-thread:fork"),
        now: importedAt,
      }).createdThread.title,
      "Mine",
    );
  });
});

const registryLayer = (instance: Partial<ProviderInstance> | undefined) =>
  Layer.succeed(ProviderInstanceRegistry, {
    getInstance: () => Effect.succeed(instance as ProviderInstance | undefined),
  } as unknown as ProviderInstanceRegistry["Service"]);

describe("ExternalSessionImporterV2", () => {
  it.effect("rejects unknown, disabled and unsupported instances before forking", () =>
    Effect.gen(function* () {
      const attempt = (instance: Partial<ProviderInstance> | undefined) =>
        Effect.gen(function* () {
          const importer = yield* ExternalSessionImporterV2;
          return yield* Effect.flip(
            importer.importSession({
              providerInstanceId: instanceId,
              sessionId: "s",
              cwd: "/repo",
            }),
          );
        }).pipe(
          Effect.provide(
            layerFromProviderInstanceRegistry.pipe(Layer.provide(registryLayer(instance))),
          ),
        );
      assert.equal((yield* attempt(undefined)).reason, "provider-unavailable");
      assert.equal((yield* attempt({ enabled: false })).reason, "provider-unavailable");
      assert.equal((yield* attempt({ enabled: true })).reason, "provider-unsupported");
    }),
  );

  it.effect("forks through the driver and caps titles", () =>
    Effect.gen(function* () {
      const importer = yield* ExternalSessionImporterV2;
      const imported = yield* importer.importSession({
        providerInstanceId: instanceId,
        sessionId: "s",
        cwd: "/repo",
      });
      assert.equal(imported.nativeThreadId, "fork-id");
      assert.equal(imported.driverKind, "claudeAgent");
      assert.equal(imported.title.length, 200);
      assert.isTrue(imported.title.endsWith("…"));
      assert.equal(imported.threadTitle, imported.title);
    }).pipe(
      Effect.provide(
        layerFromProviderInstanceRegistry.pipe(
          Layer.provide(
            registryLayer({
              instanceId,
              enabled: true,
              driverKind: ProviderDriverKind.make("claudeAgent"),
              importExternalSession: () =>
                Effect.succeed({
                  nativeThreadId: " fork-id ",
                  title: "t".repeat(300),
                  cwd: "/repo",
                  transcript: [],
                }),
            }),
          ),
        ),
      ),
    ),
  );
});
