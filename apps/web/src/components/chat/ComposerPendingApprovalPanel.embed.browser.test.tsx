import "../../index.css";
import "../../embed/embed.css";
import "../../embed/embedComposer.css";

import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import { AppId, EnvironmentId, ProjectId, RuntimeRequestId } from "@lecturn/contracts";
import { ShieldIcon } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EmbedPresentationContext } from "../../embed/EmbedPresentationContext";
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
  vi.unstubAllGlobals();
});

const approval: PendingApproval = {
  requestId: RuntimeRequestId.make("approval-1"),
  requestKind: "permission",
  createdAt: "2026-10-25T00:00:00.000Z",
  responseCapability: "live",
  options: [
    { decision: "decline", label: "Decline" },
    { decision: "accept", label: "Approve" },
    { decision: "cancel", label: "Cancel" },
  ],
  connectedAppTool: {
    appId: AppId.make("dev.rocketwright"),
    appName: "RocketWright",
    toolName: "rw_engine_simulate",
    reason: "engine_simulate duration not set (defaults to a full burn of the selected motor)",
    source: "app",
  },
};

// The composer as ChatView and ChatComposer nest it while an approval is pending: the card is the
// top drawer in the banner dock, and the composer's main surface follows it.
async function render(width: number, embedded = true) {
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
                        <ComposerPendingApprovalPanel approval={approval} pendingCount={1} />
                      </ComposerBanner.Content>
                      <ComposerBanner.Actions>
                        <ComposerPendingApprovalActions
                          requestId={approval.requestId}
                          canRespond
                          isResponding={false}
                          options={approval.options}
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

describe.each([352, 320])("the embed's approval card in a %i px pane", (width) => {
  it("keeps Decline, Approve and the menu on the title's row and truncates the title", async () => {
    await render(width);
    const { title, titleBox, reasonBox, buttonBoxes, buttonLabels } = measure();

    expect(buttonLabels).toEqual(["Decline", "Approve", "More approval options"]);
    expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
    expect(titleBox.height).toBeLessThan(20);
    for (const button of buttonBoxes) {
      expect(button.left).toBeGreaterThanOrEqual(titleBox.right);
      expect(button.top).toBeLessThan(reasonBox.bottom);
      expect(button.bottom).toBeGreaterThan(titleBox.top);
    }
    // One row: the buttons share a line.
    expect(new Set(buttonBoxes.map((box) => Math.round(box.top))).size).toBe(1);
    expect(reasonBox.top).toBeGreaterThanOrEqual(titleBox.bottom);
    expect(reasonBox.right).toBeLessThanOrEqual(buttonBoxes[0]!.left);
  });

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

describe("the approval card outside the embed", () => {
  it("keeps its inset, tucked drawer and whole tool name", async () => {
    await render(352, false);
    const { title, card, composer, titleBox, buttonBoxes } = measure();

    expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth);
    expect(card.left).toBeGreaterThan(composer.left + 10);
    expect(card.bottom).toBeGreaterThan(composer.top + 10);
    expect(buttonBoxes[0]!.top).toBeGreaterThanOrEqual(titleBox.bottom);
  });
});
