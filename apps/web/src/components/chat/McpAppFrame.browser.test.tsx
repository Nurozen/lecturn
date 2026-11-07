import { EnvironmentId, ThreadId, TurnItemId } from "@lecturn/contracts";
import { LECTURN_MCP_APP_SERVER } from "@lecturn/shared/toolOutput";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import showcaseTemplate from "../../../../server/src/squire/showcase/template.html?raw";

// The app asks for full screen from its button. It also focuses its own frame
// and asks on load, right after it is told it left full screen, and whenever
// it loses focus while inline. It reports each answer to the page with a
// message the host ignores.
const APP_HTML = `<!doctype html><button>Open full screen</button><script>
let nextId = 0;
const pending = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    nextId += 1;
    pending.set(nextId, resolve);
    parent.postMessage({ jsonrpc: "2.0", id: nextId, method, params }, "*");
  });
let mode = "inline";
const askFullscreen = async (source) => {
  const answer = await request("ui/request-display-mode", { mode: "fullscreen" });
  mode = answer.mode;
  parent.postMessage({ probe: source + ":" + answer.mode }, "*");
};
const button = document.querySelector("button");
button.onclick = () => askFullscreen("tap");
const refocusAndAsk = (source) => {
  button.focus();
  void askFullscreen(source);
};
addEventListener("message", ({ data }) => {
  if (data === "retry") return refocusAndAsk("retry");
  if (pending.has(data.id)) {
    pending.get(data.id)(data.result);
    pending.delete(data.id);
    return;
  }
  if (data.method !== "ui/notifications/host-context-changed") return;
  const left = mode === "fullscreen" && data.params.displayMode === "inline";
  mode = data.params.displayMode ?? mode;
  if (left) refocusAndAsk("exit");
});
// Focus can only be taken back once the browser has finished moving it away.
addEventListener("blur", () => {
  if (mode === "inline") setTimeout(() => refocusAndAsk("blur"));
});
void request("ui/initialize", { protocolVersion: "2026-01-26", appCapabilities: {} }).then(() => {
  parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
  refocusAndAsk("load");
});
</script>`;

// The Squire showcase as published: the shipped template with one data block filled.
const SHOWCASE_HTML = showcaseTemplate.replace(
  "{{SQUIRE_SHOWCASE_DATA}}",
  JSON.stringify({
    templateVersion: 7,
    generatedAt: "2026-11-01T12:00:00.000Z",
    lead: { name: "Mira", still: null },
    counts: {
      needsDecision: 1,
      steers: 0,
      openQuestions: 0,
      overlaps: 1,
      proposals: 0,
      threadsWatched: 2,
    },
    threads: [
      { id: "t1", title: "Billing retries", project: "api", pr: null },
      { id: "t2", title: "Ledger export", project: "api", pr: null },
    ],
    files: [
      {
        key: "p:src/ledger.ts",
        path: "src/ledger.ts",
        project: "api",
        threads: ["t1", "t2"],
        shared: true,
      },
    ],
    edges: [],
    items: [
      {
        id: "card:1",
        kind: "overlap",
        title: "Both threads edit src/ledger.ts",
        outcome: null,
        why: null,
        thread: null,
        squire: "Lead",
        owner: "Lead",
        link: null,
        actions: [],
      },
    ],
  }),
);
let appHtml = APP_HTML;

vi.mock(import("../../assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: (() => ({
    _tag: "Success",
    url: `data:text/html,${encodeURIComponent(appHtml)}`,
    expiresAt: Date.now() + 60 * 60_000,
  })) as never,
  useAssetUrlRefresh: (() => async () => null) as never,
}));
vi.mock(import("../../state/queries"), async (original) => ({
  ...(await original()),
  useTurnItemDetail: (() => ({ data: undefined })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => async () => ({ _tag: "Failure", cause: undefined })) as never,
}));
vi.mock(import("../../hooks/useHtmlRenderTheme"), async (original) => ({
  ...(await original()),
  useHtmlRenderTheme: (() => ({ appearance: "light", variables: {} })) as never,
}));

import { render as renderUi } from "../../../test/render";
import { McpAppFrame } from "./McpAppFrame";

// Playwright evaluates with a user gesture, and the provider evaluates when the first vi.mock
// registers, so this file starts with activation no one gave the page until it lapses.
const idlePage = () =>
  vi.waitFor(() => expect(navigator.userActivation.isActive).toBe(false), { timeout: 10_000 });

function setup() {
  let skew = 0;
  appHtml = APP_HTML;
  // Advance the host cooldown without manufacturing browser user activation.
  const now = performance.now.bind(performance);
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + skew);
  const answers: string[] = [];
  let answered: (() => void) | undefined;
  const onProbe = (event: MessageEvent) => {
    const probe = (event.data as { readonly probe?: unknown } | null)?.probe;
    if (typeof probe !== "string") return;
    answers.push(probe);
    answered?.();
  };
  window.addEventListener("message", onProbe);
  const nextAnswer = async (action: () => Promise<unknown>) => {
    const seen = answers.length;
    const answer = new Promise<string>((resolve) => {
      answered = () => {
        if (answers.length > seen) resolve(answers[seen]!);
      };
    });
    await action();
    return answer;
  };

  const isFullscreen = () => document.querySelector("[data-mcp-app-fullscreen]") !== null;

  const renderApp = async (server = "srv", tool = "show") => {
    return renderUi(
      <McpAppFrame
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("thread")}
        conversationThreadId={ThreadId.make("thread")}
        itemId={TurnItemId.make("item")}
        revision="1"
        app={{ attachmentId: "app", server, tool, resourceUri: `ui://${server}/app` }}
        onSendMessage={undefined}
      />,
    );
  };

  const retry = () =>
    nextAnswer(async () => {
      document.querySelector("iframe")!.contentWindow!.postMessage("retry", "*");
    });

  return {
    renderApp,
    nextAnswer,
    retry,
    isFullscreen,
    advance: (ms: number) => {
      skew += ms;
    },
    [Symbol.dispose]() {
      window.removeEventListener("message", onProbe);
      clock.mockRestore();
    },
  };
}

it("keeps load and idle retries inline even after the page-input cooldown", async () => {
  await idlePage();
  using fixture = setup();
  await using screens = new AsyncDisposableStack();
  const { renderApp, nextAnswer, retry, isFullscreen, advance } = fixture;
  expect(
    await nextAnswer(async () => {
      screens.use(await renderApp());
    }),
  ).toBe("load:inline");
  advance(5_000);
  expect(await retry()).toBe("retry:inline");
  expect(await retry()).toBe("retry:inline");
  expect(isFullscreen()).toBe(false);
});

it("allows an app click immediately after loading on an idle page", async () => {
  await idlePage();
  using fixture = setup();
  await using screens = new AsyncDisposableStack();
  const { renderApp, nextAnswer, isFullscreen } = fixture;
  expect(
    await nextAnswer(async () => {
      screens.use(await renderApp());
    }),
  ).toBe("load:inline");
  const appButton = page
    .frameLocator(page.getByTitle("srv app"))
    .getByRole("button", { name: "Open full screen" });
  expect(await nextAnswer(() => userEvent.click(appButton))).toBe("tap:fullscreen");
  expect(isFullscreen()).toBe(true);
});

it("opens full screen only from a tap in the app, never from activation the page got elsewhere", async () => {
  using fixture = setup();
  await using screens = new AsyncDisposableStack();
  const { renderApp, nextAnswer, isFullscreen, advance } = fixture;
  const appButton = page
    .frameLocator(page.getByTitle("srv app"))
    .getByRole("button", { name: "Open full screen" });
  const elsewhere = document.body.appendChild(document.createElement("button"));
  using _elsewhere = { [Symbol.dispose]: () => elsewhere.remove() };
  elsewhere.textContent = "Elsewhere";
  const tapApp = async () => {
    advance(5_000);
    expect(await nextAnswer(() => userEvent.click(appButton))).toBe("tap:fullscreen");
    expect(isFullscreen()).toBe(true);
  };

  // The click that opens a thread still activates the page as its app loads.
  const load = nextAnswer(async () => {
    await userEvent.click(elsewhere);
    screens.use(await renderApp());
  });
  expect(await load).toBe("load:inline");
  expect(isFullscreen()).toBe(false);

  await tapApp();
  const exit = page.getByRole("button", { name: "Exit full screen" });
  expect(await nextAnswer(() => userEvent.click(exit))).toBe("exit:inline");
  expect(isFullscreen()).toBe(false);

  advance(5_000);
  expect(await nextAnswer(() => userEvent.click(elsewhere))).toBe("blur:inline");
  expect(isFullscreen()).toBe(false);

  // Escape activates nothing, but the tap that opened full screen still does.
  await tapApp();
  (await exit.element()).focus();
  expect(await nextAnswer(() => userEvent.keyboard("{Escape}"))).toBe("exit:inline");
  expect(isFullscreen()).toBe(false);
});

it("holds a connected app's card to the same tap-only full screen", async () => {
  using fixture = setup();
  await using screens = new AsyncDisposableStack();
  const { renderApp, nextAnswer, isFullscreen, advance } = fixture;
  const elsewhere = document.body.appendChild(document.createElement("button"));
  using _elsewhere = { [Symbol.dispose]: () => elsewhere.remove() };
  elsewhere.textContent = "Elsewhere";
  const load = nextAnswer(async () => {
    await userEvent.click(elsewhere);
    screens.use(await renderApp(LECTURN_MCP_APP_SERVER));
  });
  expect(await load).toBe("load:inline");
  expect(isFullscreen()).toBe(false);

  advance(5_000);
  const appButton = page
    .frameLocator(page.getByTitle(`${LECTURN_MCP_APP_SERVER} app`))
    .getByRole("button", { name: "Open full screen" });
  expect(await nextAnswer(() => userEvent.click(appButton))).toBe("tap:fullscreen");
  expect(isFullscreen()).toBe(true);
});

it("opens the Squire showcase full size from its Expand button, and back to its summary", async () => {
  using fixture = setup();
  const { renderApp, isFullscreen, advance } = fixture;
  appHtml = SHOWCASE_HTML;
  await using _screen = await renderApp(LECTURN_MCP_APP_SERVER, "squire_publish_showcase");
  const app = page.frameLocator(page.getByTitle(`${LECTURN_MCP_APP_SERVER} app`));
  const cardHeight = () =>
    document.querySelector<HTMLElement>("[data-testid=mcp-app-card]")!.offsetHeight;
  // Inline, the card is its header, counts, and Expand: the map and items wait for full size.
  await vi.waitFor(() => expect(cardHeight()).not.toBe(320));
  const compact = cardHeight();
  expect(compact).toBeLessThan(400);

  // Past the cooldown on activation the page may already hold.
  advance(5_000);
  await userEvent.click(app.getByRole("button", { name: "Expand" }));
  await vi.waitFor(() => expect(isFullscreen()).toBe(true));
  // Clicking waits for the item to be visible, which it is only at full size.
  await userEvent.click(app.getByText("Both threads edit src/ledger.ts"));

  await userEvent.click(page.getByRole("button", { name: "Exit full screen" }));
  expect(isFullscreen()).toBe(false);
  await vi.waitFor(() => expect(cardHeight()).toBe(compact));
});
