import type { Editor } from "@tiptap/core";
import { act, Activity, createRef, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

let root: Root;
let container: HTMLDivElement;
let errors: unknown[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  errors = [];
  root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
    onCaughtError: (error) => errors.push(error),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// One element for every render, so revealing the Activity reruns the composer's
// effects from its last commit without re-rendering it first.
const composer = (
  <ComposerPromptEditor
    draftKey="a"
    editorRef={createRef<ComposerPromptEditorHandle>()}
    value="Draft A"
    cursor={7}
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
  return act(async () => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
}

function editor() {
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

// useEditor destroys its editor 1ms after render or passive cleanup unless the
// passive effects are connected again, and a hidden Activity disconnects them. Revealing then reruns the
// composer's layout effects against that destroyed editor before useEditor
// swaps in a new one.
const tiptapDestroyDelay = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

it("mounts while hidden and reveals after tiptap destroys the unmounted editor", async () => {
  await render("hidden");
  await tiptapDestroyDelay();
  await render("visible");
  await tiptapDestroyDelay();
  expect(errors.map(String)).toEqual([]);
  expect(editor().isDestroyed).toBe(false);
  expect(serializeEditorDoc(editor().state.doc).value).toBe("Draft A");
});

it("reveals a focused composer under StrictMode", async () => {
  await render("visible");
  const hiddenEditor = editor();
  await act(async () => hiddenEditor.view.focus());
  await render("hidden");
  await tiptapDestroyDelay();
  expect(hiddenEditor.isDestroyed).toBe(true);
  await render("visible");
  await tiptapDestroyDelay();
  expect(errors.map(String)).toEqual([]);
  expect(editor()).not.toBe(hiddenEditor);
  expect(editor().isDestroyed).toBe(false);
});

// Without StrictMode: its dev-only remount of tiptap's EditorContent moves the
// replacement editor's DOM out and back, which drops the restored focus.
it("restores focus to the editor that replaces one destroyed while hidden", async () => {
  await render("visible", false);
  const hiddenEditor = editor();
  await act(async () => hiddenEditor.view.focus());
  expect(document.activeElement).toBe(hiddenEditor.view.dom);
  await render("hidden", false);
  await tiptapDestroyDelay();
  expect(hiddenEditor.isDestroyed).toBe(true);
  await render("visible", false);
  await tiptapDestroyDelay();
  expect(errors.map(String)).toEqual([]);
  expect(editor()).not.toBe(hiddenEditor);
  expect(document.activeElement).toBe(editor().view.dom);
});
