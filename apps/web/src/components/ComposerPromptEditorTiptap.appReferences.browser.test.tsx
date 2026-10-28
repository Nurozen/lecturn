import type { Editor } from "@tiptap/core";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { AppReferencesContext, type AppReferences } from "./embed/AppReferencesContext";

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
  vi.unstubAllGlobals();
});

const appReferences: AppReferences = { refPrefixes: ["rw:"], iconUrl: null, activate: null };

async function mountEditor(value: string, references: AppReferences | null) {
  await act(async () =>
    root.render(
      <AppReferencesContext value={references}>
        <ComposerPromptEditor
          editorRef={createRef<ComposerPromptEditorHandle>()}
          value={value}
          cursor={0}
          richTextEnabled
          contextRecords={new Map()}
          skills={[]}
          disabled={false}
          placeholder=""
          onChange={() => {}}
          onPaste={() => {}}
        />
      </AppReferencesContext>,
    ),
  );
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

const decorated = (editor: Editor) =>
  [...editor.view.dom.querySelectorAll<HTMLElement>("[data-app-ref]")].map(
    (element) => element.dataset.appRef,
  );

it("draws typed app references as chips without changing the prompt text", async () => {
  const value = "Check rw:c/fins and `rw:c/nose`.";
  const editor = await mountEditor(value, appReferences);
  expect(decorated(editor)).toEqual(["rw:c/fins"]);
  expect(serializeEditorDoc(editor.state.doc).value).toBe(value);

  await act(async () => {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent(" then rw:sim/run");
  });
  expect(decorated(editor)).toEqual(["rw:c/fins", "rw:sim/run"]);
});

it("leaves reference-like text plain outside an app's threads", async () => {
  const editor = await mountEditor("Check rw:c/fins", null);
  expect(decorated(editor)).toEqual([]);
});
