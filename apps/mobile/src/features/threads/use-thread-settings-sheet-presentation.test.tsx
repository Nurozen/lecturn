import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import { useThreadSettingsSheetPresentation } from "./use-thread-settings-sheet-presentation";

const keyboard = vi.hoisted(() => ({ dismiss: vi.fn(), isVisible: vi.fn(() => false) }));
vi.mock("react-native-keyboard-controller", () => ({ KeyboardController: keyboard }));

let root: Root;
let presentation: ReturnType<typeof useThreadSettingsSheetPresentation>;
let expanded: boolean;
let frames: FrameRequestCallback[];
const focus = vi.fn();
const blur = vi.fn();
const editorRef = { current: { focus, blur } as unknown as ComposerEditorHandle };

function Probe({ focused }: { focused: boolean }) {
  const state = useThreadSettingsSheetPresentation({ editorRef, isEditorFocused: focused });
  useEffect(() => {
    presentation = state;
    expanded = focused || state.keepsComposerExpanded;
  }, [focused, state]);
  return null;
}
async function render(focused: boolean) {
  await act(() => root.render(<Probe focused={focused} />));
}
async function nextFrame() {
  const callbacks = frames;
  frames = [];
  await act(() => callbacks.forEach((callback) => callback(Date.now())));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
  vi.clearAllMocks();
  frames = [];
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  root = createRoot(container as unknown as HTMLElement);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("composer settings presentation", () => {
  it("keeps a compact composer compact and unfocused through settings dismissal", async () => {
    // Another input or a keyboard dismissal may still report visibility.
    // Opening the metadata strip must not request editor focus in that case.
    keyboard.isVisible.mockReturnValue(true);
    await render(false);
    await act(() => presentation.open());
    expect(expanded).toBe(false);
    await nextFrame();
    expect(presentation.isVisible).toBe(true);
    expect(expanded).toBe(false);
    await act(() => presentation.onDismissed());
    await act(() => presentation.onStackTransitionsFinished());
    await act(() => vi.advanceTimersByTime(500));
    await nextFrame();
    expect(expanded).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("retains an expanded composer after blur and restores its original focus once", async () => {
    await render(true);
    await act(() => presentation.open());
    expect(blur).toHaveBeenCalledTimes(1);
    await render(false);
    await nextFrame();
    expect(expanded).toBe(true);
    await act(() => presentation.onDismissed());
    expect(focus).not.toHaveBeenCalled();
    await act(() => presentation.onStackTransitionsFinished());
    await nextFrame();
    expect(focus).toHaveBeenCalledTimes(1);
    await render(true);
    await act(() => vi.advanceTimersByTime(500));
    await act(() => presentation.onStackTransitionsFinished());
    await nextFrame();
    expect(expanded).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending focus restore when settings reopens from compact metadata", async () => {
    await render(true);
    await act(() => presentation.open());
    await render(false);
    await nextFrame();
    await act(() => presentation.onDismissed());
    await act(() => presentation.open());
    await nextFrame();
    await act(() => vi.advanceTimersByTime(500));
    await act(() => presentation.onStackTransitionsFinished());
    await nextFrame();
    expect(presentation.isVisible).toBe(true);
    expect(expanded).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });
});
