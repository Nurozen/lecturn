import {
  type ExternalSessionSummary,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  bulkImportSummary,
  continueSessionLinkLabel,
  defaultImportSelection,
  externalSessionKey,
  groupExternalSessionsByFolder,
  importFolderSourceLabel,
  importSessionsSequentially,
  latestImported,
  sessionsInFolder,
} from "./externalSessionImport.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");
const CURSOR = ProviderDriverKind.make("cursor");

function session(input: {
  readonly id: string;
  readonly cwd: string;
  readonly updatedAt: string;
  readonly driverKind?: ProviderDriverKind;
}): ExternalSessionSummary {
  const driverKind = input.driverKind ?? CLAUDE;
  return {
    providerInstanceId: ProviderInstanceId.make(driverKind),
    driverKind,
    sessionId: input.id,
    title: input.id,
    cwd: input.cwd,
    updatedAt: input.updatedAt,
  };
}

describe("entry labels", () => {
  it("names the import-capable tools", () => {
    expect(continueSessionLinkLabel([CODEX, CLAUDE])).toBe(
      "Continue a Claude Code or Codex session",
    );
    expect(continueSessionLinkLabel([CODEX])).toBe("Continue a Codex session");
    expect(importFolderSourceLabel([CLAUDE, CURSOR])).toBe("From Claude Code");
    expect(importFolderSourceLabel([CLAUDE, CODEX])).toBe("From Claude Code or Codex");
  });

  it("falls back to a generic name for tools it does not know", () => {
    expect(continueSessionLinkLabel([CURSOR])).toBe("Continue an agent session");
    expect(importFolderSourceLabel([])).toBe("From agent sessions");
  });
});

describe("groupExternalSessionsByFolder", () => {
  it("groups by cwd, newest activity first, with per-provider counts", () => {
    const folders = groupExternalSessionsByFolder({
      sessions: [
        session({ id: "a", cwd: "/work/api", updatedAt: "2026-01-01T00:00:00.000Z" }),
        session({ id: "b", cwd: "/work/web", updatedAt: "2026-01-03T00:00:00.000Z" }),
        session({
          id: "c",
          cwd: "/work/api/",
          updatedAt: "2026-01-02T00:00:00.000Z",
          driverKind: CODEX,
        }),
        session({
          id: "d",
          cwd: "/work/api",
          updatedAt: "2025-12-01T00:00:00.000Z",
          driverKind: CODEX,
        }),
        session({ id: "e", cwd: "/work/api", updatedAt: "2025-12-02T00:00:00.000Z" }),
        session({ id: "f", cwd: "/work/api", updatedAt: "2025-12-03T00:00:00.000Z" }),
      ],
      projects: [{ id: "p1", workspaceRoot: "/work/web/" }],
    });

    expect(folders.map((folder) => folder.cwd)).toEqual(["/work/web", "/work/api/"]);
    expect(folders[0]).toMatchObject({
      name: "web",
      sessionCount: 1,
      latestUpdatedAt: "2026-01-03T00:00:00.000Z",
      project: { id: "p1" },
    });
    expect(folders[1]).toMatchObject({ name: "api", sessionCount: 5, project: null });
    expect(folders[1]?.providerCounts).toEqual([
      { providerInstanceId: "claudeAgent", driverKind: CLAUDE, count: 3 },
      { providerInstanceId: "codex", driverKind: CODEX, count: 2 },
    ]);
  });

  it("keeps a git worktree apart from its main checkout", () => {
    const folders = groupExternalSessionsByFolder({
      sessions: [
        session({ id: "a", cwd: "/work/api", updatedAt: "2026-01-01T00:00:00.000Z" }),
        session({
          id: "b",
          cwd: "/work/api/.worktrees/feature",
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
      ],
      projects: [],
    });
    expect(folders.map((folder) => folder.name)).toEqual(["feature", "api"]);
  });
});

describe("sessionsInFolder", () => {
  it("keeps only sessions that ran exactly in the folder, newest first", () => {
    const sessions = [
      session({ id: "old", cwd: "/work/api", updatedAt: "2026-01-01T00:00:00.000Z" }),
      session({ id: "tree", cwd: "/work/api/.wt/x", updatedAt: "2026-01-05T00:00:00.000Z" }),
      session({ id: "new", cwd: "/work/api/", updatedAt: "2026-01-03T00:00:00.000Z" }),
    ];
    expect(sessionsInFolder(sessions, "/work/api").map((entry) => entry.sessionId)).toEqual([
      "new",
      "old",
    ]);
  });
});

describe("defaultImportSelection", () => {
  const now = Date.parse("2026-02-01T00:00:00.000Z");

  it("preselects recent sessions that are not imported yet", () => {
    const recent = session({ id: "recent", cwd: "/w", updatedAt: "2026-01-25T00:00:00.000Z" });
    const edge = session({ id: "edge", cwd: "/w", updatedAt: "2026-01-18T00:00:00.000Z" });
    const stale = session({ id: "stale", cwd: "/w", updatedAt: "2026-01-17T23:59:59.000Z" });
    const imported = session({ id: "imported", cwd: "/w", updatedAt: "2026-01-31T00:00:00.000Z" });

    const selection = defaultImportSelection({
      sessions: [recent, edge, stale, imported],
      importedSessionIds: new Set(["imported"]),
      now,
    });

    expect([...selection]).toEqual([externalSessionKey(recent), externalSessionKey(edge)]);
  });
});

describe("importSessionsSequentially", () => {
  it("imports in order, one at a time, and continues past failures", async () => {
    const order: string[] = [];
    const progress: string[] = [];
    let inFlight = 0;
    const result = await importSessionsSequentially({
      sessions: ["a", "b", "c", "d"],
      importSession: async (id) => {
        inFlight += 1;
        expect(inFlight).toBe(1);
        order.push(id);
        await Promise.resolve();
        inFlight -= 1;
        if (id === "b") return { ok: false, message: "unreadable" };
        if (id === "c") throw new Error("socket closed");
        return { ok: true, value: `thread-${id}` };
      },
      onProgress: ({ position, total }) => progress.push(`${position}/${total}`),
    });

    expect(order).toEqual(["a", "b", "c", "d"]);
    expect(progress).toEqual(["1/4", "2/4", "3/4", "4/4"]);
    expect(result.imported).toEqual([
      { session: "a", value: "thread-a" },
      { session: "d", value: "thread-d" },
    ]);
    expect(result.failed).toEqual([
      { session: "b", message: "unreadable" },
      { session: "c", message: "socket closed" },
    ]);
  });
});

describe("bulkImportSummary", () => {
  it("reads the outcome", () => {
    expect(bulkImportSummary({ imported: [1, 2], failed: [] })).toEqual({
      title: "Imported 2 sessions",
      description: null,
    });
    expect(bulkImportSummary({ imported: [1], failed: [2, 3] })).toEqual({
      title: "Imported 1 of 3 sessions",
      description: "2 sessions could not be imported.",
    });
    expect(bulkImportSummary({ imported: [], failed: [1] })).toEqual({
      title: "Could not import sessions",
      description: "1 session could not be imported.",
    });
  });
});

describe("latestImported", () => {
  it("picks the thread whose session saw the latest activity", () => {
    expect(
      latestImported([
        {
          session: session({ id: "a", cwd: "/w", updatedAt: "2026-01-01T00:00:00.000Z" }),
          value: "thread-a",
        },
        {
          session: session({ id: "b", cwd: "/w", updatedAt: "2026-01-09T00:00:00.000Z" }),
          value: "thread-b",
        },
      ]),
    ).toBe("thread-b");
    expect(latestImported([])).toBeNull();
  });
});
