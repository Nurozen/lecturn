import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import {
  type CodexListedThread,
  listCodexExternalThreads,
  makeCodexExternalSessionsLister,
  selectCodexExternalSessions,
} from "./CodexExternalSessions.ts";

function thread(overrides: Partial<CodexListedThread> & { id: string }): CodexListedThread {
  return {
    preview: "Fix the flaky test",
    cwd: "/repo",
    createdAt: 1_750_000_000,
    updatedAt: 1_750_000_600,
    ephemeral: false,
    source: "vscode",
    originator: "Codex Desktop",
    ...overrides,
  };
}

const NONE: ReadonlySet<string> = new Set();

describe("selectCodexExternalSessions", () => {
  it("hides Lecturn's own threads but keeps desktop threads that share its source", () => {
    const sessions = selectCodexExternalSessions(
      [
        thread({ id: "desktop" }),
        thread({ id: "handoff", originator: "codex_work_desktop" }),
        thread({ id: "lecturn", originator: "lecturn_desktop" }),
        thread({ id: "resumed-by-lecturn" }),
      ],
      new Set(["resumed-by-lecturn"]),
    );
    expect(sessions.map((session) => session.sessionId)).toEqual(["desktop", "handoff"]);
  });

  it("drops ephemeral and subagent threads", () => {
    const sessions = selectCodexExternalSessions(
      [
        thread({ id: "ephemeral", ephemeral: true }),
        thread({ id: "child", parentThreadId: "parent" }),
        thread({ id: "review", source: { subAgent: "review" } }),
        thread({ id: "kept" }),
      ],
      NONE,
    );
    expect(sessions.map((session) => session.sessionId)).toEqual(["kept"]);
  });

  it("maps source and originator to an origin", () => {
    const sessions = selectCodexExternalSessions(
      [
        thread({ id: "tui", source: "cli", originator: "codex-tui" }),
        thread({ id: "exec", source: "exec", originator: "codex_exec" }),
        thread({ id: "desktop" }),
        thread({ id: "handoff", originator: "codex_work_desktop" }),
        thread({ id: "extension", originator: "codex_vscode" }),
        thread({ id: "custom", source: { custom: "sdk" }, originator: "my_sdk" }),
        thread({ id: "bare", source: "appServer", originator: null }),
        // Older Codex builds omit the originator: still listed, origin not guessed.
        thread({ id: "legacy", source: "vscode", originator: null }),
      ],
      NONE,
    );
    expect(
      Object.fromEntries(sessions.map((session) => [session.sessionId, session.origin])),
    ).toEqual({
      tui: "cli",
      exec: "cli",
      desktop: "desktop",
      handoff: "desktop",
      extension: "ide",
      custom: "unknown",
      bare: "unknown",
      legacy: "unknown",
    });
  });

  it("titles a thread by its name, falling back to the first line of the preview", () => {
    const [named, unnamed, singleLine] = selectCodexExternalSessions(
      [
        thread({ id: "named", name: "  Flaky test  ", preview: "Fix the flaky test" }),
        thread({ id: "unnamed", name: null, preview: "\n  First line  \nsecond line\n" }),
        thread({ id: "single", preview: "Only line" }),
      ],
      NONE,
    );
    expect(named).toMatchObject({ title: "Flaky test", firstPrompt: "Fix the flaky test" });
    expect(unnamed).toMatchObject({
      title: "First line",
      firstPrompt: "First line  \nsecond line",
    });
    expect(singleLine?.title).toBe("Only line");
    expect(singleLine).not.toHaveProperty("firstPrompt");
  });

  it("converts unix seconds and carries the git branch", () => {
    const [session] = selectCodexExternalSessions(
      [thread({ id: "branch", gitInfo: { branch: " main " } }), thread({ id: "no-branch" })],
      NONE,
    );
    expect(session).toMatchObject({
      cwd: "/repo",
      gitBranch: "main",
      createdAt: "2025-06-15T15:06:40.000Z",
      updatedAt: "2025-06-15T15:16:40.000Z",
    });
    expect(session).not.toHaveProperty("sizeBytes");
  });
});

describe("listCodexExternalThreads", () => {
  /** Serves `pages` in order and records every `thread/list` payload. */
  function fakeClient(pages: ReadonlyArray<{ data: unknown[]; nextCursor?: string | null }>) {
    const payloads: unknown[] = [];
    return {
      payloads,
      client: {
        raw: {
          request: (_method: string, payload?: unknown) => {
            const page = pages[payloads.length];
            payloads.push(payload);
            return page ? Effect.succeed<unknown>(page) : Effect.die("no more pages");
          },
        },
      },
    };
  }

  it.effect("pages past Lecturn's threads until the limit is filled", () =>
    Effect.gen(function* () {
      const { client, payloads } = fakeClient([
        {
          data: [thread({ id: "lecturn-1", originator: "lecturn_desktop" }), thread({ id: "a" })],
          nextCursor: "page-2",
        },
        { data: [thread({ id: "b" }), thread({ id: "c" })], nextCursor: "page-3" },
      ]);
      const result = yield* listCodexExternalThreads(client, {
        cwd: "/repo",
        searchTerm: "flaky",
        limit: 2,
        knownThreadIds: NONE,
      });
      expect(result.sessions.map((session) => session.sessionId)).toEqual(["a", "b"]);
      expect(result.truncated).toBe(true);
      expect(payloads).toEqual([
        {
          cwd: "/repo",
          searchTerm: "flaky",
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
        },
        {
          cwd: "/repo",
          searchTerm: "flaky",
          cursor: "page-2",
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
        },
      ]);
    }),
  );

  it.effect("is not truncated when Codex runs out at or under the limit", () =>
    Effect.gen(function* () {
      const { client } = fakeClient([{ data: [thread({ id: "a" }), thread({ id: "b" })] }]);
      const result = yield* listCodexExternalThreads(client, { limit: 2, knownThreadIds: NONE });
      expect(result.sessions).toHaveLength(2);
      expect(result.truncated).toBe(false);
    }),
  );

  const lecturnPage = (nextCursor?: string) => ({
    data: Array.from({ length: 100 }, (_, index) =>
      thread({ id: `lecturn-${index}`, originator: "lecturn_desktop" }),
    ),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });

  it.effect("reaches external threads buried under Lecturn's, whatever the limit", () =>
    Effect.gen(function* () {
      const { client, payloads } = fakeClient([
        lecturnPage("page-2"),
        lecturnPage("page-3"),
        lecturnPage("page-4"),
        { data: [thread({ id: "a" }), thread({ id: "b" })] },
      ]);
      const result = yield* listCodexExternalThreads(client, { limit: 1, knownThreadIds: NONE });
      expect(payloads).toHaveLength(4);
      expect(result.sessions.map((session) => session.sessionId)).toEqual(["a"]);
      expect(result.truncated).toBe(true);
    }),
  );

  it.effect("stops at the scan cap and reports truncation with a cursor remaining", () =>
    Effect.gen(function* () {
      const { client, payloads } = fakeClient(
        Array.from({ length: 11 }, () => lecturnPage("more")),
      );
      const result = yield* listCodexExternalThreads(client, { limit: 10, knownThreadIds: NONE });
      expect(payloads).toHaveLength(10);
      expect(result).toEqual({ sessions: [], truncated: true });
    }),
  );

  it.effect("hides threads named by Codex cursors and skips other providers' cursors", () =>
    Effect.gen(function* () {
      const { client } = fakeClient([{ data: [thread({ id: "owned" }), thread({ id: "kept" })] }]);
      const result = yield* makeCodexExternalSessionsLister({
        instanceId: ProviderInstanceId.make("codex"),
        openClient: Effect.succeed(client),
      })({
        limit: 10,
        knownResumeCursors: [
          { threadId: "owned" },
          { resume: "5f0c1d0e-6f0b-4f7e-9a3e-2b1c4d5e6f70", turnCount: 2 },
          null,
          "not-a-cursor",
        ],
      });
      expect(result.sessions.map((session) => session.sessionId)).toEqual(["kept"]);
    }),
  );

  it.effect("fails when a row does not decode", () =>
    Effect.gen(function* () {
      const { client } = fakeClient([{ data: [{ id: "missing-fields" }] }]);
      const exit = yield* Effect.exit(
        listCodexExternalThreads(client, { limit: 10, knownThreadIds: NONE }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});
