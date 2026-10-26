import "../../index.css";
import "../../embed/embed.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { applyEmbedThemeToRoot } from "../../embed/embedTheme";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

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
  const rootElement = document.documentElement;
  delete rootElement.dataset.lecturnEmbed;
  rootElement.classList.remove("dark");
  rootElement.style.removeProperty("--destructive");
  vi.unstubAllGlobals();
});

it("paints the running turn's stop button in the host's --destructive", async () => {
  applyEmbedThemeToRoot(document.documentElement, {
    appearance: "dark",
    variables: { "--destructive": "rgb(97, 181, 173)" },
  });
  await act(async () =>
    root.render(
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
        isConnecting={false}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent={false}
        onPreviousPendingQuestion={() => undefined}
        onInterrupt={() => undefined}
        onImplementPlanInNewThread={() => undefined}
      />,
    ),
  );

  const stop = container.querySelector<HTMLElement>('[aria-label="Stop generation"]')!;
  // bg-destructive/90: the host's colour at 90 % opacity.
  const probe = document.createElement("span");
  probe.style.color = "color-mix(in oklab, rgb(97, 181, 173) 90%, transparent)";
  document.body.append(probe);
  expect(getComputedStyle(stop).backgroundColor).toBe(getComputedStyle(probe).color);
  probe.remove();
});
