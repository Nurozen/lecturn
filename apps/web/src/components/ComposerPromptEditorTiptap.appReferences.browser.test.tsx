import type { Editor } from "@tiptap/core";
import { createRef } from "react";
import { expect, it } from "vite-plus/test";
import { act, render as renderUi, type Screen } from "../../test/render";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { AppReferencesContext, type AppReferences } from "./embed/AppReferencesContext";

let container: HTMLDivElement;

let testScreen: Screen;

async function setup(): Promise<AsyncDisposable> {
  container = document.createElement("div");
  document.body.append(container);
  testScreen = await renderUi(null, { container, router: false });
  return {
    async [Symbol.asyncDispose]() {
      await testScreen[Symbol.asyncDispose]();
    },
  };
}

const appReferences: AppReferences = { refPrefixes: ["rw:"], iconUrl: null, activate: null };

async function mountEditor(value: string, references: AppReferences | null) {
  await testScreen.rerender(
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
  await using _setup = await setup();
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
  await using _setup = await setup();
  const editor = await mountEditor("Check rw:c/fins", null);
  expect(decorated(editor)).toEqual([]);
});
