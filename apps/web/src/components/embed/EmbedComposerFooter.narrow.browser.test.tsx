import "~/index.css";
import "../../embed/embed.css";

import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@lecturn/contracts";
import { BrainIcon, LockOpenIcon, PaperclipIcon, SendIcon, SparklesIcon } from "lucide-react";
import { act, createRef, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { EmbedPresentationContext } from "../../embed/EmbedPresentationContext";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ComposerPromptEditor } from "../ComposerPromptEditor";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  ComposerControlSeparator,
  ComposerSelectControl,
} from "../chat/ComposerControl";
import { ComposerSurface } from "../chat/ComposerSurface";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { measureRestingComposerControls } from "../chat/restingComposerControlsMeasurement";
import { resolveRestingComposerControlsLayout } from "../composerFooterLayout";
import { Select, SelectValue } from "../ui/select";
import { AppRefChipStrip } from "./AppRefChipStrip";
import { useAppRefChipStore } from "./appRefChipStore";
import { EmbedComposerFooter } from "./EmbedComposerFooter";

const presentation = {
  projectRef: scopeProjectRef(EnvironmentId.make("env-1"), ProjectId.make("project-1")),
};
const TARGET = "thread-1";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.dataset.lecturnEmbed = "";
  document.documentElement.classList.add("dark");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete document.documentElement.dataset.lecturnEmbed;
  document.documentElement.classList.remove("dark");
  useAppRefChipStore.getState().clear(TARGET);
  vi.unstubAllGlobals();
});

const instanceId = ProviderInstanceId.make("codex");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-28T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

/** ChatComposer's expanded-controls layout: measure, then resolve how many blocks are icon only. */
function useIconOnlyBlockCount(controls: HTMLDivElement | null) {
  const [iconOnlyCount, setIconOnlyCount] = useState(0);
  useLayoutEffect(() => {
    if (!controls) return;
    const measure = () => {
      const measurement = measureRestingComposerControls(controls);
      if (!measurement) return;
      const style = getComputedStyle(controls);
      const hostWidth =
        controls.clientWidth -
        (Number.parseFloat(style.paddingInlineStart) || 0) -
        (Number.parseFloat(style.paddingInlineEnd) || 0);
      setIconOnlyCount(
        (previous) =>
          resolveRestingComposerControlsLayout({
            ...measurement,
            hostWidth,
            previous: { hiddenCount: 0, iconOnlyCount: previous, visible: true },
          }).iconOnlyCount ?? 0,
      );
    };
    measure();
    return observeResize(controls, measure);
  }, [controls]);
  return iconOnlyCount;
}

// ChatComposer's resting-block wrapper, icon only from the end.
const blockProps = (index: number, blockCount: number, iconOnlyCount: number) => {
  const iconOnly = index >= blockCount - iconOnlyCount;
  return {
    "data-composer-block-icon-only": iconOnly ? "true" : "false",
    className: cn(
      "flex w-max min-w-max shrink-0 items-center gap-1",
      iconOnly &&
        "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none",
    ),
  };
};

/**
 * ChatComposer's expanded embed composer, built from the same parts and layout classes: the chip
 * strip and editor in the body, then the footer with the model picker, the effort and access
 * blocks, Contextual on the second row and attach/send on the input line.
 */
function EmbedComposer({ labels }: { labels: Labels }) {
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  const iconOnlyCount = useIconOnlyBlockCount(controls);
  return (
    <ComposerSurface.Shell>
      <ComposerSurface.Host>
        <ComposerSurface.Main>
          <div data-chat-composer-surface="true" className="rounded-3xl">
            <div
              data-chat-composer-body="true"
              className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4"
            >
              <AppRefChipStrip targetKey={TARGET} />
              <div className="relative" style={{ paddingRight: "calc(76px + 1rem)" }}>
                <ComposerPromptEditor
                  editorRef={createRef()}
                  value=""
                  cursor={0}
                  richTextEnabled
                  contextRecords={new Map()}
                  skills={[]}
                  disabled={false}
                  placeholder="Ask anything, @tag files/folders, $use skills, or / for commands"
                  onChange={() => {}}
                  onPaste={() => {}}
                />
              </div>
            </div>
            <EmbedComposerFooter
              stacked
              contextual={
                <ComposerControl size="sm">
                  <SparklesIcon className="size-3.5" />
                  <span data-composer-control-label>Contextual · Off</span>
                </ComposerControl>
              }
              data-chat-composer-footer="true"
              className="flex min-w-0 flex-nowrap items-center justify-between gap-1.5 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4"
            >
              <div
                ref={setControls}
                data-chat-composer-controls="left"
                data-chat-composer-footer-controls="true"
                className="relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5"
              >
                <ProviderModelPicker
                  environmentId={null}
                  compact={false}
                  isComposerOwned
                  activeInstanceId={instanceId}
                  model="model"
                  lockedProvider={null}
                  instanceEntries={deriveProviderInstanceEntries([provider])}
                  modelOptionsByInstance={
                    new Map([[instanceId, [{ slug: "model", name: labels.model }]]])
                  }
                  size="sm"
                  triggerClassName="-ms-2.5 min-w-13"
                  onInstanceModelChange={() => {}}
                />
                <div data-resting-block="traits" {...blockProps(0, 2, iconOnlyCount)}>
                  <ComposerControlSeparator />
                  <ComposerControl className="shrink-0 whitespace-nowrap">
                    <ComposerControlIcon icon={BrainIcon} />
                    <span data-composer-control-label>{labels.effort}</span>
                    <ComposerControlChevron />
                  </ComposerControl>
                </div>
                <div data-resting-block="mode" {...blockProps(1, 2, iconOnlyCount)}>
                  <ComposerControlSeparator />
                  <Select value={labels.access}>
                    <ComposerSelectControl aria-label="Runtime mode">
                      <ComposerControlIcon icon={LockOpenIcon} />
                      <SelectValue data-composer-control-label>{labels.access}</SelectValue>
                    </ComposerSelectControl>
                  </Select>
                </div>
              </div>
              <div
                data-chat-composer-actions="right"
                className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
              >
                <button type="button" aria-label="Attach files" className="size-8">
                  <PaperclipIcon className="mx-auto size-4" />
                </button>
                <button
                  type="button"
                  aria-label="Send"
                  className="lecturn-composer-send flex h-9 w-9 items-center justify-center rounded-full sm:h-8 sm:w-8"
                >
                  <SendIcon className="size-4" />
                </button>
              </div>
            </EmbedComposerFooter>
          </div>
        </ComposerSurface.Main>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>
  );
}

interface Labels {
  readonly model: string;
  readonly effort: string;
  readonly access: string;
}

async function renderAt(paneWidth: number, labels: Labels) {
  // The pane is the embed's whole viewport, so its width is the viewport's.
  await page.viewport(paneWidth, 800);
  useAppRefChipStore.getState().add(TARGET, { ref: "rw:c/fins", label: "rw:c/fins" });
  await act(async () =>
    root.render(
      <EmbedPresentationContext value={presentation}>
        <EmbedComposer labels={labels} />
      </EmbedPresentationContext>,
    ),
  );
  await act(async () => document.fonts.ready);
}

// Typical labels, and the longest RocketWright's pane showed: neither may wrap the footer
// past two rows.
const TYPICAL = { model: "Opus 5", effort: "High", access: "Supervised" };
const LONGEST = { model: "GPT-6-Astra", effort: "Medium", access: "Full access" };

const visibleText = (row: Element) =>
  Array.from(row.querySelectorAll<HTMLElement>("button")).map((button) =>
    Array.from(button.querySelectorAll<HTMLElement>("span"))
      .filter(
        (span) => span.childElementCount === 0 && getComputedStyle(span).visibility !== "hidden",
      )
      .map((span) => span.textContent)
      .join(""),
  );

describe("EmbedComposerFooter in a narrow pane", () => {
  it.each([
    [352, TYPICAL],
    [352, LONGEST],
    [320, TYPICAL],
    [320, LONGEST],
  ])("keeps the footer to two single-line rows at %i px (%o)", async (width, labels) => {
    await renderAt(width, labels);

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="embed-composer-footer-row"]'),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      const controls = Array.from(row.querySelectorAll<HTMLElement>("button"), (button) =>
        button.getBoundingClientRect(),
      );
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        expect(control.top).toBe(controls[0]!.top);
        expect(control.height).toBe(controls[0]!.height);
        // The leading control's hover box is outset into the footer's padding (-ms-2.5).
        expect(control.left).toBeGreaterThanOrEqual(box.left - 10);
        expect(control.right).toBeLessThanOrEqual(box.right);
      }
    }
    const [controlsRow, contextualRow] = rows as [HTMLElement, HTMLElement];
    expect(contextualRow.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      controlsRow.getBoundingClientRect().bottom,
    );
    const [model, effort, access] = visibleText(controlsRow);
    expect(model).toBe(labels.model);
    expect(effort).toBe(labels.effort);
    // Access gives way to its icon first; typical labels all fit at RocketWright's width.
    expect(access).toBe(width === 352 && labels === TYPICAL ? labels.access : "");
    expect(visibleText(contextualRow)).toEqual(["Contextual · Off"]);
  });

  // RocketWright's frozen composer region is 187 px tall with one chip in the strip.
  it("matches RocketWright's composer height with one chip at 352 px", async () => {
    await renderAt(352, TYPICAL);

    expect(container.querySelectorAll('[data-testid="app-ref-chip"]')).toHaveLength(1);
    const height = container
      .querySelector('[data-slot="composer-shell"]')!
      .getBoundingClientRect().height;
    expect(Math.abs(height - 187)).toBeLessThanOrEqual(9);
  });
});
