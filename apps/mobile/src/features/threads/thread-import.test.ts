import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ModelOption } from "../../lib/modelOptions";
import {
  collectImportedSessionIds,
  createImportTargetResolver,
  externalSessionMetadataParts,
  externalSessionTitle,
  filterExternalSessions,
  filterSessionRows,
  IMPORT_SESSION_OTHER_FOLDER_REASON,
  IMPORT_SESSION_UNMATCHED_FOLDER_REASON,
  mergeExternalSessionResults,
  resolveImportModelSelection,
  resolveImportThreadModes,
  resolveThreadImportAvailability,
  sessionRanOutsideFolder,
  threadImportFailureMessage,
  type ExternalSessionsInstanceResult,
} from "./thread-import";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

function provider(overrides: Partial<ServerProvider> & { instanceId: ProviderInstanceId }) {
  return {
    driver: "codex",
    enabled: true,
    externalSessions: "supported",
    models: [],
    ...overrides,
  } as unknown as ServerProvider;
}

function session(
  overrides: Partial<{
    providerInstanceId: ProviderInstanceId;
    sessionId: string;
    updatedAt: string;
    cwd: string;
  }> = {},
) {
  return {
    providerInstanceId: codex,
    driverKind: ProviderDriverKind.make("codex"),
    sessionId: "s1",
    title: "Fix the parser",
    cwd: "/work/lecturn",
    updatedAt: "2026-09-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("resolveThreadImportAvailability", () => {
  const capable = {
    connected: true,
    serverSupportsForking: true,
    providers: [provider({ instanceId: codex })],
  };

  it("lists the import-capable instances of a connected, capable environment", () => {
    expect(resolveThreadImportAvailability(capable)).toEqual({
      available: true,
      providers: capable.providers,
    });
  });

  it("refuses while the environment is disconnected", () => {
    expect(resolveThreadImportAvailability({ ...capable, connected: false })).toEqual({
      available: false,
      reason: "disconnected",
    });
  });

  it("refuses a server that cannot fork, since imports run on a fork", () => {
    expect(resolveThreadImportAvailability({ ...capable, serverSupportsForking: false })).toEqual({
      available: false,
      reason: "server-unsupported",
    });
  });

  it("drops instances that are disabled, unavailable, or not session-capable", () => {
    expect(
      resolveThreadImportAvailability({
        ...capable,
        providers: [
          provider({ instanceId: codex, enabled: false }),
          provider({ instanceId: claude, availability: "unavailable" }),
          provider({
            instanceId: ProviderInstanceId.make("grok"),
            externalSessions: "unsupported",
          }),
          provider({ instanceId: ProviderInstanceId.make("cursor"), externalSessions: undefined }),
        ],
      }),
    ).toEqual({ available: false, reason: "provider-unsupported" });
  });

  it("keeps only the capable instances when the environment mixes them", () => {
    const supported = provider({ instanceId: claude });
    const result = resolveThreadImportAvailability({
      ...capable,
      providers: [provider({ instanceId: codex, externalSessions: "unsupported" }), supported],
    });
    expect(result).toEqual({ available: true, providers: [supported] });
  });
});

describe("mergeExternalSessionResults", () => {
  it("merges every instance newest first and reports the failures alongside", () => {
    const results: ReadonlyArray<ExternalSessionsInstanceResult> = [
      {
        providerInstanceId: codex,
        ok: true,
        truncated: false,
        sessions: [
          session({ sessionId: "older", updatedAt: "2026-09-19T10:00:00.000Z" }),
          session({ sessionId: "newest", updatedAt: "2026-09-21T10:00:00.000Z" }),
        ],
      },
      {
        providerInstanceId: claude,
        ok: true,
        truncated: true,
        sessions: [
          session({
            providerInstanceId: claude,
            sessionId: "middle",
            updatedAt: "2026-09-20T10:00:00.000Z",
          }),
        ],
      },
      { providerInstanceId: ProviderInstanceId.make("grok"), ok: false },
    ];

    const merged = mergeExternalSessionResults(results);
    expect(merged.sessions.map((entry) => entry.sessionId)).toEqual(["newest", "middle", "older"]);
    expect(merged.truncated).toBe(true);
    expect(merged.failedInstanceIds).toEqual([ProviderInstanceId.make("grok")]);
  });

  it("breaks ties on session id so the order never flickers between renders", () => {
    const same = "2026-09-20T10:00:00.000Z";
    const merged = mergeExternalSessionResults([
      {
        providerInstanceId: codex,
        ok: true,
        truncated: false,
        sessions: [
          session({ sessionId: "b", updatedAt: same }),
          session({ sessionId: "a", updatedAt: same }),
        ],
      },
    ]);
    expect(merged.sessions.map((entry) => entry.sessionId)).toEqual(["a", "b"]);
  });

  it("yields an empty list when every instance failed", () => {
    expect(
      mergeExternalSessionResults([
        { providerInstanceId: codex, ok: false },
        { providerInstanceId: claude, ok: false },
      ]),
    ).toEqual({ sessions: [], truncated: false, failedInstanceIds: [codex, claude] });
  });
});

describe("createImportTargetResolver", () => {
  const projects = [
    { id: "p1", workspaceRoot: "/work/lecturn" },
    { id: "p2", workspaceRoot: "/work/other" },
  ];
  const threads = [
    { projectId: "p1", worktreePath: "/work/trees/feature", branch: "feature" },
    { projectId: "p1", worktreePath: null, branch: "main" },
    { projectId: "missing", worktreePath: "/work/trees/orphan", branch: "orphan" },
  ];

  it("imports a project root into the project itself, on no worktree", () => {
    const resolve = createImportTargetResolver({
      projects,
      threads,
      unmatchedReason: IMPORT_SESSION_OTHER_FOLDER_REASON,
    });
    expect(resolve("/work/other/")).toEqual({
      kind: "importable",
      project: projects[1],
      worktreePath: null,
      branch: null,
    });
  });

  it("imports a known thread worktree into that thread's project, on the worktree", () => {
    const resolve = createImportTargetResolver({
      projects,
      threads,
      unmatchedReason: IMPORT_SESSION_OTHER_FOLDER_REASON,
    });
    expect(resolve("/work/trees/feature")).toEqual({
      kind: "importable",
      project: projects[0],
      worktreePath: "/work/trees/feature",
      branch: "feature",
    });
  });

  it("blocks a folder Lecturn does not manage, with the scope's own reason", () => {
    const scoped = createImportTargetResolver({
      projects,
      threads,
      unmatchedReason: IMPORT_SESSION_OTHER_FOLDER_REASON,
    });
    expect(scoped("/elsewhere")).toEqual({
      kind: "blocked",
      reason: IMPORT_SESSION_OTHER_FOLDER_REASON,
    });
    const allFolders = createImportTargetResolver({
      projects,
      threads,
      unmatchedReason: IMPORT_SESSION_UNMATCHED_FOLDER_REASON,
    });
    expect(allFolders("/elsewhere")).toEqual({
      kind: "blocked",
      reason: IMPORT_SESSION_UNMATCHED_FOLDER_REASON,
    });
    // A worktree whose project is gone is not a target either.
    expect(allFolders("/work/trees/orphan")).toEqual({
      kind: "blocked",
      reason: IMPORT_SESSION_UNMATCHED_FOLDER_REASON,
    });
  });

  it("prefers the project root when a project and a worktree share a path", () => {
    const resolve = createImportTargetResolver({
      projects,
      threads: [{ projectId: "p2", worktreePath: "/work/lecturn", branch: "shadow" }],
      unmatchedReason: IMPORT_SESSION_OTHER_FOLDER_REASON,
    });
    expect(resolve("/work/lecturn")).toEqual({
      kind: "importable",
      project: projects[0],
      worktreePath: null,
      branch: null,
    });
  });
});

describe("sessionRanOutsideFolder", () => {
  it("ignores trailing-separator differences", () => {
    expect(sessionRanOutsideFolder("/work/lecturn/", "/work/lecturn")).toBe(false);
    expect(sessionRanOutsideFolder("/work/lecturn/apps", "/work/lecturn")).toBe(true);
  });
});

describe("collectImportedSessionIds", () => {
  it("collects only threads that carry an import origin", () => {
    expect(
      collectImportedSessionIds([
        { importedFrom: { sessionId: "s1" } },
        { importedFrom: null },
        {},
        { importedFrom: { sessionId: "s2" } },
        { importedFrom: { sessionId: "s1" } },
      ]),
    ).toEqual(new Set(["s1", "s2"]));
  });
});

describe("externalSessionTitle", () => {
  it("falls back through the first prompt to a placeholder", () => {
    expect(externalSessionTitle({ title: "Fix parser", firstPrompt: "hello" })).toBe("Fix parser");
    expect(externalSessionTitle({ title: "", firstPrompt: "hello" })).toBe("hello");
    expect(externalSessionTitle({ title: "" })).toBe("Untitled session");
  });
});

describe("filterExternalSessions", () => {
  const sessions = [
    {
      title: "Fix the parser",
      firstPrompt: "why does it crash",
      gitBranch: "fix/parse",
      cwd: "/a",
    },
    { title: "Add docs", firstPrompt: undefined, gitBranch: undefined, cwd: "/work/lecturn" },
  ];

  it("returns everything for a blank query", () => {
    expect(filterExternalSessions(sessions, "   ")).toBe(sessions);
  });

  it("matches title, prompt, branch, and folder case-insensitively", () => {
    expect(filterExternalSessions(sessions, "PARSER")).toEqual([sessions[0]]);
    expect(filterExternalSessions(sessions, "crash")).toEqual([sessions[0]]);
    expect(filterExternalSessions(sessions, "fix/")).toEqual([sessions[0]]);
    expect(filterExternalSessions(sessions, "lecturn")).toEqual([sessions[1]]);
    expect(filterExternalSessions(sessions, "nothing")).toEqual([]);
  });
});

describe("externalSessionMetadataParts", () => {
  it("assembles the full line in order", () => {
    expect(
      externalSessionMetadataParts({
        providerLabel: "Codex",
        origin: "cli",
        updatedLabel: "2h",
        sizeBytes: 2048,
        imported: true,
        gitBranch: "main",
        folder: "/work/other",
      }),
    ).toEqual(["Codex", "CLI", "2h", "2 KB", "Imported", "main", "/work/other"]);
  });

  it("drops every absent piece rather than leaving a gap", () => {
    expect(
      externalSessionMetadataParts({
        providerLabel: "Claude",
        origin: "unknown",
        updatedLabel: null,
        sizeBytes: undefined,
        imported: false,
        gitBranch: null,
        folder: null,
      }),
    ).toEqual(["Claude"]);
  });

  it("names each origin the provider reports", () => {
    const parts = (origin: "cli" | "desktop" | "ide") =>
      externalSessionMetadataParts({
        providerLabel: "Codex",
        origin,
        updatedLabel: null,
        sizeBytes: undefined,
        imported: false,
        gitBranch: null,
        folder: null,
      });
    expect(parts("cli")).toEqual(["Codex", "CLI"]);
    expect(parts("desktop")).toEqual(["Codex", "Desktop app"]);
    expect(parts("ide")).toEqual(["Codex", "IDE"]);
  });

  it("scales the size label past kilobytes", () => {
    const size = (sizeBytes: number) =>
      externalSessionMetadataParts({
        providerLabel: "Codex",
        origin: undefined,
        updatedLabel: null,
        sizeBytes,
        imported: false,
        gitBranch: null,
        folder: null,
      })[1];
    expect(size(512)).toBe("512 B");
    expect(size(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(size(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});

describe("threadImportFailureMessage", () => {
  it("explains every refusal the server can send", () => {
    expect(
      (
        [
          "forking-disabled",
          "provider-unsupported",
          "provider-unavailable",
          "session-not-found",
          "unreadable",
          "empty-session",
        ] as const
      ).map(threadImportFailureMessage),
    ).toEqual([
      "Update the Lecturn server on this environment to import sessions.",
      "This provider cannot import sessions created outside Lecturn.",
      "That provider is disabled or no longer configured.",
      "That session no longer exists.",
      "That session could not be read.",
      "That session has no messages to import.",
    ]);
  });
});

describe("resolveImportModelSelection", () => {
  const option = (overrides: Partial<ModelOption> & { key: string }) =>
    ({
      label: overrides.key,
      subtitle: "",
      providerKey: codex,
      providerDriver: "codex",
      isDefault: false,
      isLegacy: false,
      capabilities: null,
      selection: { instanceId: codex, model: overrides.key },
      ...overrides,
    }) as ModelOption;

  const modelOptions = [
    option({ key: "gpt-5.4", isLegacy: true }),
    option({ key: "gpt-5.6", isDefault: true }),
    option({
      key: "sonnet",
      providerKey: claude,
      selection: { instanceId: claude, model: "sonnet" },
    }),
  ];

  it("keeps the project default when it already targets the session's instance", () => {
    expect(
      resolveImportModelSelection({
        instanceId: codex,
        modelOptions,
        projectDefault: { instanceId: codex, model: "gpt-5.4" },
        stickySelection: { instanceId: codex, model: "gpt-5.6" },
      }),
    ).toEqual({ instanceId: codex, model: "gpt-5.4" });
  });

  it("falls through to the sticky pick, then the instance's own default", () => {
    expect(
      resolveImportModelSelection({
        instanceId: codex,
        modelOptions,
        projectDefault: { instanceId: claude, model: "sonnet" },
        stickySelection: { instanceId: codex, model: "gpt-5.6" },
      }),
    ).toEqual({ instanceId: codex, model: "gpt-5.6" });
    expect(
      resolveImportModelSelection({
        instanceId: codex,
        modelOptions,
        projectDefault: { instanceId: claude, model: "sonnet" },
        stickySelection: null,
      }),
    ).toEqual({ instanceId: codex, model: "gpt-5.6" });
  });

  it("never lands on another instance's model, nor on a legacy one while a current model exists", () => {
    expect(
      resolveImportModelSelection({
        instanceId: claude,
        modelOptions,
        projectDefault: { instanceId: codex, model: "gpt-5.6" },
        stickySelection: { instanceId: codex, model: "gpt-5.6" },
      }),
    ).toEqual({ instanceId: claude, model: "sonnet" });
    expect(
      resolveImportModelSelection({
        instanceId: codex,
        modelOptions: [option({ key: "gpt-5.4", isLegacy: true }), option({ key: "gpt-5.6" })],
        projectDefault: null,
        stickySelection: null,
      }),
    ).toEqual({ instanceId: codex, model: "gpt-5.6" });
  });

  it("refuses an instance that offers nothing startable", () => {
    expect(
      resolveImportModelSelection({
        instanceId: ProviderInstanceId.make("grok"),
        modelOptions,
        projectDefault: null,
        stickySelection: null,
      }),
    ).toBeNull();
    expect(
      resolveImportModelSelection({
        instanceId: codex,
        modelOptions: [option({ key: "gpt-5.6", isUnavailable: true })],
        projectDefault: null,
        stickySelection: null,
      }),
    ).toBeNull();
  });
});

describe("filterSessionRows", () => {
  const rows = [
    { key: "a", session: session({ sessionId: "a" }) },
    { key: "b", session: session({ sessionId: "b", cwd: "/work/other" }) },
  ];

  it("keeps the rows it was given so a keystroke cannot re-identify them", () => {
    const wide = filterSessionRows(rows, "fix");
    const narrow = filterSessionRows(rows, "lecturn");
    expect(wide).toEqual(rows);
    expect(wide[0]).toBe(rows[0]);
    expect(narrow).toEqual([rows[0]]);
    expect(narrow[0]).toBe(rows[0]);
    expect(filterSessionRows(rows, "  ")).toBe(rows);
  });

  it("drops the rows whose session matches nothing", () => {
    expect(filterSessionRows(rows, "nothing here")).toEqual([]);
  });
});

describe("resolveImportThreadModes", () => {
  it("prefers the draft's choices, with the flow's current selection behind them", () => {
    expect(
      resolveImportThreadModes({
        draftRuntimeMode: "approval-required",
        flowRuntimeMode: "auto",
        draftInteractionMode: "plan",
        flowInteractionMode: "default",
        planModeEnabled: true,
      }),
    ).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
    expect(
      resolveImportThreadModes({
        draftRuntimeMode: undefined,
        flowRuntimeMode: "auto-accept-edits",
        draftInteractionMode: undefined,
        flowInteractionMode: "plan",
        planModeEnabled: true,
      }),
    ).toEqual({ runtimeMode: "auto-accept-edits", interactionMode: "plan" });
  });

  it("builds while the flow offers no Plan toggle, whatever the draft still holds", () => {
    expect(
      resolveImportThreadModes({
        draftRuntimeMode: "approval-required",
        flowRuntimeMode: "auto",
        draftInteractionMode: "plan",
        flowInteractionMode: "plan",
        planModeEnabled: false,
      }),
    ).toEqual({ runtimeMode: "approval-required", interactionMode: "default" });
  });

  it("falls back to the contract defaults only when nothing was chosen", () => {
    expect(
      resolveImportThreadModes({
        draftRuntimeMode: null,
        flowRuntimeMode: null,
        draftInteractionMode: null,
        flowInteractionMode: null,
        planModeEnabled: true,
      }),
    ).toEqual({
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    });
  });
});
