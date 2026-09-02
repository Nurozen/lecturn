import {
  CheckpointRef,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Atom } from "effect/unstable/reactivity";

import type { Thread, ThreadShell, TurnDiffSummary } from "../types";
import type { TimelineEntry } from "../session-logic";
import type { CodexArtifactTemplate } from "@t3tools/client-runtime/codex-artifact-templates";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLoadingThreadFromShell,
  buildThreadTurnInterruptInput,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  getStartedThreadModelChangeBlockReason,
  isVideoPreviewRequestCurrent,
  hasEnvironmentReconnectWarningGraceElapsed,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  resolveBackgroundDraftWorkspaceOptions,
  resolveDraftPromotionNavigationTarget,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  resolveDraftHeroState,
  scheduleEnvironmentReconnectWarning,
  startNewThreadForProject,
  codexArtifactTemplatePromptToAppend,
  shouldDockDraftHeroForSubmission,
  shouldReleaseTimelineAnchorForToolActivity,
  shouldShowBranchMismatchBanner,
  shouldShowPlanFollowUpPrompt,
  shouldWriteThreadErrorToCurrentServerThread,
  toolGroupConsumesUpwardNavigation,
} from "./ChatView.logic";
import {
  buildForkTitle,
  buildForkTurnIdByMessageId,
  resolveForkDisabledReason,
  waitForThreadShell,
} from "./ChatView.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "../state/threads";

// `waitForThreadShell` reads the app-level shell atoms, whose real
// implementation is fed by the connection runtime. Substitute a writable
// atom family so tests can seed and mutate shell rows through the registry.
vi.mock("../state/threads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const shellAtoms = Atom.family((_key: string) => Atom.make<ThreadShell | null>(null));
  const detailAtoms = Atom.family((_key: string) => Atom.make<Thread | null>(null));
  const refKey = (ref: ScopedThreadRef) => `${ref.environmentId}\u0000${ref.threadId}`;
  return {
    environmentThreadShells: {
      threadShellAtom: (ref: ScopedThreadRef) => shellAtoms(refKey(ref)),
    },
    environmentThreadDetails: {
      detailAtom: (ref: ScopedThreadRef) => detailAtoms(refKey(ref)),
    },
  };
});

describe("isVideoPreviewRequestCurrent", () => {
  it("rejects changed threads and replaced previews", () => {
    expect(isVideoPreviewRequestCurrent("thread-1", "thread-2", 1, 1)).toBe(false);
    expect(isVideoPreviewRequestCurrent("thread-1", "thread-1", 1, 2)).toBe(false);
    expect(isVideoPreviewRequestCurrent("thread-1", "thread-1", 2, 2)).toBe(true);
  });
});

describe("toolGroupConsumesUpwardNavigation", () => {
  class ScrollElement extends EventTarget {
    scrollTop = 0;
    scrollHeight = 100;
    clientHeight = 100;
    overflowY = "visible";

    constructor(
      readonly parentElement: ScrollElement | null = null,
      readonly isToolGroup = false,
    ) {
      super();
    }

    closest(selector: string): ScrollElement | null {
      if (selector !== "[data-tool-group-scroll]") return null;
      return this.isToolGroup ? this : (this.parentElement?.closest(selector) ?? null);
    }
  }

  beforeEach(() => {
    vi.stubGlobal("Element", ScrollElement);
    vi.stubGlobal("getComputedStyle", (element: ScrollElement) => ({
      overflowY: element.overflowY,
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("releases upward navigation when an overflowing group is at the top", () => {
    const group = Object.assign(new ScrollElement(null, true), {
      overflowY: "auto",
      scrollHeight: 300,
    });

    expect(toolGroupConsumesUpwardNavigation(new ScrollElement(group))).toBe(false);
  });

  it.each([
    { overflowY: "auto", scrollTop: 1 },
    { overflowY: "auto", scrollTop: 0.25 },
    { overflowY: "scroll", scrollTop: 80 },
  ])("consumes upward navigation within a scrolled group: %j", (scroll) => {
    const group = Object.assign(new ScrollElement(null, true), {
      scrollHeight: 300,
      ...scroll,
    });

    expect(toolGroupConsumesUpwardNavigation(group)).toBe(true);
  });

  it.each([100, 300])(
    "consumes scrolling in a nested result with a group content height of %i",
    (scrollHeight) => {
      const group = Object.assign(new ScrollElement(null, true), {
        overflowY: "auto",
        scrollHeight,
      });
      const result = Object.assign(new ScrollElement(group), {
        overflowY: "auto",
        scrollHeight: 300,
        scrollTop: 0.25,
      });

      expect(toolGroupConsumesUpwardNavigation(new ScrollElement(result))).toBe(true);
    },
  );

  it("releases upward navigation when the group and nested result are both at the top", () => {
    const group = Object.assign(new ScrollElement(null, true), {
      overflowY: "auto",
      scrollHeight: 300,
    });
    const result = Object.assign(new ScrollElement(group), {
      overflowY: "scroll",
      scrollHeight: 300,
    });

    expect(toolGroupConsumesUpwardNavigation(new ScrollElement(result))).toBe(false);
  });

  it("ignores targets outside a tool group and non-element targets", () => {
    const outside = Object.assign(new ScrollElement(), {
      overflowY: "auto",
      scrollHeight: 300,
      scrollTop: 40,
    });

    expect(toolGroupConsumesUpwardNavigation(outside)).toBe(false);
    expect(toolGroupConsumesUpwardNavigation(new EventTarget())).toBe(false);
    expect(toolGroupConsumesUpwardNavigation(null)).toBe(false);
  });

  it("does not consume scrolling from an ancestor beyond the tool group", () => {
    const timeline = Object.assign(new ScrollElement(), {
      overflowY: "auto",
      scrollHeight: 300,
      scrollTop: 40,
    });
    const group = new ScrollElement(timeline, true);

    expect(toolGroupConsumesUpwardNavigation(new ScrollElement(group))).toBe(false);
  });

  it.each(["hidden", "clip", "visible"])(
    "ignores a non-scrollable child with overflow-y %s",
    (overflowY) => {
      const group = new ScrollElement(null, true);
      const result = Object.assign(new ScrollElement(group), {
        overflowY,
        scrollHeight: 300,
        scrollTop: 40,
      });

      expect(toolGroupConsumesUpwardNavigation(new ScrollElement(result))).toBe(false);
    },
  );

  it("does not consume programmatic scrolling on an overflow-hidden group", () => {
    const group = Object.assign(new ScrollElement(null, true), {
      overflowY: "hidden",
      scrollHeight: 300,
      scrollTop: 40,
    });

    expect(toolGroupConsumesUpwardNavigation(group)).toBe(false);
  });
});

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";
const helloWorldTemplate: CodexArtifactTemplate = {
  artifactKind: "document",
  displayName: "Hello World",
  skillDirectory: "/Users/test/.codex/skills/artifact-template-hello-world",
  skillName: "artifact-template-hello-world",
};

describe("artifact template composer insertion", () => {
  it("does not insert an already-present prompt", () => {
    const prompt = "Create a document using this $artifact-template-hello-world about…";

    expect(codexArtifactTemplatePromptToAppend(prompt, helloWorldTemplate)).toBeNull();
  });
});

describe("draft hero submission transition", () => {
  it("does not dock the composer before a background submission", () => {
    expect(
      shouldDockDraftHeroForSubmission({
        isDraftHeroState: true,
        activeThreadKey: "environment-local:thread-1",
        submissionIntent: "background",
      }),
    ).toBe(false);
  });

  it("keeps the composer in the hero layout until navigation after server promotion", () => {
    expect(
      resolveDraftHeroState({
        isLocalDraftThread: false,
        hasTimelineEntries: true,
        isWorking: true,
        draftHeroDockRequested: false,
        backgroundSubmissionPending: true,
      }),
    ).toBe(true);
  });

  it("does not auto-navigate a background submission after server promotion", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef: { environmentId, threadId },
        serverThread: makeThread({ latestTurn: completedTurn }),
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });
});

describe("shouldReleaseTimelineAnchorForToolActivity", () => {
  const activeTurnId = TurnId.make("active-turn");
  const anchorMessageId = MessageId.make("anchored-message");
  const activeToolEntry = {
    id: "tool-entry",
    kind: "work" as const,
    createdAt: now,
    entry: {
      id: "active-tool",
      createdAt: now,
      turnId: activeTurnId,
      label: "Run command",
      tone: "tool" as const,
      command: "git status",
    },
  };

  it("releases the send anchor for tool activity in the active turn", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [activeToolEntry],
      }),
    ).toBe(true);
  });

  it("keeps the anchor while the user reads history", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: false,
        runningTurnId: activeTurnId,
        timelineEntries: [activeToolEntry],
      }),
    ).toBe(false);
  });

  it("ignores tool activity from earlier turns", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [
          {
            ...activeToolEntry,
            entry: {
              ...activeToolEntry.entry,
              turnId: TurnId.make("previous-turn"),
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("ignores thinking and error rows without tool activity", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [
          {
            ...activeToolEntry,
            entry: {
              id: "thinking-entry",
              createdAt: now,
              turnId: activeTurnId,
              label: "Thinking",
              tone: "thinking",
            },
          },
          {
            ...activeToolEntry,
            id: "error-entry",
            entry: {
              id: "error-entry",
              createdAt: now,
              turnId: activeTurnId,
              label: "Provider error",
              tone: "error",
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("does nothing without an anchor or running turn", () => {
    const input = {
      anchorMessageId,
      liveFollowEnabled: true,
      runningTurnId: activeTurnId,
      timelineEntries: [activeToolEntry],
    };

    expect(shouldReleaseTimelineAnchorForToolActivity({ ...input, anchorMessageId: null })).toBe(
      false,
    );
    expect(shouldReleaseTimelineAnchorForToolActivity({ ...input, runningTurnId: null })).toBe(
      false,
    );
  });
});

describe("environment reconnect warning grace", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a persistent reconnect after the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    scheduleEnvironmentReconnectWarning(showWarning);
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS - 1);
    expect(showWarning).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(showWarning).toHaveBeenCalledOnce();
  });

  it("cancels the warning when the connection recovers during the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    const cancel = scheduleEnvironmentReconnectWarning(showWarning);
    cancel();
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);

    expect(showWarning).not.toHaveBeenCalled();
  });

  it("does not reuse elapsed grace from another environment", () => {
    const anotherEnvironmentId = EnvironmentId.make("environment-remote");

    expect(hasEnvironmentReconnectWarningGraceElapsed(environmentId, environmentId)).toBe(true);
    expect(hasEnvironmentReconnectWarningGraceElapsed(anotherEnvironmentId, environmentId)).toBe(
      false,
    );
  });
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  threadId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("draft promotion during worktree setup", () => {
  const serverThreadRef = { environmentId, threadId };

  it.each([null, "idle", "starting", "ready"] as const)(
    "keeps the draft mounted while the first turn waits with session %s",
    (status) => {
      const serverThread = makeThread({
        messages: [
          {
            id: MessageId.make("submitted-message"),
            role: "user",
            text: "Start in a new worktree",
            turnId: null,
            createdAt: now,
            updatedAt: now,
            streaming: false,
          },
        ],
        session: status ? { ...readySession, status } : null,
      });

      expect(
        resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread,
          backgroundSubmissionPending: false,
        }),
      ).toBeNull();
    },
  );

  it("promotes when the provider starts the first turn", () => {
    const latestTurn = { ...completedTurn, state: "running" as const, completedAt: null };

    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({
          latestTurn,
          session: { ...readySession, status: "running", activeTurnId: latestTurn.turnId },
        }),
        backgroundSubmissionPending: false,
      }),
    ).toEqual(serverThreadRef);
  });

  it.each(["error", "stopped", "interrupted"] as const)(
    "promotes a startup that ends as %s before a turn starts",
    (status) => {
      expect(
        resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread: makeThread({ session: { ...readySession, status } }),
          backgroundSubmissionPending: false,
        }),
      ).toEqual(serverThreadRef);
    },
  );
});

describe("buildLoadingThreadFromShell", () => {
  it("preserves shell metadata and supplies empty detail collections", () => {
    const shell = {
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      session: null,
      latestUserMessageAt: now,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } satisfies ThreadShell;

    expect(buildLoadingThreadFromShell(shell)).toMatchObject({
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      branch: "main",
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
  });
});

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("buildThreadTurnInterruptInput", () => {
  it("targets the session's active running turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it("omits a turn id when the session is not running", () => {
    expect(buildThreadTurnInterruptInput(makeThread({ session: readySession }))).toEqual({
      threadId,
    });
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows model changes before a provider session has started", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toBeNull();
  });

  it("allows unchanged model selections for restricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toBeNull();
  });

  it("blocks started-session model changes when either provider requires a new thread", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toEqual({
      title: "Start a new chat to change models",
      description:
        "This provider does not allow switching models after a conversation has started.",
    });
  });
});

describe("buildForkTitle", () => {
  it("derives the child title from the parent title", () => {
    expect(buildForkTitle("Fix login redirect")).toBe("Fix login redirect (fork)");
  });

  it("trims the parent title before suffixing", () => {
    expect(buildForkTitle("  Fix login redirect  ")).toBe("Fix login redirect (fork)");
  });

  it("falls back for empty, whitespace, and missing parent titles", () => {
    // The fallback keeps the "(fork)" suffix so the first-turn titleSeed
    // guard still recognizes the minted title and auto-retitles the child.
    expect(buildForkTitle("")).toBe("Untitled (fork)");
    expect(buildForkTitle("   ")).toBe("Untitled (fork)");
    expect(buildForkTitle(null)).toBe("Untitled (fork)");
    expect(buildForkTitle(undefined)).toBe("Untitled (fork)");
  });
});

describe("buildForkTurnIdByMessageId", () => {
  const turnA = TurnId.make("turn-a");
  const turnB = TurnId.make("turn-b");
  const userM1 = MessageId.make("user-1");
  const assistantM1 = MessageId.make("assistant-1");
  const userM2 = MessageId.make("user-2");
  const assistantM2 = MessageId.make("assistant-2");
  const userM3 = MessageId.make("user-3");

  const messageEntry = (id: MessageId, role: "user" | "assistant"): TimelineEntry => ({
    id,
    kind: "message",
    createdAt: now,
    message: {
      id,
      role,
      text: "message text",
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  });

  const summaryFor = (
    turnId: TurnId,
    assistantMessageId: MessageId,
    status: TurnDiffSummary["status"],
  ): TurnDiffSummary => ({
    turnId,
    checkpointTurnCount: 1,
    checkpointRef: CheckpointRef.make(`ref-${turnId}`),
    status,
    files: [],
    assistantMessageId,
    completedAt: now,
  });

  const entries = [
    messageEntry(userM1, "user"),
    messageEntry(assistantM1, "assistant"),
    messageEntry(userM2, "user"),
    messageEntry(assistantM2, "assistant"),
    messageEntry(userM3, "user"),
  ];

  it("maps assistant rows to their own turn and user rows to the previous checkpoint's turn", () => {
    const byMessageId = buildForkTurnIdByMessageId({
      timelineEntries: entries,
      turnDiffSummaryByAssistantMessageId: new Map([
        [assistantM1, summaryFor(turnA, assistantM1, "ready")],
        [assistantM2, summaryFor(turnB, assistantM2, "ready")],
      ]),
      activeRunningTurnId: null,
    });

    // The first user row has no prior checkpoint to fork through.
    expect(byMessageId.get(userM1)).toBeUndefined();
    expect(byMessageId.get(assistantM1)).toBe(turnA);
    expect(byMessageId.get(userM2)).toBe(turnA);
    expect(byMessageId.get(assistantM2)).toBe(turnB);
    expect(byMessageId.get(userM3)).toBe(turnB);
  });

  it.each(["missing", "error"] as const)(
    "skips %s checkpoints for both the assistant row and following user rows",
    (status) => {
      const byMessageId = buildForkTurnIdByMessageId({
        timelineEntries: entries,
        turnDiffSummaryByAssistantMessageId: new Map([
          [assistantM1, summaryFor(turnA, assistantM1, "ready")],
          [assistantM2, summaryFor(turnB, assistantM2, status)],
        ]),
        activeRunningTurnId: null,
      });

      // The interrupted/failed turn is never a fork point; the user row
      // after it falls back to the last ready checkpoint instead of
      // forking through the broken turn.
      expect(byMessageId.get(assistantM2)).toBeUndefined();
      expect(byMessageId.get(userM3)).toBe(turnA);
      expect(byMessageId.get(assistantM1)).toBe(turnA);
      expect(byMessageId.get(userM2)).toBe(turnA);
    },
  );

  it("offers no fork points when no checkpoint is ready", () => {
    const byMessageId = buildForkTurnIdByMessageId({
      timelineEntries: entries,
      turnDiffSummaryByAssistantMessageId: new Map([
        [assistantM1, summaryFor(turnA, assistantM1, "missing")],
        [assistantM2, summaryFor(turnB, assistantM2, "error")],
      ]),
      activeRunningTurnId: null,
    });

    expect(byMessageId.size).toBe(0);
  });

  it("excludes the active running turn", () => {
    const byMessageId = buildForkTurnIdByMessageId({
      timelineEntries: entries,
      turnDiffSummaryByAssistantMessageId: new Map([
        [assistantM1, summaryFor(turnA, assistantM1, "ready")],
        [assistantM2, summaryFor(turnB, assistantM2, "ready")],
      ]),
      activeRunningTurnId: turnB,
    });

    expect(byMessageId.get(assistantM2)).toBeUndefined();
    expect(byMessageId.get(userM3)).toBe(turnA);
  });
});

describe("resolveForkDisabledReason", () => {
  const nativeInstance = ProviderInstanceId.make("codex");
  const cursorInstance = ProviderInstanceId.make("cursor");
  const grokInstance = ProviderInstanceId.make("grok");
  const legacyInstance = ProviderInstanceId.make("claudeAgent");
  const replayInstance = ProviderInstanceId.make("opencode");
  const providers = [
    {
      instanceId: nativeInstance,
      driver: ProviderDriverKind.make("codex"),
      conversationFork: "native",
    },
    {
      instanceId: cursorInstance,
      driver: ProviderDriverKind.make("cursor"),
      displayName: "Cursor",
      conversationFork: "unsupported",
    },
    {
      instanceId: grokInstance,
      driver: ProviderDriverKind.make("grok"),
      conversationFork: "unsupported",
    },
    {
      instanceId: legacyInstance,
      driver: ProviderDriverKind.make("claudeAgent"),
    },
    {
      instanceId: replayInstance,
      driver: ProviderDriverKind.make("opencode"),
      conversationFork: "replay",
    },
  ];
  const allowedInput = {
    providers,
    modelSelection: { instanceId: nativeInstance, model: "gpt-5.4" },
    capability: true,
    hasCompletedTurn: true,
  };

  it("blocks every entry point until the server supports forking", () => {
    expect(resolveForkDisabledReason({ ...allowedInput, capability: false })).toEqual({
      title: "Forking needs a server update",
      description: "Update the T3 Code server on this environment to fork threads.",
    });
  });

  it("allows forking for a native provider with a completed turn", () => {
    expect(resolveForkDisabledReason(allowedInput)).toBeNull();
  });

  it("names unsupported providers by display name when present", () => {
    expect(
      resolveForkDisabledReason({
        ...allowedInput,
        modelSelection: { instanceId: cursorInstance, model: "composer-2" },
      }),
    ).toEqual({
      title: "Forking isn't supported for Cursor yet",
      description: "This provider cannot resume a conversation into a new session.",
    });
  });

  it("falls back to the driver slug for unsupported providers without a display name", () => {
    expect(
      resolveForkDisabledReason({
        ...allowedInput,
        modelSelection: { instanceId: grokInstance, model: "grok-build" },
      }),
    ).toMatchObject({ title: "Forking isn't supported for grok yet" });
  });

  it("treats an absent conversationFork flag as unsupported", () => {
    expect(
      resolveForkDisabledReason({
        ...allowedInput,
        modelSelection: { instanceId: legacyInstance, model: "claude-fable-5" },
      }),
    ).toMatchObject({ title: "Forking isn't supported for claudeAgent yet" });
  });

  it("treats unknown conversationFork values as unsupported", () => {
    expect(
      resolveForkDisabledReason({
        ...allowedInput,
        modelSelection: { instanceId: replayInstance, model: "opencode-default" },
      }),
    ).toMatchObject({ title: "Forking isn't supported for opencode yet" });
  });

  it("blocks forking before the thread has a completed turn", () => {
    expect(resolveForkDisabledReason({ ...allowedInput, hasCompletedTurn: false })).toEqual({
      title: "Nothing to fork yet",
      description: "Forking becomes available once the thread has a completed turn.",
    });
  });

  it("resolves the provider from the session over the composer selection", () => {
    expect(
      resolveForkDisabledReason({
        ...allowedInput,
        modelSelection: { instanceId: nativeInstance, model: "gpt-5.4" },
        sessionProviderInstanceId: cursorInstance,
      }),
    ).toMatchObject({ title: "Forking isn't supported for Cursor yet" });
    expect(
      resolveForkDisabledReason({
        ...allowedInput,
        modelSelection: { instanceId: cursorInstance, model: "composer-2" },
        sessionProviderInstanceId: nativeInstance,
      }),
    ).toBeNull();
  });
});

describe("waitForThreadShell", () => {
  let nextThreadOrdinal = 0;
  const makeShellRef = (): ScopedThreadRef => ({
    environmentId,
    threadId: ThreadId.make(`thread-shell-${nextThreadOrdinal++}`),
  });
  const makeShell = (ref: ScopedThreadRef): ThreadShell => ({
    environmentId: ref.environmentId,
    id: ref.threadId,
    projectId,
    title: "Forked thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });
  const writableShellAtom = (ref: ScopedThreadRef) =>
    environmentThreadShells.threadShellAtom(ref) as unknown as Atom.Writable<ThreadShell | null>;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when the shell row already exists", async () => {
    const ref = makeShellRef();
    appAtomRegistry.set(writableShellAtom(ref), makeShell(ref));

    await expect(waitForThreadShell(ref)).resolves.toBe(true);
  });

  it("resolves once the shell row appears after subscribing", async () => {
    const ref = makeShellRef();
    const pending = waitForThreadShell(ref);

    appAtomRegistry.set(writableShellAtom(ref), makeShell(ref));

    await expect(pending).resolves.toBe(true);
  });

  it("resolves false when no shell row appears before the timeout", async () => {
    vi.useFakeTimers();
    const ref = makeShellRef();
    const pending = waitForThreadShell(ref);

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toBe(false);
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("resolveBackgroundDraftWorkspaceOptions", () => {
  it("keeps New worktree selected without reusing the launched worktree", () => {
    expect(
      resolveBackgroundDraftWorkspaceOptions({
        envMode: "worktree",
        branch: "main",
        startFromOrigin: true,
      }),
    ).toEqual({
      envMode: "worktree",
      branch: "main",
      worktreePath: null,
      startFromOrigin: true,
    });
  });
});

describe("branchMismatchKey", () => {
  it("builds a key from thread id and both branches", () => {
    expect(branchMismatchKey("thread-1", { threadBranch: "feat/a", currentBranch: "feat/b" })).toBe(
      "thread-1:feat/a:feat/b",
    );
  });

  it("returns null without a thread or mismatch", () => {
    expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
    expect(branchMismatchKey("thread-1", null)).toBeNull();
  });
});

describe("shouldShowBranchMismatchBanner", () => {
  const base = {
    hasMismatch: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentMismatch: false,
  };

  it("stays hidden during passive browsing (even though the composer autofocuses)", () => {
    expect(shouldShowBranchMismatchBanner(base)).toBe(false);
  });

  it("shows once the composer has draft content", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, composerHasContent: true })).toBe(true);
  });

  it("stays mounted after the draft clears once shown for the current mismatch", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, wasShownForCurrentMismatch: true })).toBe(
      true,
    );
  });

  it("never shows when dismissed or without a mismatch", () => {
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, hasMismatch: false }),
    ).toBe(false);
  });
});

describe("shouldShowPlanFollowUpPrompt", () => {
  const base = {
    pendingUserInputCount: 0,
    interactionMode: "plan" as const,
    latestTurnSettled: true,
    hasActionableProposedPlan: true,
    hasComposerAttachments: false,
  };

  it("shows plan actions for a settled actionable plan without attachments", () => {
    expect(shouldShowPlanFollowUpPrompt(base)).toBe(true);
  });

  it("hides plan actions while the composer has staged attachments", () => {
    expect(shouldShowPlanFollowUpPrompt({ ...base, hasComposerAttachments: true })).toBe(false);
  });

  it("preserves the existing plan follow-up gates", () => {
    expect(shouldShowPlanFollowUpPrompt({ ...base, pendingUserInputCount: 1 })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, interactionMode: "default" })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, latestTurnSettled: false })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, hasActionableProposedPlan: false })).toBe(false);
  });
});

describe("session branch mismatch dismissal", () => {
  it("tracks dismissed keys and treats other keys as active", () => {
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(false);
    dismissBranchMismatchForSession("t1:a:b");
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(true);
    expect(isBranchMismatchDismissedForSession("t1:a:c")).toBe(false);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("writes errors for a shell-derived active server thread", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
  });

  it("requires an active server thread matching the environment, route, and target", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("startNewThreadForProject", () => {
  it("starts a thread through the supplied shared handler for the active project", () => {
    const calls: Array<{ environmentId: EnvironmentId; projectId: ProjectId }> = [];
    const projectRef = { environmentId, projectId };

    expect(
      startNewThreadForProject(projectRef, (nextProjectRef) => {
        calls.push(nextProjectRef);
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(calls).toEqual([projectRef]);
  });

  it("does nothing when the active project is unavailable", () => {
    let called = false;

    expect(
      startNewThreadForProject(null, () => {
        called = true;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("keeps a follow-up active while its provider session is starting", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "connecting",
        latestTurn: completedTurn,
        latestUserMessageId: MessageId.make("message-followup"),
        session: {
          ...readySession,
          status: "starting",
          updatedAt: "2026-03-29T00:01:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: newerTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: TurnId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: runningTurn.turnId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running turn", () => {
    const runningTurn = {
      ...completedTurn,
      state: "running" as const,
      completedAt: null,
    };
    const runningSession = {
      ...readySession,
      status: "running" as const,
      activeTurnId: runningTurn.turnId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestTurn: runningTurn,
        session: runningSession,
        messages: [
          {
            id: MessageId.make("message-before-steer"),
            role: "user",
            text: "Initial prompt",
            turnId: runningTurn.turnId,
            createdAt: runningTurn.requestedAt,
            updatedAt: runningTurn.requestedAt,
            streaming: false,
          },
        ],
      }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: MessageId.make("message-steer"),
        session: runningSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      latestUserMessageId: localDispatch.latestUserMessageId,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });
});
