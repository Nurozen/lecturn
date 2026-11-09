import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-home");
const PROJECT_ID = ProjectId.make("project-home");
const INSTANCE_ID = ProviderInstanceId.make("codex");
const RUN_ID = RunId.make("run-1");

const fixture = vi.hoisted(() => ({
  shell: null as unknown,
  projection: null as unknown,
  items: [] as unknown[],
  // Stable like the real hooks: a fresh empty array per render loops ChatView's memoized rows.
  noItems: [] as unknown[],
  summaries: [] as unknown[],
  project: null as unknown,
  environments: [] as unknown[],
  providers: new Map<string, unknown>(),
  respondToApproval: (async () => undefined) as unknown,
  contextual: false,
  threadStatus: "live" as string,
  contextualStatusReads: new Map<string, unknown>(),
  annotation: {
    id: "annotation-1",
    pageUrl: "http://localhost:5173/",
    pageTitle: null,
    comment: "tighten this",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: "2026-10-16T00:00:00.000Z",
  },
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((ref: unknown) => (ref === null ? null : fixture.shell)) as never,
  useThreadShell: ((ref: unknown) => (ref === null ? null : fixture.shell)) as never,
  useThreadProjection: ((ref: unknown) =>
    ref === null || fixture.projection === null
      ? null
      : { projection: fixture.projection }) as never,
  useQuietThreadProjection: ((ref: unknown) =>
    ref === null || fixture.projection === null
      ? null
      : { projection: fixture.projection }) as never,
  useThreadVisibleTurnItems: ((ref: unknown) =>
    ref === null ? fixture.noItems : fixture.items) as never,
  useQuietThreadVisibleTurnItems: ((ref: unknown) =>
    ref === null ? fixture.noItems : fixture.items) as never,
  useThreadCheckpointSummaries: ((ref: unknown) =>
    ref === null ? [] : fixture.summaries) as never,
  useThreadStatus: (() => fixture.threadStatus) as never,
  useProject: ((ref: unknown) => (ref === null ? null : fixture.project)) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    isReady: true,
    networkStatus: "online",
    environments: fixture.environments,
    presentationById: new Map(),
  })) as never,
  useEnvironmentProviders: (() => fixture.providers) as never,
}));
vi.mock(import("../../state/squires"), async (original) => ({
  ...(await original()),
  useSquireEnvironmentState: (() => ({
    lead: null,
    rooms: [],
    squires: [
      {
        squire: {
          id: "squire-release",
          name: "Release",
          role: "squire",
          homeThreadId: "thread-home",
        },
      },
    ],
  })) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
  readEnvironmentScope: (() => true) as never,
}));
// A sent draft's headline needs machine presentations this harness leaves out.
vi.mock(import("./DraftHeroHeadline"), () => ({ DraftHeroHeadline: (() => null) as never }));
vi.mock(import("../../state/contextual"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useContextualAvailable: (() => fixture.contextual) as never,
    contextualEnvironment: {
      ...actual.contextualEnvironment,
      status: ((target: { input: { threadId: string } }) =>
        contextualStatus(target.input.threadId)) as never,
    },
  };
});
vi.mock(import("./usePendingThreadRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    usePendingThreadRequests: ((input: Parameters<typeof actual.usePendingThreadRequests>[0]) => ({
      ...actual.usePendingThreadRequests(input),
      onRespondToApproval: fixture.respondToApproval,
    })) as never,
  };
});
// The preview's own "send annotation" control, without a browser surface behind it.
vi.mock(import("./RightPanelSurfaceContent"), () => ({
  RightPanelSurfaceContent: ((props: {
    onSendAnnotation: (annotation: unknown, image: null) => void;
  }) => (
    <button type="button" onClick={() => props.onSendAnnotation(fixture.annotation, null)}>
      Send annotation
    </button>
  )) as never,
}));

import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useRightPanelStore } from "../../rightPanelStore";
import { makeThreadFixture, makeThreadProjectionFixture } from "../../test-fixtures";
import ChatView from "../ChatView";
import { toastManager } from "../ui/toast";
import { render } from "../../../test/render";
import {
  SQUIRE_THREAD_CONTROLS,
  type ChatViewControl,
  type ChatViewControls,
} from "./chatViewControls";
import { APP_TOOL_APPROVAL_SEND_BLOCK_REASON } from "./composerApprovalState";
import { resetHeldThreadTimeline } from "../ChatView.logic";

/** Like the query family, a thread's status keeps its first answer; not-found until the thread exists. */
function contextualStatus(threadId: string) {
  let read = fixture.contextualStatusReads.get(threadId);
  if (read === undefined) {
    read = Atom.make(
      fixture.shell === null
        ? AsyncResult.failure(Cause.fail(new Error("Thread unavailable.")))
        : AsyncResult.success({
            thread: { enabled: false, sourceIds: [], revision: 0 },
            project: { projectId: PROJECT_ID, sourceIds: [] },
            effective: { enabled: false, effective: false, reason: "off" },
            hostName: "Local",
            preparation: null,
          }),
    );
    fixture.contextualStatusReads.set(threadId, read);
  }
  return read;
}

const time = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 12, 0, second));

function turnItem(
  id: string,
  second: number,
  runId: RunId | null,
  fields: Record<string, unknown>,
) {
  return {
    id: TurnItemId.make(id),
    threadId: THREAD_ID,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    status: "completed",
    title: null,
    startedAt: time(second),
    completedAt: time(second),
    updatedAt: time(second),
    ...fields,
  } as unknown as OrchestrationV2TurnItem;
}

const RUN_2_ID = RunId.make("run-2");

function run(id: RunId, ordinal: number, userMessageId: string, second: number) {
  return {
    id,
    threadId: THREAD_ID,
    ordinal,
    providerInstanceId: INSTANCE_ID,
    modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.4" },
    providerThreadId: null,
    userMessageId: MessageId.make(userMessageId),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: time(second),
    startedAt: time(second),
    completedAt: time(second + 2),
    checkpointId: null,
    contextHandoffId: null,
  };
}

function seedHomeThread() {
  const base = makeThreadFixture({
    environmentId: ENVIRONMENT_ID,
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Release",
  });
  fixture.shell = { ...base, squire: { squireId: "squire-release", role: "home" } };
  fixture.contextual = false;
  fixture.threadStatus = "live";
  fixture.contextualStatusReads.clear();
  const items = [
    turnItem("user-item", 1, RUN_ID, {
      type: "user_message",
      messageId: MessageId.make("user-1"),
      text: "What changed in the release branch?",
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    }),
    turnItem("file-change-item", 2, RUN_ID, {
      type: "file_change",
      fileName: "/repo/src/release.ts",
      additions: 3,
      deletions: 1,
    }),
    turnItem("assistant-item", 3, RUN_ID, {
      type: "assistant_message",
      messageId: MessageId.make("assistant-1"),
      text: "Two PRs merged and CI is green. Run `vp test` to confirm.",
      streaming: false,
    }),
    turnItem("checkpoint-item", 4, RUN_ID, {
      type: "checkpoint",
      checkpointId: CheckpointId.make("checkpoint-1"),
      scopeId: CheckpointScopeId.make("scope-1"),
      files: [{ path: "src/release.ts", kind: "modified", additions: 3, deletions: 1 }],
    }),
    turnItem("notification-item", 5, null, {
      type: "notification",
      source: {
        kind: "squire",
        squireId: "squire-release",
        eventCount: 2,
        eventKinds: ["pull-request-changed", "turn-finished"],
      },
      outcome: "updated",
      summary: "2 Squire events: pull-request-changed, turn-finished",
    }),
    turnItem("user-item-2", 6, RUN_2_ID, {
      type: "user_message",
      messageId: MessageId.make("user-2"),
      text: "Which check failed?",
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    }),
    turnItem("assistant-item-2", 7, RUN_2_ID, {
      type: "assistant_message",
      messageId: MessageId.make("assistant-2"),
      text: "The lint job on PR #12.",
      streaming: false,
    }),
  ];
  fixture.items = items.map((item, position): OrchestrationV2ProjectedTurnItem => ({
    position,
    visibility: "local",
    sourceThreadId: THREAD_ID,
    sourceItemId: item.id,
    item,
  }));
  const projection = makeThreadProjectionFixture();
  // Edit from here needs the live provider conversation to have reached the target run.
  const providerThreadId = "provider-thread-home";
  const attemptId = "attempt-1";
  fixture.projection = {
    ...projection,
    thread: {
      ...projection.thread,
      id: THREAD_ID,
      projectId: PROJECT_ID,
      activeProviderThreadId: providerThreadId,
    },
    providerThreads: [
      {
        id: providerThreadId,
        providerInstanceId: projection.thread.modelSelection.instanceId,
        providerSessionId: "provider-session-home",
      },
    ],
    attempts: [{ id: attemptId, runId: RUN_ID, providerTurnId: null }],
    providerTurns: [
      { id: "provider-turn-1", providerThreadId, runAttemptId: attemptId, ordinal: 1 },
    ],
    runs: [
      { ...run(RUN_ID, 1, "user-1", 1), activeAttemptId: attemptId },
      run(RUN_2_ID, 2, "user-2", 6),
    ],
    turnItems: items,
    visibleTurnItems: fixture.items,
    checkpoints: [
      {
        id: CheckpointId.make("checkpoint-1"),
        threadId: THREAD_ID,
        scopeId: CheckpointScopeId.make("scope-1"),
        runId: RUN_ID,
        nodeId: "node-1",
        parentCheckpointId: null,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        ref: CheckpointRef.make("refs/lecturn/checkpoint-1"),
        status: "ready",
        files: [{ path: "src/release.ts", kind: "modified", additions: 3, deletions: 1 }],
        capturedAt: time(4),
      },
    ],
  };
  fixture.summaries = [
    {
      checkpointId: CheckpointId.make("checkpoint-1"),
      scopeId: CheckpointScopeId.make("scope-1"),
      runId: RUN_ID,
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/lecturn/checkpoint-1"),
      status: "ready",
      files: [{ path: "src/release.ts", kind: "modified", additions: 3, deletions: 1 }],
      assistantMessageId: MessageId.make("assistant-1"),
      completedAt: "2026-10-01T12:00:04.000Z",
    },
  ];
  fixture.project = {
    id: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    title: "release-home",
    workspaceRoot: "/repo",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
  };
  fixture.environments = [
    {
      environmentId: ENVIRONMENT_ID,
      label: "Local",
      displayUrl: null,
      relayManaged: false,
      entry: { target: { label: "Local" } },
      connection: { phase: "connected", error: null, traceId: null },
      serverConfig: {
        environment: { capabilities: { threadForking: true } },
      },
    },
  ];
  fixture.providers = new Map([
    [
      ENVIRONMENT_ID,
      [
        {
          instanceId: INSTANCE_ID,
          driver: "codex",
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-10-01T12:00:00.000Z",
          conversationFork: "native",
          supportsConversationRollback: true,
          models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
          slashCommands: [],
          skills: [],
        },
      ],
    ],
  ]);
}

async function mount(controls?: ChatViewControls, draftId?: DraftId) {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;";
  const router = createRouter({
    routeTree: createRootRoute({
      component: () =>
        draftId ? (
          <ChatView
            environmentId={ENVIRONMENT_ID}
            threadId={THREAD_ID}
            routeKind="draft"
            draftId={draftId}
          />
        ) : (
          <ChatView
            environmentId={ENVIRONMENT_ID}
            threadId={THREAD_ID}
            routeKind="server"
            {...(controls ? { controls } : {})}
          />
        ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
    { container: host, router: false },
  );
}

/** Every control a user can reach in the mounted view, by accessible name. */
function interactiveNames(): string[] {
  const elements = [
    ...document.querySelectorAll<HTMLElement>(
      'button, a[href], input, textarea, select, [role="button"], [role="menuitem"], [role="combobox"], [contenteditable="true"]',
    ),
  ].filter((element) => element.checkVisibility() && !element.closest("[inert]"));
  return elements.map(
    (element) =>
      element.getAttribute("aria-label") ??
      element.getAttribute("data-slot") ??
      (element.textContent?.trim() || element.tagName),
  );
}

/** The controls the Squire allowlist names, as they render on this thread. */
function allowlistedControl(name: string): ChatViewControl | null {
  if (name === "Copy message" || name === "Copy prompt link") return "copy";
  if (name.startsWith("Worked for ")) return "turn-details";
  if (name.startsWith("Tool calls (")) return "expand";
  if (name === "Message" || name === "Expand composer") return "composer-text";
  if (name === "Send message") return "send";
  if (name === "Stop") return "stop";
  return null;
}

const DENIED_NAMES = new Set([
  "Fork from here",
  "Fork from this response",
  "Edit from here",
  "Open diff",
  "Expand all folders",
  "Permissions: Full access",
  "Attach files",
  "Toggle terminal drawer",
  "Toggle right panel",
  "Toggle thread details panel",
  "Thread actions for Release",
  "Previous turn",
  "Next turn",
]);

async function waitForTimeline() {
  await vi.waitFor(() => {
    const names = interactiveNames();
    expect(names).toContain("Send message");
    expect(names).toContain("Copy message");
  });
}

const SQUIRE_PLACEHOLDER = "Ask Release about anything it watches…";

describe("ChatView controls", () => {
  it("shows only the Squire allowlist on a home thread", async () => {
    seedHomeThread();
    await using _screen = await mount(SQUIRE_THREAD_CONTROLS);
    await waitForTimeline();

    const names = interactiveNames();
    // Unclassified means a control the allowlist does not name: an upstream addition lands here.
    expect(names.filter((name) => allowlistedControl(name) === null)).toEqual([]);
    const shown = new Set(names.map(allowlistedControl));
    expect([...shown].every((control) => SQUIRE_THREAD_CONTROLS.has(control!))).toBe(true);
    expect(shown).toEqual(new Set(["copy", "expand", "composer-text", "send"]));
    expect(names.filter((name) => DENIED_NAMES.has(name))).toEqual([]);
    // A wake that said nothing to the user leaves no row in the chat.
    expect(document.body.textContent).not.toContain("Squire update");
    expect(document.querySelector('[data-resting-block="mode"]')).toBeNull();
  });

  it("keeps today's controls when no allowlist is given", async () => {
    seedHomeThread();
    await using _screen = await mount();
    await waitForTimeline();

    const names = interactiveNames();
    for (const name of [
      "Fork from here",
      "Fork from this response",
      "Edit from here",
      "Open diff",
      "Permissions: Full access",
      "Toggle terminal drawer",
      "Toggle right panel",
      "Thread actions for Release",
    ]) {
      expect(names).toContain(name);
    }
    expect(names.some((name) => name.startsWith("Worked for "))).toBe(true);
    expect(document.body.textContent).toContain(
      "2 Squire events: pull-request-changed, turn-finished",
    );
  });

  it("prompts with the Squire's name on its home thread, with or without the allowlist", async () => {
    seedHomeThread();
    {
      await using _squireScreen = await mount(SQUIRE_THREAD_CONTROLS);
      await vi.waitFor(() => expect(document.body.innerHTML).toContain(SQUIRE_PLACEHOLDER));
    }

    seedHomeThread();
    fixture.shell = { ...(fixture.shell as object), squire: undefined };
    await using _screen = await mount();
    await waitForTimeline();
    expect(document.body.innerHTML).not.toContain(SQUIRE_PLACEHOLDER);
  });
});

describe("sends and pending approvals", () => {
  const THREAD_REF = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
  const PROVIDER = RuntimeRequestId.make("provider-approval");
  const APP_TOOL = RuntimeRequestId.make("app-tool-approval");
  const REDIRECT_PLACEHOLDER = "Send a message to decline and redirect the agent";
  const DRAFT = "Try the other migration";

  const approvalRequest = (id: RuntimeRequestId, second: number) => ({
    id,
    threadId: THREAD_ID,
    runId: RUN_2_ID,
    kind: "command",
    status: "pending",
    responseCapability: { type: "live" },
    createdAt: time(second),
    ...(id === APP_TOOL
      ? {
          connectedAppTool: {
            appId: "dev.rocketwright",
            appName: "RocketWright",
            toolName: "rw_simulate",
            reason: null,
            source: "static",
          },
        }
      : {}),
  });

  /** A plain thread with these approvals pending, oldest first, and the right panel open. */
  async function mountWithApprovals(requests: ReadonlyArray<RuntimeRequestId>) {
    seedHomeThread();
    fixture.shell = { ...(fixture.shell as object), squire: undefined };
    fixture.projection = {
      ...(fixture.projection as object),
      runtimeRequests: requests.map((id, index) => approvalRequest(id, 10 + index)),
    };
    const respondToApproval = vi.fn(async () => AsyncResult.success(undefined));
    fixture.respondToApproval = respondToApproval;
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "");
    useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
    useRightPanelStore.getState().openFile(THREAD_REF, "src/release.ts");
    const screen = await mount();
    await vi.waitFor(() => expect(sendAnnotationButton()).not.toBeNull());
    return { screen, respondToApproval };
  }

  function sendAnnotationButton() {
    return (
      [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Send annotation",
      ) ?? null
    );
  }

  /** The send control once the composer holds a draft, so only an approval can disable it. */
  async function sendButtonWithDraft() {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, DRAFT);
    await vi.waitFor(() => expect(document.body.textContent).toContain(DRAFT));
    return document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
  }

  const annotationKeptToast = expect.objectContaining({ title: "Annotation attached to draft" });

  it("keeps an annotation send from declining an app tool approval", async () => {
    const { screen, respondToApproval } = await mountWithApprovals([APP_TOOL]);
    await using _screen = screen;
    using add = vi.spyOn(toastManager, "add");

    sendAnnotationButton()!.click();

    await vi.waitFor(() => expect(add).toHaveBeenCalledWith(annotationKeptToast));
    expect(respondToApproval).not.toHaveBeenCalled();
  });

  it("blocks the send when an app tool waits behind a provider approval", async () => {
    const { screen, respondToApproval } = await mountWithApprovals([PROVIDER, APP_TOOL]);
    await using _screen = screen;
    using add = vi.spyOn(toastManager, "add");

    // The provider approval asks on its timeline row, so the card above is the app tool's.
    expect(document.body.innerHTML).toContain(APP_TOOL_APPROVAL_SEND_BLOCK_REASON);
    expect(document.body.innerHTML).not.toContain(REDIRECT_PLACEHOLDER);
    expect((await sendButtonWithDraft()).disabled).toBe(true);

    sendAnnotationButton()!.click();

    await vi.waitFor(() => expect(add).toHaveBeenCalledWith(annotationKeptToast));
    expect(respondToApproval).not.toHaveBeenCalled();
  });

  it("blocks the send the same way when the app tool arrived first", async () => {
    const { screen, respondToApproval } = await mountWithApprovals([APP_TOOL, PROVIDER]);
    await using _screen = screen;

    expect(document.body.innerHTML).not.toContain(REDIRECT_PLACEHOLDER);
    expect((await sendButtonWithDraft()).disabled).toBe(true);
    expect(respondToApproval).not.toHaveBeenCalled();
  });

  it("still declines and redirects when only provider approvals are pending", async () => {
    const { screen, respondToApproval } = await mountWithApprovals([PROVIDER]);
    await using _screen = screen;

    expect(document.body.innerHTML).toContain(REDIRECT_PLACEHOLDER);
    const send = await sendButtonWithDraft();
    expect(send.disabled).toBe(false);

    send.click();

    await vi.waitFor(() => expect(respondToApproval).toHaveBeenCalledWith(PROVIDER, "decline"));
  });

  it("still declines a provider approval for an annotation send", async () => {
    const { screen, respondToApproval } = await mountWithApprovals([PROVIDER]);
    await using _screen = screen;

    sendAnnotationButton()!.click();

    await vi.waitFor(() => expect(respondToApproval).toHaveBeenCalledWith(PROVIDER, "decline"));
  });
});

describe("Contextual on a sent draft", () => {
  it("reads the thread's Contextual status once the server has the thread", async () => {
    seedHomeThread();
    const shell = { ...(fixture.shell as object), squire: undefined };
    const projection = fixture.projection;
    const threadRef = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
    const draftId = DraftId.make("draft-contextual");
    // The sent draft renders as its thread before the server has created it.
    fixture.contextual = true;
    fixture.shell = null;
    fixture.projection = null;
    const drafts = useComposerDraftStore.getState();
    drafts.setProjectDraftThreadId(
      { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
      draftId,
      { threadId: THREAD_ID },
    );
    drafts.markDraftThreadPromoting(draftId, threadRef);
    await using _screen = await mount();
    const control = () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Contextual off"]');
    await vi.waitFor(() => expect(control()).not.toBeNull());

    fixture.shell = shell;
    fixture.projection = projection;
    finalizePromotedDraftThreadByRef(threadRef);

    await vi.waitFor(() => expect(control()?.disabled).toBe(false));
  });
});

describe("chat surface background", () => {
  const TRANSPARENT = "rgba(0, 0, 0, 0)";
  // MessagesTimeline's empty-pane placeholder, not the loading conversation area around it.
  const timelinePlaceholder = () =>
    document.querySelector<HTMLElement>(
      '[data-timeline-loading="true"]:not(:has([data-timeline-loading]))',
    );
  const surface = () => document.querySelector<HTMLElement>(".lecturn-chat-surface")!;
  const isOpaque = (color: string) =>
    color !== TRANSPARENT && !/rgba\(.*,\s*0?\.\d+\)|\/\s*0?\.\d+\)/.test(color);

  it("shows the night sky behind a new thread's draft hero", async () => {
    seedHomeThread();
    fixture.shell = null;
    fixture.projection = null;
    fixture.items = [];
    const draftId = DraftId.make("draft-background");
    const drafts = useComposerDraftStore.getState();
    drafts.setProjectDraftThreadId(
      { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
      draftId,
      { threadId: THREAD_ID },
    );
    using _draft = { [Symbol.dispose]: () => drafts.clearDraftThread(draftId) };
    await using _screen = await mount(undefined, draftId);
    await vi.waitFor(() => expect(timelinePlaceholder()).not.toBeNull());

    expect(surface().dataset.chatHasMessages).toBeUndefined();
    expect(getComputedStyle(timelinePlaceholder()!).backgroundColor).toBe(TRANSPARENT);
    expect(getComputedStyle(surface()).backgroundImage).toContain("lecturn-night-sky");
  });

  it("keeps an opaque theme surface behind a huge thread that is still loading", async () => {
    seedHomeThread();
    fixture.shell = { ...(fixture.shell as object), squire: undefined };
    fixture.projection = null;
    fixture.items = [];
    fixture.threadStatus = "synchronizing";
    // Earlier tests opened this thread; a remembered timeline would stand in for the placeholder.
    resetHeldThreadTimeline();
    await using _screen = await mount();
    const pane = () =>
      timelinePlaceholder()?.parentElement?.closest<HTMLElement>("[data-timeline-loading]");
    await vi.waitFor(() => expect(pane()).toBeTruthy());

    expect(timelinePlaceholder()!.getBoundingClientRect().height).toBe(
      pane()!.getBoundingClientRect().height,
    );
    expect(isOpaque(getComputedStyle(surface()).backgroundColor)).toBe(true);
  });
});
