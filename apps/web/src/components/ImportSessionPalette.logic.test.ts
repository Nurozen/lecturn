import {
  type ExternalSessionSummary,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectImportedSessionIds,
  createImportTargetResolver,
  externalSessionMetadataParts,
  externalSessionTitle,
  formatSessionSize,
  IMPORT_SESSION_OTHER_FOLDER_REASON,
  IMPORT_SESSION_UNMATCHED_FOLDER_REASON,
  listImportCapableProviders,
  mergeExternalSessionResults,
  resolveImportModelSelection,
  sessionRanOutsideFolder,
} from "./ImportSessionPalette.logic";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");

function provider(input: {
  instanceId: ProviderInstanceId;
  externalSessions?: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  models?: ServerProvider["models"];
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: ProviderDriverKind.make(input.instanceId),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    ...(input.externalSessions ? { externalSessions: input.externalSessions } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

function session(input: {
  instanceId?: ProviderInstanceId;
  sessionId: string;
  updatedAt: string;
  cwd?: string;
}): ExternalSessionSummary {
  const instanceId = input.instanceId ?? claude;
  return {
    providerInstanceId: instanceId,
    driverKind: ProviderDriverKind.make(instanceId),
    sessionId: input.sessionId,
    title: input.sessionId,
    cwd: input.cwd ?? "/repo",
    updatedAt: input.updatedAt,
  };
}

describe("listImportCapableProviders", () => {
  const providers = [
    provider({ instanceId: claude, externalSessions: "supported" }),
    provider({ instanceId: codex }),
  ];

  it("offers only instances that report external session support", () => {
    expect(
      listImportCapableProviders({ supportsForking: true, providers }).map(
        (entry) => entry.instanceId,
      ),
    ).toEqual([claude]);
  });

  it("offers nothing when the environment cannot fork, since imports run on a fork", () => {
    expect(listImportCapableProviders({ supportsForking: false, providers })).toEqual([]);
  });

  it("treats unknown support values and disabled or unavailable instances as unsupported", () => {
    expect(
      listImportCapableProviders({
        supportsForking: true,
        providers: [
          provider({ instanceId: claude, externalSessions: "paged" }),
          provider({ instanceId: codex, externalSessions: "supported", enabled: false }),
          provider({
            instanceId: ProviderInstanceId.make("codex_work"),
            externalSessions: "supported",
            availability: "unavailable",
          }),
        ],
      }),
    ).toEqual([]);
  });
});

describe("mergeExternalSessionResults", () => {
  it("interleaves instances newest first", () => {
    const merged = mergeExternalSessionResults([
      {
        providerInstanceId: claude,
        ok: true,
        truncated: false,
        sessions: [
          session({ sessionId: "c-new", updatedAt: "2026-03-03T00:00:00.000Z" }),
          session({ sessionId: "c-old", updatedAt: "2026-03-01T00:00:00.000Z" }),
        ],
      },
      {
        providerInstanceId: codex,
        ok: true,
        truncated: false,
        sessions: [
          session({ instanceId: codex, sessionId: "x-mid", updatedAt: "2026-03-02T00:00:00.000Z" }),
        ],
      },
    ]);
    expect(merged.sessions.map((entry) => entry.sessionId)).toEqual(["c-new", "x-mid", "c-old"]);
    expect(merged.truncated).toBe(false);
    expect(merged.failedInstanceIds).toEqual([]);
  });

  it("keeps the instances that answered when another fails, and reports the failure", () => {
    const merged = mergeExternalSessionResults([
      { providerInstanceId: codex, ok: false },
      {
        providerInstanceId: claude,
        ok: true,
        truncated: true,
        sessions: [session({ sessionId: "c-1", updatedAt: "2026-03-01T00:00:00.000Z" })],
      },
    ]);
    expect(merged.sessions.map((entry) => entry.sessionId)).toEqual(["c-1"]);
    expect(merged.truncated).toBe(true);
    expect(merged.failedInstanceIds).toEqual([codex]);
  });
});

describe("createImportTargetResolver", () => {
  const app = { id: "app", workspaceRoot: "/code/app" };
  const site = { id: "site", workspaceRoot: "/code/site" };
  const threads = [
    { projectId: "site", worktreePath: "/worktrees/site-fix", branch: "fix/nav" },
    { projectId: "site", worktreePath: null, branch: "main" },
    { projectId: "gone", worktreePath: "/worktrees/orphan", branch: null },
  ];

  it("imports a project-root session into that project with no worktree", () => {
    const resolve = createImportTargetResolver({
      projects: [app, site],
      threads,
      unmatchedReason: IMPORT_SESSION_UNMATCHED_FOLDER_REASON,
    });
    expect(resolve("/code/site/")).toEqual({
      kind: "importable",
      project: site,
      worktreePath: null,
      branch: null,
    });
  });

  it("imports a worktree session into the owning project, on that worktree and branch", () => {
    const resolve = createImportTargetResolver({
      projects: [app, site],
      threads,
      unmatchedReason: IMPORT_SESSION_UNMATCHED_FOLDER_REASON,
    });
    expect(resolve("/worktrees/site-fix")).toEqual({
      kind: "importable",
      project: site,
      worktreePath: "/worktrees/site-fix",
      branch: "fix/nav",
    });
  });

  it("blocks folders no project owns, including worktrees of removed projects", () => {
    const resolve = createImportTargetResolver({
      projects: [app, site],
      threads,
      unmatchedReason: IMPORT_SESSION_UNMATCHED_FOLDER_REASON,
    });
    const blocked = { kind: "blocked", reason: IMPORT_SESSION_UNMATCHED_FOLDER_REASON };
    expect(resolve("/code/elsewhere")).toEqual(blocked);
    expect(resolve("/worktrees/orphan")).toEqual(blocked);
  });

  it("blocks a worktree Lecturn does not manage rather than importing into the project root", () => {
    const resolve = createImportTargetResolver({
      projects: [app, site],
      threads,
      unmatchedReason: IMPORT_SESSION_OTHER_FOLDER_REASON,
    });
    expect(resolve("/code/site/.claude/worktrees/spike")).toEqual({
      kind: "blocked",
      reason: IMPORT_SESSION_OTHER_FOLDER_REASON,
    });
  });
});

describe("sessionRanOutsideFolder", () => {
  it("ignores path spelling and flags every other folder, worktrees included", () => {
    expect(sessionRanOutsideFolder("/code/site/", "/code/site")).toBe(false);
    expect(sessionRanOutsideFolder("/worktrees/site-fix", "/code/site")).toBe(true);
  });
});

describe("collectImportedSessionIds", () => {
  it("collects the source session of every imported thread", () => {
    const imported = collectImportedSessionIds([
      { importedFrom: { sessionId: "s-1" } },
      { importedFrom: null },
      {},
    ]);
    expect([...imported]).toEqual(["s-1"]);
  });
});

describe("session row text", () => {
  it("falls back from title to first prompt to a placeholder", () => {
    expect(externalSessionTitle({ title: "Fix nav", firstPrompt: "please fix" })).toBe("Fix nav");
    expect(externalSessionTitle({ title: "", firstPrompt: "please fix" })).toBe("please fix");
    expect(externalSessionTitle({ title: "" })).toBe("Untitled session");
  });

  it("lists origin, time, size and the imported mark in order", () => {
    expect(
      externalSessionMetadataParts({
        origin: "desktop",
        updatedLabel: "2h ago",
        sizeBytes: 3 * 1024 * 1024,
        imported: true,
      }),
    ).toEqual(["Desktop app", "2h ago", "3.0 MB", "Imported"]);
  });

  it("omits an unknown or absent origin and a missing size", () => {
    expect(
      externalSessionMetadataParts({
        origin: "unknown",
        updatedLabel: "2h ago",
        sizeBytes: undefined,
        imported: false,
      }),
    ).toEqual(["2h ago"]);
    expect(
      externalSessionMetadataParts({
        origin: undefined,
        updatedLabel: null,
        sizeBytes: 0,
        imported: false,
      }),
    ).toEqual(["0 B"]);
  });

  it("formats sizes at a readable precision", () => {
    expect(formatSessionSize(512)).toBe("512 B");
    expect(formatSessionSize(20_480)).toBe("20 KB");
    expect(formatSessionSize(1_572_864)).toBe("1.5 MB");
    expect(formatSessionSize(2 * 1024 ** 3)).toBe("2.0 GB");
  });
});

describe("resolveImportModelSelection", () => {
  const providers = [
    provider({
      instanceId: claude,
      models: [
        { slug: "sonnet", name: "Sonnet", isCustom: false, capabilities: {} },
        { slug: "opus", name: "Opus", isCustom: false, isDefault: true, capabilities: {} },
      ],
    }),
  ];

  it("uses the project default when it targets the session's instance", () => {
    expect(
      resolveImportModelSelection({
        instanceId: claude,
        providers,
        projectDefault: { instanceId: claude, model: "sonnet" },
        stickySelection: { instanceId: claude, model: "haiku" },
      }),
    ).toEqual({ instanceId: claude, model: "sonnet" });
  });

  it("ignores a project default for another instance and uses the last pick for this one", () => {
    expect(
      resolveImportModelSelection({
        instanceId: claude,
        providers,
        projectDefault: { instanceId: codex, model: "gpt-5" },
        stickySelection: { instanceId: claude, model: "sonnet" },
      }),
    ).toEqual({ instanceId: claude, model: "sonnet" });
  });

  it("falls back to the instance's own default model", () => {
    expect(
      resolveImportModelSelection({
        instanceId: claude,
        providers,
        projectDefault: null,
        stickySelection: undefined,
      }),
    ).toEqual({ instanceId: claude, model: "opus" });
  });

  it("returns nothing for an instance the environment no longer reports", () => {
    expect(
      resolveImportModelSelection({
        instanceId: codex,
        providers,
        projectDefault: null,
        stickySelection: undefined,
      }),
    ).toBeNull();
  });
});
