import { findAppReferences } from "@lecturn/shared/appReferences";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";
import { useEffect } from "react";

import { contextChipClassName } from "../ContextChip";
import { useAppReferences } from "./AppReferencesContext";

interface AppReferenceDecorationState {
  readonly refPrefixes: ReadonlyArray<string>;
  readonly decorations: DecorationSet;
}

const APP_REF_CHIP_CLASS_NAME = contextChipClassName("app-ref");
const NO_PREFIXES: ReadonlyArray<string> = [];
const appReferenceDecorationsKey = new PluginKey<AppReferenceDecorationState>(
  "composer-app-references",
);

function decorate(doc: ProseMirrorNode, refPrefixes: ReadonlyArray<string>): DecorationSet {
  if (refPrefixes.length === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock") return false;
    if (!node.isText || node.text === undefined) return;
    if (node.marks.some((mark) => mark.type.name === "code")) return;
    for (const match of findAppReferences(node.text, refPrefixes)) {
      decorations.push(
        Decoration.inline(pos + match.start, pos + match.end, {
          class: APP_REF_CHIP_CLASS_NAME,
          "data-app-ref": match.ref,
        }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * Draws typed app references as chips. They stay plain text, so the prompt the agent receives and
 * the editor's serialization are unchanged; the prefixes arrive after the editor exists, by meta.
 */
export const ComposerAppReferencesExtension = Extension.create({
  name: "composer-app-references",
  addProseMirrorPlugins() {
    return [
      new Plugin<AppReferenceDecorationState>({
        key: appReferenceDecorationsKey,
        state: {
          init: () => ({ refPrefixes: NO_PREFIXES, decorations: DecorationSet.empty }),
          apply: (tr, previous, _oldState, state) => {
            const next = tr.getMeta(appReferenceDecorationsKey) as
              | ReadonlyArray<string>
              | undefined;
            if (next !== undefined) {
              return { refPrefixes: next, decorations: decorate(state.doc, next) };
            }
            if (!tr.docChanged || previous.refPrefixes.length === 0) return previous;
            return { ...previous, decorations: decorate(state.doc, previous.refPrefixes) };
          },
        },
        props: {
          decorations: (state) => appReferenceDecorationsKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});

/** Feeds the thread's app prefixes to the editor's reference decorations. */
export function useComposerAppReferences(editor: Editor | null): void {
  const refPrefixes = useAppReferences()?.refPrefixes ?? NO_PREFIXES;
  // Compared by content: the context hands out a new array whenever the app's status changes.
  const key = refPrefixes.join("\u0000");
  useEffect(() => {
    if (editor === null || editor.isDestroyed) return;
    const next = key === "" ? NO_PREFIXES : key.split("\u0000");
    editor.view.dispatch(editor.state.tr.setMeta(appReferenceDecorationsKey, next));
  }, [editor, key]);
}
