import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  summaries: [] as unknown[],
  project: null as unknown,
  environments: [] as unknown[],
  providers: new Map<string, unknown>(),
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((ref: unknown) => (ref === null ? null : fixture.shell)) as never,
  useThreadShell: ((ref: unknown) => (ref === null ? null : fixture.shell)) as never,
  useThreadProjection: ((ref: unknown) =>
    ref === null || fixture.projection === null
      ? null
      : { projection: fixture.projection }) as never,
  useThreadVisibleTurnItems: ((ref: unknown) => (ref === null ? [] : fixture.items)) as never,
  useThreadCheckpointSummaries: ((ref: unknown) =>
    ref === null ? [] : fixture.summaries) as never,
  useThreadStatus: (() => "live") as never,
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

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { makeThreadFixture, makeThreadProjectionFixture } from "../../test-fixtures";
import ChatView from "../ChatView";
import {
  SQUIRE_THREAD_CONTROLS,
  type ChatViewControl,
  type ChatViewControls,
} from "./chatViewControls";

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

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(controls?: ChatViewControls) {
  host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;";
  document.body.append(host);
  root = createRoot(host);
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
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
  await act(async () => {
    root!.render(
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

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
  "Runtime mode",
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
    await mount(SQUIRE_THREAD_CONTROLS);
    await waitForTimeline();

    const names = interactiveNames();
    // Unclassified means a control the allowlist does not name: an upstream addition lands here.
    expect(names.filter((name) => allowlistedControl(name) === null)).toEqual([]);
    const shown = new Set(names.map(allowlistedControl));
    expect([...shown].every((control) => SQUIRE_THREAD_CONTROLS.has(control!))).toBe(true);
    expect(shown).toEqual(new Set(["copy", "expand", "composer-text", "send"]));
    expect(names.filter((name) => DENIED_NAMES.has(name))).toEqual([]);
    expect(document.body.textContent).toContain(
      "Squire update · 2 events: pull request changed, turn finished",
    );
    expect(document.querySelector('[data-resting-block="mode"]')).toBeNull();
  });

  it("keeps today's controls when no allowlist is given", async () => {
    seedHomeThread();
    await mount();
    await waitForTimeline();

    const names = interactiveNames();
    for (const name of [
      "Fork from here",
      "Fork from this response",
      "Edit from here",
      "Open diff",
      "Runtime mode",
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
    await mount(SQUIRE_THREAD_CONTROLS);
    await vi.waitFor(() => expect(document.body.innerHTML).toContain(SQUIRE_PLACEHOLDER));
    await act(async () => root?.unmount());
    host?.remove();

    seedHomeThread();
    fixture.shell = { ...(fixture.shell as object), squire: undefined };
    await mount();
    await waitForTimeline();
    expect(document.body.innerHTML).not.toContain(SQUIRE_PLACEHOLDER);
  });
});
