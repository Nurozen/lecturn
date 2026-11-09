import type { Editor } from "@tiptap/core";
import { Activity, Component, createRef, StrictMode, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { act, fakeTimers, render as renderUi, type Screen } from "../../test/render";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

let screen: Screen;
let errors: unknown[];

// Records what the composer throws while rendering or committing.
class ErrorRecorder extends Component<{ readonly children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    errors.push(error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

async function setup() {
  errors = [];
  screen = await renderUi(null, { router: false });
  return screen;
}

// One element for every render, so revealing the Activity reruns the composer's
// effects from its last commit without re-rendering it first. The controlled
// caret sits mid-text so a restored selection differs from a fresh editor's.
const composer = (
  <ComposerPromptEditor
    draftKey="a"
    editorRef={createRef<ComposerPromptEditorHandle>()}
    value="Draft A"
    cursor={3}
    richTextEnabled
    contextRecords={new Map()}
    skills={[]}
    disabled={false}
    placeholder=""
    onChange={() => {}}
    onPaste={() => {}}
  />
);

function render(mode: "hidden" | "visible", strict = true) {
  const tree = <Activity mode={mode}>{composer}</Activity>;
  return screen.rerender(
    <ErrorRecorder>{strict ? <StrictMode>{tree}</StrictMode> : tree}</ErrorRecorder>,
  );
}

function editor() {
  const element = screen.container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

// useEditor destroys its editor 1ms after render or passive cleanup unless the
// passive effects are connected again, and a hidden Activity disconnects them. Revealing then reruns the
// composer's layout effects against that destroyed editor before useEditor
// swaps in a new one.
const tiptapDestroyDelay = () => act(async () => vi.advanceTimersByTime(20));

// "Dra|ft A": the controlled cursor 3 is ProseMirror position 4.
const controlledCaret = 4;

it("mounts while hidden and reveals after tiptap destroys the unmounted editor", async () => {
  await using _screen = await setup();
  using _timers = fakeTimers();
  await render("hidden");
  await tiptapDestroyDelay();
  await render("visible");
  await tiptapDestroyDelay();
  expect(errors.map(String)).toEqual([]);
  expect(editor().isDestroyed).toBe(false);
  expect(serializeEditorDoc(editor().state.doc).value).toBe("Draft A");
});

it("reveals a focused composer under StrictMode", async () => {
  await using _screen = await setup();
  using _timers = fakeTimers();
  await render("visible");
  const hiddenEditor = editor();
  await act(async () => hiddenEditor.view.focus());
  expect(hiddenEditor.state.selection.from).toBe(controlledCaret);
  await render("hidden");
  await tiptapDestroyDelay();
  expect(hiddenEditor.isDestroyed).toBe(true);
  await render("visible");
  await tiptapDestroyDelay();
  expect(errors.map(String)).toEqual([]);
  expect(editor()).not.toBe(hiddenEditor);
  expect(editor().isDestroyed).toBe(false);
  expect(editor().state.selection.from).toBe(controlledCaret);
});

// Without StrictMode: its dev-only remount of tiptap's EditorContent moves the
// replacement editor's DOM out and back, which drops the restored focus.
it("restores focus and the caret to the editor that replaces one destroyed while hidden", async () => {
  await using _screen = await setup();
  using _timers = fakeTimers();
  await render("visible", false);
  const hiddenEditor = editor();
  await act(async () => hiddenEditor.view.focus());
  expect(document.activeElement).toBe(hiddenEditor.view.dom);
  expect(hiddenEditor.state.selection.from).toBe(controlledCaret);
  await render("hidden", false);
  await tiptapDestroyDelay();
  expect(hiddenEditor.isDestroyed).toBe(true);
  await render("visible", false);
  await tiptapDestroyDelay();
  expect(errors.map(String)).toEqual([]);
  expect(editor()).not.toBe(hiddenEditor);
  expect(document.activeElement).toBe(editor().view.dom);
  // The replacement editor gets the controlled caret back, not the document start.
  expect(editor().state.selection.from).toBe(controlledCaret);
});
