import type { EmbedHostCommand } from "@lecturn/client-runtime/embed/guest";
import { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import "../../embed/embed.css";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  threads: [] as Array<Record<string, unknown>>,
  projection: null as unknown,
  visibleItems: [] as unknown[],
  describe: null as null | ((refs: ReadonlyArray<string>) => Promise<Record<string, string>>),
  describeCalls: [] as Array<ReadonlyArray<string>>,
  appContext: null as unknown,
  commandListener: null as ((command: unknown) => void) | null,
  bridgeCalls: [] as Array<[string, unknown]>,
  boundCommands: [] as unknown[],
  commandCalls: [] as unknown[],
  navigations: [] as unknown[],
  composerCalls: [] as Array<[string, unknown]>,
  shownThreads: [] as string[],
}));

vi.mock(import("../../embed/bridge"), async (original) => {
  const bridge = {
    subscribeHostCommands: (listener: (command: unknown) => void) => {
      state.commandListener = listener;
      return () => {
        state.commandListener = null;
      };
    },
    reportThread: (threadId: unknown) => state.bridgeCalls.push(["thread", threadId]),
    reportTurnState: () => undefined,
    reportReady: (threadId: unknown) => state.bridgeCalls.push(["ready", threadId]),
    navigate: (ref: unknown) => state.bridgeCalls.push(["navigate", ref]),
    openLink: async (url: unknown) => {
      state.bridgeCalls.push(["openLink", url]);
    },
    authorizeHost: (origins: unknown) => state.bridgeCalls.push(["authorize", origins]),
    describeRefs: (refs: ReadonlyArray<string>) => {
      state.describeCalls.push(refs);
      return state.describe === null ? Promise.resolve({}) : state.describe(refs);
    },
  };
  return {
    ...(await original()),
    startEmbedBridge: (() => bridge) as never,
    readEmbedBridge: (() => bridge) as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShellsForProjectRefs: (() => state.threads) as never,
  useQuietThreadShell: (() => null) as never,
  useThreadProjection: (() =>
    state.projection === null ? null : { projection: state.projection }) as never,
  useThreadVisibleTurnItems: (() => state.visibleItems) as never,
}));
vi.mock(import("../../state/apps"), async (original) => ({
  ...(await original()),
  useAppEmbedContext: (() => state.appContext) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: unknown) => {
    state.boundCommands.push(command);
    return async (value: unknown) => {
      state.commandCalls.push(value);
      return { _tag: "Success", value: { threadId: "thread-new" } };
    };
  }) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => async (options: unknown) => {
    state.navigations.push(options);
  }) as never,
}));
// The thread view itself is out of scope; this stand-in owns the composer handle as ChatView does.
vi.mock(import("../ChatView"), async () => {
  const { useComposerHandleContext } = await import("../../composerHandleContext");
  const { AppRefChip } = await import("./AppRefChip");
  return {
    default: (({ threadId }: { threadId: string }) => {
      const handle = useComposerHandleContext();
      if (handle) {
        handle.current = {
          insertMention: (mention: unknown) => state.composerCalls.push(["insertMention", mention]),
          setDraft: (text: unknown) => state.composerCalls.push(["setDraft", text]),
        } as never;
      }
      state.shownThreads.push(threadId);
      return (
        <div data-testid="chat-view">
          <AppRefChip reference="rw:c/fins" />
          <AppRefChip reference="rw:cfg/baseline" />
          <div data-chat-composer-overlay="true">composer</div>
        </div>
      );
    }) as never,
  };
});

// The panel's own reads are covered by EmbedProvidersPanel.logic.test.ts; here it only needs its way back.
vi.mock(import("./EmbedProvidersPanel"), () => ({
  EmbedProvidersPanel: (({ onBack }: { onBack: () => void }) => (
    <button type="button" data-testid="providers-back" onClick={onBack}>
      Back to chat
    </button>
  )) as never,
}));

import { appReferenceContextRecords } from "@lecturn/shared/appReferences";

import { appsEnvironment } from "../../state/apps";
import { __resetAppRefLabelsForTests } from "./appRefLabels";
import { EmbedView } from "./EmbedView";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const appContext = {
  appId: "dev.example.app",
  name: "Example",
  iconDataUrl: "data:image/png;base64,AAAA",
  refPrefixes: ["rw:"],
  openUrlTemplate: null,
  live: null,
  state: "granted",
  embedOrigins: ["http://127.0.0.1:*"],
};
const shell = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Thread ${id}`,
  updatedAt,
  archivedAt: null,
  deletedAt: null,
  source: {},
  ...extra,
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(state, {
    threads: [shell("thread-1", "2026-10-25T01:00:00.000Z")],
    projection: null,
    visibleItems: [],
    describe: null,
    describeCalls: [],
    appContext,
    commandListener: null,
    bridgeCalls: [],
    boundCommands: [],
    commandCalls: [],
    navigations: [],
    composerCalls: [],
    shownThreads: [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetAppRefLabelsForTests();
  vi.unstubAllGlobals();
});

const render = (
  props: { threadId?: string | null; switcher?: boolean; panel?: "providers" | null } = {},
) =>
  act(async () =>
    root.render(
      <EmbedView
        environmentId={environmentId}
        projectId={projectId}
        threadId={props.threadId ? ThreadId.make(props.threadId) : null}
        panel={props.panel ?? null}
        switcher={props.switcher ?? false}
      />,
    ),
  );
const chipText = (ref: string) =>
  container.querySelector(`[data-app-ref="${ref}"]`)?.textContent ?? null;
const sentMessage = (labels: ReadonlyArray<{ ref: string; label: string }>) => ({
  item: {
    type: "user_message",
    text: labels.map((entry) => entry.ref).join(" "),
    context: { version: 1, records: appReferenceContextRecords(labels) },
  },
});
const hostSends = (command: EmbedHostCommand) =>
  act(async () => {
    state.commandListener?.(command);
  });

describe("EmbedView", () => {
  it("creates a host's new thread on the server with its appData, then shows that thread", async () => {
    await render({ threadId: "thread-1" });
    await hostSends({
      method: "lecturn/thread.new",
      params: { title: "Fin study", appData: '{"doc":"fins"}' },
    });

    // The one command the view can run is the server-side create; it never creates a thread itself.
    expect(
      state.boundCommands.every((command) => command === appsEnvironment.createEmbedThread),
    ).toBe(true);
    expect(state.commandCalls).toEqual([
      { environmentId, input: { title: "Fin study", appData: '{"doc":"fins"}', projectId } },
    ]);
    expect(state.navigations).toEqual([
      {
        to: "/embed/$environmentId/$projectId/$threadId",
        params: { environmentId, projectId, threadId: "thread-new" },
      },
    ]);

    // The server's shell for the new thread carries the appData; the route then shows it.
    state.threads = [
      shell("thread-new", "2026-10-25T02:00:00.000Z", { appData: '{"doc":"fins"}' }),
      ...state.threads,
    ];
    await render({ threadId: "thread-new" });
    expect(state.shownThreads.at(-1)).toBe("thread-new");
  });

  it("hands mentions and drafts to the composer on screen", async () => {
    await render({ threadId: "thread-1" });
    await hostSends({
      method: "lecturn/composer.insertMention",
      params: { ref: "rw:c/fins", label: "Fins" },
    });
    await hostSends({ method: "lecturn/composer.setDraft", params: { text: "Check the fins" } });
    expect(state.composerCalls).toEqual([
      ["insertMention", { ref: "rw:c/fins", label: "Fins" }],
      ["setDraft", "Check the fins"],
    ]);
  });

  it("opens the thread a host names", async () => {
    await render({ threadId: "thread-1" });
    await hostSends({ method: "lecturn/thread.open", params: { threadId: "thread-7" } });
    expect(state.navigations).toEqual([
      {
        to: "/embed/$environmentId/$projectId/$threadId",
        params: { environmentId, projectId, threadId: "thread-7" },
      },
    ]);
  });

  it("opens the host's parent once the app's origins are known, and reports ready once loaded", async () => {
    state.appContext = null;
    await render({ threadId: "thread-1" });
    expect(state.bridgeCalls.filter(([kind]) => kind === "authorize")).toEqual([]);
    expect(state.bridgeCalls.filter(([kind]) => kind === "ready")).toEqual([]);

    // The mocked hooks do not subscribe, so the loaded state needs a fresh mount to be read.
    await act(async () => root.unmount());
    root = createRoot(container);
    state.appContext = appContext;
    state.projection = { runtimeRequests: [], turnItems: [] };
    await render({ threadId: "thread-1" });
    expect(state.bridgeCalls).toContainEqual(["authorize", ["http://127.0.0.1:*"]]);
    expect(state.bridgeCalls).toContainEqual(["ready", "thread-1"]);
  });

  it("hands an activated reference in the thread to the host", async () => {
    await render({ threadId: "thread-1" });
    const chip = container.querySelector<HTMLButtonElement>('button[data-app-ref="rw:c/fins"]');
    await act(async () => chip?.click());
    expect(state.bridgeCalls).toContainEqual(["navigate", "rw:c/fins"]);
  });

  it("swaps the chat for the providers panel the host opens, then returns to the thread the user left", async () => {
    state.threads = [
      shell("thread-1", "2026-10-25T01:00:00.000Z"),
      shell("thread-latest", "2026-10-25T03:00:00.000Z"),
    ];
    await render({ threadId: "thread-1", switcher: true });
    await hostSends({ method: "lecturn/providers.open", params: {} });
    expect(state.navigations).toEqual([
      { to: "/embed/$environmentId/$projectId/providers", params: { environmentId, projectId } },
    ]);

    await render({ threadId: null, panel: "providers", switcher: true });
    expect(container.querySelector('[data-testid="chat-view"]')).toBeNull();
    expect(container.textContent).not.toContain("New thread");
    // The panel's route names no thread; the host must not hear that the latest one is showing.
    expect(state.bridgeCalls.findLast(([kind]) => kind === "thread")).toEqual([
      "thread",
      "thread-1",
    ]);

    const back = container.querySelector<HTMLButtonElement>('[data-testid="providers-back"]');
    await act(async () => back?.click());
    expect(state.navigations.at(-1)).toEqual({
      to: "/embed/$environmentId/$projectId/$threadId",
      params: { environmentId, projectId, threadId: "thread-1" },
    });
  });

  it("shows a thread continued in Lecturn read-only, with the way to its copy", async () => {
    state.threads = [
      shell("thread-1", "2026-10-25T01:00:00.000Z", {
        source: {
          continuedIn: {
            environmentId: "env-user",
            threadId: "copy-1",
            copiedAt: "2026-10-25T02:00:00.000Z",
          },
        },
      }),
      shell("thread-2", "2026-10-25T00:00:00.000Z"),
    ];
    await render({ threadId: "thread-1" });
    expect(state.shownThreads.at(-1)).toBe("thread-1");
    expect(container.textContent).toContain("Continued in Lecturn");
    const composer = () =>
      container.querySelector<HTMLElement>('[data-chat-composer-overlay="true"]')!;
    expect(getComputedStyle(composer()).display).toBe("none");

    const link = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
      (anchor) => anchor.textContent === "Open in Lecturn",
    );
    await act(async () => link?.click());
    expect(state.bridgeCalls).toContainEqual([
      "openLink",
      "lecturn://apps/dev.example.app/threads/env-user/copy-1",
    ]);
    // A host's draft has no composer to land in.
    await hostSends({ method: "lecturn/composer.setDraft", params: { text: "More fins" } });
    expect(state.composerCalls).toEqual([]);

    await render({ threadId: "thread-2" });
    expect(container.textContent).not.toContain("Continued in Lecturn");
    expect(getComputedStyle(composer()).display).not.toBe("none");
  });

  it("shows the switcher unless the host lists threads itself, and falls back to the latest thread", async () => {
    state.threads = [
      shell("thread-old", "2026-10-25T00:00:00.000Z"),
      shell("thread-latest", "2026-10-25T03:00:00.000Z"),
      shell("thread-gone", "2026-10-25T04:00:00.000Z", { archivedAt: "2026-10-25T05:00:00.000Z" }),
    ];
    await render({ threadId: null, switcher: false });
    expect(container.textContent).not.toContain("New thread");
    expect(state.shownThreads.at(-1)).toBe("thread-latest");

    await render({ threadId: null, switcher: true });
    expect(container.textContent).toContain("New thread");
    expect(container.textContent).toContain("Thread thread-latest");
  });

  it("names the thread's references through the host, asking once for all the chips on screen", async () => {
    state.describe = async () => ({ "rw:c/fins": "Fins", "rw:cfg/baseline": "Baseline config" });
    await render({ threadId: "thread-1" });
    expect(state.describeCalls).toEqual([["rw:c/fins", "rw:cfg/baseline"]]);
    expect(chipText("rw:c/fins")).toBe("Fins");
    expect(chipText("rw:cfg/baseline")).toBe("Baseline config");

    // The answer is kept for the thread: a re-render asks nothing more.
    await render({ threadId: "thread-1" });
    expect(state.describeCalls).toHaveLength(1);
    // Clicking a named chip still hands the host the reference itself.
    const chip = container.querySelector<HTMLButtonElement>('button[data-app-ref="rw:c/fins"]');
    await act(async () => chip?.click());
    expect(state.bridgeCalls).toContainEqual(["navigate", "rw:c/fins"]);
  });

  it("shows the label a sent chip stored, and asks the host only about the rest", async () => {
    state.visibleItems = [sentMessage([{ ref: "rw:c/fins", label: "Fins" }])];
    state.describe = async () => ({});
    await render({ threadId: "thread-1" });
    expect(chipText("rw:c/fins")).toBe("Fins");
    expect(state.describeCalls).toEqual([["rw:cfg/baseline"]]);
    // A reference the host has no name for stays as written.
    expect(chipText("rw:cfg/baseline")).toBe("rw:cfg/baseline");
  });

  it("falls back to the reference itself when the host cannot answer", async () => {
    state.describe = () => Promise.reject(new Error("Unknown method lecturn/appRefs.describe."));
    await render({ threadId: "thread-1" });
    expect(state.describeCalls).toHaveLength(1);
    expect(chipText("rw:c/fins")).toBe("rw:c/fins");
    expect(chipText("rw:cfg/baseline")).toBe("rw:cfg/baseline");
  });
});
