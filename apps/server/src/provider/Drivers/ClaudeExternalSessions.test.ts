// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { ProviderInstanceId } from "@lecturn/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  claudeExternalSessionsConfigDir,
  makeClaudeExternalSessionsLister,
} from "./ClaudeExternalSessions.ts";

const INSTANCE = ProviderInstanceId.make("claude");
const DAY_MS = 86_400_000;
const BASE_MS = Date.UTC(2026, 0, 1);

const makeHome = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-claude-ext-"))),
  (home) => Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
);

/** `day` orders sessions: a higher day is more recently modified. */
function session(day: number, overrides: Partial<SDKSessionInfo> = {}): SDKSessionInfo {
  return {
    sessionId: NodeCrypto.randomUUID(),
    summary: `Session ${day}`,
    lastModified: BASE_MS + day * DAY_MS,
    cwd: "/synthetic/workspace",
    ...overrides,
  };
}

function writeTranscript(home: string, sessionId: string, lines: ReadonlyArray<object>) {
  const directory = NodePath.join(home, "projects", "-synthetic-workspace");
  return Effect.promise(async () => {
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(directory, `${sessionId}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
  });
}

function list(
  home: string,
  listed: ReadonlyArray<SDKSessionInfo>,
  input: {
    readonly searchTerm?: string;
    readonly limit?: number;
    readonly knownResumeCursors?: ReadonlyArray<unknown>;
  } = {},
) {
  return makeClaudeExternalSessionsLister({
    instanceId: INSTANCE,
    configDir: home,
    listSessions: async () => [...listed],
  })({
    searchTerm: input.searchTerm,
    limit: input.limit ?? 50,
    knownResumeCursors: input.knownResumeCursors ?? [],
  });
}

describe("makeClaudeExternalSessionsLister", () => {
  it.effect("hides sessions Lecturn already resumes", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const owned = session(2);
      const legacyOwned = session(1);
      const external = session(0);
      const result = yield* list(home, [owned, legacyOwned, external], {
        knownResumeCursors: [
          { resume: owned.sessionId },
          { sessionId: legacyOwned.sessionId },
          // Another provider's cursor, even one naming this id, is not a Claude cursor.
          { threadId: external.sessionId },
          null,
          "not-a-cursor",
        ],
      });
      assert.deepStrictEqual(
        result.sessions.map((entry) => entry.sessionId),
        [external.sessionId],
      );
    }),
  );

  it.effect("searches title, first prompt, cwd and branch case-insensitively", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const byTitle = session(4, { customTitle: "Fix NEEDLE parser" });
      const byPrompt = session(3, { firstPrompt: "please find the Needle" });
      const byCwd = session(2, { cwd: "/synthetic/needle-repo" });
      const byBranch = session(1, { gitBranch: "feat/NeEdLe" });
      const miss = session(0, { firstPrompt: "unrelated" });
      const result = yield* list(home, [miss, byBranch, byCwd, byPrompt, byTitle], {
        searchTerm: "nEEdle",
      });
      assert.deepStrictEqual(
        result.sessions.map((entry) => entry.sessionId),
        [byTitle.sessionId, byPrompt.sessionId, byCwd.sessionId, byBranch.sessionId],
      );
      assert.isFalse(result.truncated);
    }),
  );

  it.effect("returns the newest matches up to the limit and reports truncation", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const sessions = [1, 4, 0, 3, 2].map((day) => session(day));
      const truncated = yield* list(home, sessions, { limit: 2 });
      assert.deepStrictEqual(
        truncated.sessions.map((entry) => entry.title),
        ["Session 4", "Session 3"],
      );
      assert.isTrue(truncated.truncated);

      const searched = yield* list(home, sessions, { limit: 2, searchTerm: "session 1" });
      assert.deepStrictEqual(
        searched.sessions.map((entry) => entry.title),
        ["Session 1"],
      );
      assert.isFalse(searched.truncated);
    }),
  );

  it.effect("maps SDK fields onto the listing and drops rows without a cwd", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const full = session(1, {
        customTitle: "Renamed",
        firstPrompt: "first prompt",
        gitBranch: "main",
        createdAt: BASE_MS,
        fileSize: 1234,
      });
      const { cwd: _cwd, ...withoutCwd } = session(2);
      const result = yield* list(home, [withoutCwd, session(3, { cwd: "  " }), full]);
      assert.deepStrictEqual(result.sessions, [
        {
          sessionId: full.sessionId,
          title: "Renamed",
          firstPrompt: "first prompt",
          cwd: "/synthetic/workspace",
          gitBranch: "main",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          sizeBytes: 1234,
          origin: "unknown",
        },
      ]);
    }),
  );

  it.effect("reads the origin from the first entrypoint in the transcript prefix", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const cli = session(5);
      const desktop = session(4);
      const late = session(3);
      const programmatic = session(2);
      const beyondPrefix = session(1);
      const missingFile = session(0);
      const user = (entrypoint: string) => ({ type: "user", entrypoint, cwd: "/synthetic" });
      yield* writeTranscript(home, cli.sessionId, [user("cli")]);
      yield* writeTranscript(home, desktop.sessionId, [user("claude-desktop")]);
      yield* writeTranscript(home, late.sessionId, [
        { type: "summary", summary: "metadata" },
        { type: "file-history-snapshot", snapshot: {} },
        { type: "queue-operation", operation: "enqueue" },
        user("claude-desktop"),
        user("cli"),
      ]);
      yield* writeTranscript(home, programmatic.sessionId, [user("sdk-py")]);
      yield* writeTranscript(home, beyondPrefix.sessionId, [
        { type: "summary", summary: "x".repeat(20 * 1024) },
        user("cli"),
      ]);

      const result = yield* list(home, [
        cli,
        desktop,
        late,
        programmatic,
        beyondPrefix,
        missingFile,
      ]);
      assert.deepStrictEqual(
        result.sessions.map((entry) => entry.origin),
        ["cli", "desktop", "desktop", "unknown", "unknown", "unknown"],
      );
    }),
  );

  it.effect("lists without origins when the home has no projects directory", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      assert.deepStrictEqual(yield* list(home, []), { sessions: [], truncated: false });
      const result = yield* list(home, [session(0)]);
      assert.deepStrictEqual(
        result.sessions.map((entry) => entry.origin),
        ["unknown"],
      );
    }),
  );

  it.effect("fails as unreadable when the SDK cannot list", () =>
    Effect.gen(function* () {
      const cause = new Error("EACCES");
      const error = yield* makeClaudeExternalSessionsLister({
        instanceId: INSTANCE,
        configDir: "/synthetic/home",
        listSessions: async () => {
          throw cause;
        },
      })({ cwd: "/synthetic/workspace", limit: 10, knownResumeCursors: [] }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "unreadable");
      assert.strictEqual(error.providerInstanceId, INSTANCE);
      assert.strictEqual(error.cwd, "/synthetic/workspace");
      assert.strictEqual(error.cause, cause);
    }),
  );
});

describe("claudeExternalSessionsConfigDir", () => {
  const server = { HOME: "/synthetic/home" };

  it("is the server's Claude home when the instance shares it", () => {
    assert.strictEqual(
      claudeExternalSessionsConfigDir({ ...server }, server),
      "/synthetic/home/.claude",
    );
    assert.strictEqual(
      claudeExternalSessionsConfigDir(
        { ...server, CLAUDE_CONFIG_DIR: "/synthetic/home/.claude/" },
        server,
      ),
      "/synthetic/home/.claude",
    );
  });

  it("is undefined for an instance running against a custom home", () => {
    assert.isUndefined(
      claudeExternalSessionsConfigDir({ ...server, CLAUDE_CONFIG_DIR: "/synthetic/work" }, server),
    );
  });
});
