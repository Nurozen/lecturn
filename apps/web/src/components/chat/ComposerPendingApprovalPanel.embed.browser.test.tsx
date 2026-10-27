import "../../index.css";
import "../../embed/embed.css";
import "../../embed/embedComposer.css";

import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import { AppId, EnvironmentId, ProjectId, RuntimeRequestId } from "@lecturn/contracts";
import { ShieldIcon } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { EmbedPresentationContext } from "../../embed/EmbedPresentationContext";
import { applyEmbedThemeToRoot } from "../../embed/embedTheme";
import type { PendingApproval } from "../../session-logic";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerSurface } from "./ComposerSurface";

const presentation = {
  projectRef: scopeProjectRef(EnvironmentId.make("env-1"), ProjectId.make("project-1")),
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete document.documentElement.dataset.lecturnEmbed;
  applyEmbedThemeToRoot(document.documentElement, { appearance: "light", variables: {} });
  delete document.documentElement.dataset.lecturnEmbed;
  document.documentElement.style.removeProperty("color-scheme");
  vi.unstubAllGlobals();
});

const options: NonNullable<PendingApproval["options"]> = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Approve" },
  { decision: "cancel", label: "Cancel" },
];

const approval: PendingApproval = {
  requestId: RuntimeRequestId.make("approval-1"),
  requestKind: "permission",
  createdAt: "2026-10-25T00:00:00.000Z",
  responseCapability: "live",
  options,
  connectedAppTool: {
    appId: AppId.make("dev.rocketwright"),
    appName: "RocketWright",
    toolName: "rw_engine_simulate",
    reason: "Duration not set: a full motor burn",
    source: "app",
  },
};

const LONG_REASON =
  "engine_simulate duration not set, so it defaults to a full burn of the selected motor; " +
  "a liquid engine may run for several minutes before the result card renders.";

const withReason = (reason: string): PendingApproval => ({
  ...approval,
  connectedAppTool: { ...approval.connectedAppTool!, reason },
});

const commandApproval: PendingApproval = {
  requestId: RuntimeRequestId.make("approval-2"),
  requestKind: "command",
  createdAt: "2026-10-25T00:00:00.000Z",
  responseCapability: "live",
  detail: "vp test run apps/web/src/components/chat",
  options,
};

// The computed family of each Tailwind font utility, for telling prose from code.
function fontFamilyOf(utility: "font-sans" | "font-mono") {
  const probe = document.createElement("span");
  probe.className = utility;
  container.append(probe);
  const family = getComputedStyle(probe).fontFamily;
  probe.remove();
  return family;
}

// The composer as ChatView and ChatComposer nest it while an approval is pending: the card is the
// top drawer in the banner dock, and the composer's main surface follows it.
async function render(
  width: number,
  embedded = true,
  onStopTurn?: () => void,
  shown: PendingApproval = approval,
) {
  // The pane is the embed's whole viewport, so the phone breakpoints apply as they do there.
  await page.viewport(width, 800);
  if (embedded) document.documentElement.dataset.lecturnEmbed = "";
  container.style.width = `${width}px`;
  const composer = (
    <ComposerSurface.Shell>
      <ComposerSurface.Host>
        <div className="relative z-10">
          <div data-chat-composer-form="true" className="mx-auto w-full min-w-0">
            <ComposerBanner.Dock>
              <ComposerBanner.Column>
                <ComposerBanner.Attachment>
                  <ComposerBanner.Root
                    data-chat-composer-top-drawer="true"
                    variant="warning"
                    density="spacious"
                  >
                    <ComposerBanner.Row layout="approval" data-testid="card-row">
                      <ComposerBanner.Icon>
                        <ShieldIcon />
                      </ComposerBanner.Icon>
                      <ComposerBanner.Content>
                        <ComposerPendingApprovalPanel approval={shown} pendingCount={1} />
                      </ComposerBanner.Content>
                      <ComposerBanner.Actions>
                        <ComposerPendingApprovalActions
                          requestId={shown.requestId}
                          canRespond
                          isResponding={false}
                          options={shown.options}
                          onStopTurn={onStopTurn}
                          onRespondToApproval={async () => undefined}
                        />
                      </ComposerBanner.Actions>
                    </ComposerBanner.Row>
                  </ComposerBanner.Root>
                </ComposerBanner.Attachment>
              </ComposerBanner.Column>
            </ComposerBanner.Dock>
            <div className="relative">
              <ComposerSurface.Main>
                <div data-testid="composer-body" className="h-32" />
              </ComposerSurface.Main>
            </div>
          </div>
        </div>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>
  );
  await act(async () =>
    root.render(
      embedded ? (
        <EmbedPresentationContext value={presentation}>{composer}</EmbedPresentationContext>
      ) : (
        composer
      ),
    ),
  );
}

function measure() {
  const q = <E extends Element>(selector: string) =>
    container.querySelector<E & HTMLElement>(selector)!;
  const title = q('[data-testid="app-approval-title"]');
  const buttons = Array.from(
    q('[data-slot="composer-banner-actions"]').querySelectorAll<HTMLElement>("button"),
  );
  return {
    title,
    titleBox: title.getBoundingClientRect(),
    reasonBox: q('[data-testid="app-approval-reason"]').getBoundingClientRect(),
    buttonBoxes: buttons.map((button) => button.getBoundingClientRect()),
    buttonLabels: buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
    card: q("[data-chat-composer-top-drawer]").getBoundingClientRect(),
    composer: q("[data-chat-composer-main-surface]").getBoundingClientRect(),
  };
}

function expectActionsOnTitleRow(m: ReturnType<typeof measure>) {
  expect(m.buttonLabels).toEqual(["Decline", "Approve", "More approval options"]);
  expect(m.titleBox.height).toBeLessThan(20);
  for (const button of m.buttonBoxes) {
    expect(button.left).toBeGreaterThanOrEqual(m.titleBox.right);
    expect(button.right).toBeLessThanOrEqual(m.card.right);
    expect(button.bottom).toBeGreaterThan(m.titleBox.top);
    expect(button.top).toBeLessThan(m.titleBox.bottom);
  }
  // One row: the buttons share a line.
  expect(new Set(m.buttonBoxes.map((box) => Math.round(box.top))).size).toBe(1);
  // The reason has a line of its own, under the buttons too.
  expect(m.reasonBox.top).toBeGreaterThanOrEqual(Math.max(...m.buttonBoxes.map((b) => b.bottom)));
  expect(m.reasonBox.left).toBeCloseTo(m.titleBox.left, 0);
  expect(m.reasonBox.right).toBeGreaterThan(m.buttonBoxes[2]!.left);
}

describe("the embed's approval card in a 352 px pane", () => {
  it("shows the whole tool name beside compact Decline, Approve and menu", async () => {
    await render(352);
    const m = measure();
    expectActionsOnTitleRow(m);
    expect(m.title.textContent).toBe("Approve rw_engine_simulate");
    expect(m.title.scrollWidth).toBeLessThanOrEqual(m.title.clientWidth);
  });
});

describe("the embed's approval card in a 320 px pane", () => {
  it("keeps the actions on the title's row and cuts the name only at its end", async () => {
    await render(320);
    const m = measure();
    expectActionsOnTitleRow(m);
    // The whole name fits the 352 px pane, so when only the name gives way it loses at most
    // the 32 px the pane did. The name's width depends on the platform's fallback font.
    expect(m.title.clientWidth).toBeGreaterThanOrEqual(m.title.scrollWidth - (352 - 320));
  });
});

describe.each([352, 320])("the embed's approval card in a %i px pane", (width) => {
  it("spans the composer and sits on it, about 60 px tall", async () => {
    await render(width);
    const { card, composer } = measure();

    expect(card.left).toBeCloseTo(composer.left, 0);
    expect(card.right).toBeCloseTo(composer.right, 0);
    expect(card.bottom).toBeLessThanOrEqual(composer.top + 0.5);
    expect(card.height).toBeGreaterThanOrEqual(52);
    expect(card.height).toBeLessThanOrEqual(68);
  });
});

describe("an app's long reason in a 352 px embed pane", () => {
  it("reads as sans prose on two lines, then truncates, and the card grows by one line", async () => {
    await render(352);
    const oneLine = measure();
    await render(352, true, undefined, withReason(LONG_REASON));
    const m = measure();
    const reason = container.querySelector<HTMLElement>('[data-testid="app-approval-reason"]')!;
    const style = getComputedStyle(reason);
    const lineHeight = Number.parseFloat(style.lineHeight);

    expect(style.fontFamily).toBe(fontFamilyOf("font-sans"));
    expect(style.fontFamily).not.toBe(fontFamilyOf("font-mono"));
    expect(style.fontSize).toBe("12px");
    expect(m.reasonBox.height).toBeCloseTo(2 * lineHeight, 0);
    // Clamped: the rest of the reason is cut off with an ellipsis.
    expect(reason.scrollHeight).toBeGreaterThan(reason.clientHeight);
    expect(m.card.height - oneLine.card.height).toBeCloseTo(lineHeight, 0);
    expectActionsOnTitleRow(m);
  });
});

describe("a provider command approval in a 352 px embed pane", () => {
  it("keeps its command in monospace", async () => {
    await render(352, true, undefined, commandApproval);
    const detail = container.querySelector<HTMLElement>('[aria-label="Command"]')!;

    expect(detail.textContent).toBe("vp test run apps/web/src/components/chat");
    expect(getComputedStyle(detail).fontFamily).toBe(fontFamilyOf("font-mono"));
    expect(container.querySelector('[data-testid="app-approval-reason"]')).toBeNull();
  });
});

describe.each([352, 320])("the embed approval card's menu in a %i px pane", (width) => {
  it("offers Stop turn, which stops the running turn", async () => {
    const onStopTurn = vi.fn();
    await render(width, true, onStopTurn);
    await act(async () =>
      container.querySelector<HTMLElement>('[aria-label="More approval options"]')!.click(),
    );
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent?.trim())).toEqual(["Cancel", "Stop turn"]);
    await act(async () => items[1]!.click());
    expect(onStopTurn).toHaveBeenCalledOnce();
  });
});

describe("the approval card outside the embed", () => {
  it("offers no Stop turn, since its composer keeps the stop button", async () => {
    await render(352, false, () => undefined);
    await act(async () =>
      container.querySelector<HTMLElement>('[aria-label="More approval options"]')!.click(),
    );
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent?.trim())).toEqual(["Cancel"]);
  });

  it("keeps its inset, tucked drawer and whole tool name", async () => {
    await render(352, false);
    const { title, card, composer, titleBox, buttonBoxes } = measure();

    expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth);
    expect(card.left).toBeGreaterThan(composer.left + 10);
    expect(card.bottom).toBeGreaterThan(composer.top + 10);
    expect(buttonBoxes[0]!.top).toBeGreaterThanOrEqual(titleBox.bottom);
  });
});

// RocketWright's dark palette, as its pane sends it: --input is one step off --card, which the
// warning card's tint lifts above it.
const HOST_THEME = {
  "--background": "#1b1e20",
  "--foreground": "#e6e9ea",
  "--card": "#25292c",
  "--card-foreground": "#e6e9ea",
  "--popover": "#25292c",
  "--popover-foreground": "#e6e9ea",
  "--muted": "#25292c",
  "--muted-foreground": "#8e989c",
  "--secondary": "#25292c",
  "--secondary-foreground": "#e6e9ea",
  "--border": "#2a3034",
  "--input": "#2a3034",
  "--primary": "#61b5ad",
  "--primary-foreground": "#1b1e20",
  "--accent": "#253c3f",
  "--accent-foreground": "#e6e9ea",
  "--ring": "#61b5ad",
};

/** The painted color at a viewport point, read from a screenshot of the page. */
async function paintedAt(points: ReadonlyArray<{ x: number; y: number }>) {
  const shot: unknown = await page.screenshot({ save: false, base64: true });
  const image = new Image();
  image.src = `data:image/png;base64,${typeof shot === "string" ? shot : (shot as { base64: string }).base64}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  const scale = image.width / innerWidth;
  return points.map(({ x, y }) =>
    Array.from(context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data).slice(
      0,
      3,
    ),
  );
}

describe.each([352, 1280])("the embed approval card's Decline in a %i px pane", (width) => {
  it("stands out from the card as an outlined button under a host's dark theme", async () => {
    applyEmbedThemeToRoot(document.documentElement, { appearance: "dark", variables: HOST_THEME });
    await render(width);
    const actions = container.querySelector('[data-slot="composer-banner-actions"]')!;
    const decline = [...actions.querySelectorAll<HTMLElement>("button")].find(
      (button) => button.textContent === "Decline",
    )!;
    const more = actions.querySelector<HTMLElement>('[aria-label="More approval options"]')!;
    for (const button of [decline, more]) {
      const box = button.getBoundingClientRect();
      const y = box.top + box.height / 2;
      const [card, edge] = await paintedAt([
        { x: box.left - 2, y },
        { x: box.left + 0.5, y },
      ]);
      // An outline that blends into the card differs from it by a few levels at most.
      expect(
        Math.max(...edge!.map((channel, index) => Math.abs(channel - card![index]!))),
      ).toBeGreaterThanOrEqual(24);
      expect(getComputedStyle(button).borderTopWidth).toBe("1px");
    }
  });
});
