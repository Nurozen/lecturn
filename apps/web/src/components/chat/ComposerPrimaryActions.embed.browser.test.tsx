import "../../index.css";
import "../../embed/embed.css";

import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render as renderUi, type Screen } from "../../../test/render";

import { EmbedPresentationContext } from "../../embed/EmbedPresentationContext";

import { applyEmbedThemeToRoot } from "../../embed/embedTheme";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

let container: HTMLDivElement;

let testScreen: Screen;

async function setup(): Promise<AsyncDisposable> {
  container = document.createElement("div");
  document.body.append(container);
  testScreen = await renderUi(null, { container, router: false });
  return {
    async [Symbol.asyncDispose]() {
      await testScreen[Symbol.asyncDispose]();
      const rootElement = document.documentElement;
      delete rootElement.dataset.lecturnEmbed;
      rootElement.classList.remove("dark");
      rootElement.style.removeProperty("--destructive");
    },
  };
}

it("paints the running turn's stop button in the host's --destructive", async () => {
  await using _setup = await setup();
  applyEmbedThemeToRoot(document.documentElement, {
    appearance: "dark",
    variables: { "--destructive": "rgb(97, 181, 173)" },
  });
  await testScreen.rerender(
    <ComposerPrimaryActions
      compact={false}
      canOperateThread
      pendingAction={null}
      isRunning
      canInterrupt
      showPlanFollowUpPrompt={false}
      promptHasText={false}
      isSendBusy={false}
      sendDisabledReason={null}
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent={false}
      onPreviousPendingQuestion={() => undefined}
      onInterrupt={() => undefined}
      onImplementPlanInNewThread={() => undefined}
    />,
  );

  const stop = container.querySelector<HTMLElement>('[aria-label="Stop generation"]')!;
  // bg-destructive/90: the host's colour at 90 % opacity.
  const probe = document.createElement("span");
  probe.style.color = "color-mix(in oklab, rgb(97, 181, 173) 90%, transparent)";
  document.body.append(probe);
  expect(getComputedStyle(stop).backgroundColor).toBe(getComputedStyle(probe).color);
  probe.remove();
});

const presentation = {
  projectRef: scopeProjectRef(EnvironmentId.make("env-1"), ProjectId.make("project-1")),
};

// A running turn held on an app approval: ChatComposer blocks sending while the card asks.
async function renderHeldTurn(width: number, embedded: boolean) {
  await page.viewport(width, 800);
  if (embedded) document.documentElement.dataset.lecturnEmbed = "";
  const actions = (
    <ComposerPrimaryActions
      compact={false}
      canOperateThread
      pendingAction={null}
      isRunning
      canInterrupt
      approvalPending
      showPlanFollowUpPrompt={false}
      promptHasText={false}
      isSendBusy={false}
      sendDisabledReason="Approve or decline the app tool above to send."
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent={false}
      onPreviousPendingQuestion={() => undefined}
      onInterrupt={() => undefined}
      onImplementPlanInNewThread={() => undefined}
    />
  );
  await testScreen.rerender(
    embedded ? (
      <EmbedPresentationContext value={presentation}>{actions}</EmbedPresentationContext>
    ) : (
      actions
    ),
  );
}

describe.each([352, 320])("a turn held on an approval in a %i px embed pane", (width) => {
  it("shows the idle send arrow where the stop button was", async () => {
    await using _setup = await setup();
    await renderHeldTurn(width, true);
    expect(container.querySelector('[aria-label="Stop generation"]')).toBeNull();
    const send = container.querySelector<HTMLButtonElement>("button.lecturn-composer-send")!;
    expect(send.disabled).toBe(true);
    expect(send.querySelector("svg.lucide-send")).not.toBeNull();
  });
});

it("keeps the stop button for a turn held on an approval outside the embed", async () => {
  await using _setup = await setup();
  await renderHeldTurn(352, false);
  expect(container.querySelector('[aria-label="Stop generation"]')).not.toBeNull();
  expect(container.querySelector("button.lecturn-composer-send")).toBeNull();
});
