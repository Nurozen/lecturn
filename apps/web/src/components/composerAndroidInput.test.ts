import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LexicalEditor } from "lexical";

const androidUserAgent =
  "Mozilla/5.0 (Linux; Android 17; Pixel) AppleWebKit/537.36 Chrome/145.0 Mobile Safari/537.36";
let lexical: typeof import("lexical");
let registerComposerAndroidInput: typeof import("./composerAndroidInput").registerComposerAndroidInput;

beforeAll(async () => {
  // Lexical caches platform detection at import time. No browser or DOM editor
  // is created; exercise its real Android beforeinput command in headless state.
  const document = { createElement: () => ({}) };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document });
  vi.stubGlobal("navigator", { platform: "Linux armv8l", userAgent: androidUserAgent });
  lexical = await import("lexical");
  ({ registerComposerAndroidInput } = await import("./composerAndroidInput"));
  vi.unstubAllGlobals();
});

afterEach(() => vi.unstubAllGlobals());

class BeforeInputEvent extends Event {
  readonly inputType: string;
  readonly data = null;

  constructor(inputType = "deleteContentBackward", cancelable = true) {
    super("beforeinput", { cancelable });
    this.inputType = inputType;
  }

  getTargetRanges(): StaticRange[] {
    return [];
  }
}

function createEditor(text = "letter", offset = text.length) {
  const editor = lexical.createEditor({
    onError: (error) => {
      throw error;
    },
  });
  editor.update(
    () => {
      const node = lexical.$createTextNode(text);
      lexical.$getRoot().append(lexical.$createParagraphNode().append(node));
      node.select(offset, offset);
    },
    { discrete: true },
  );
  return editor;
}

function beforeInput(editor: LexicalEditor, event = new BeforeInputEvent()) {
  editor.update(
    () => {
      editor.dispatchCommand(lexical.BEFORE_INPUT_COMMAND, event as InputEvent);
    },
    { discrete: true },
  );
  return event;
}

function enableAndroidInput(editor: LexicalEditor) {
  vi.stubGlobal("navigator", { userAgent: androidUserAgent });
  return registerComposerAndroidInput(editor);
}

function textOf(editor: LexicalEditor) {
  return editor.getEditorState().read(() => lexical.$getRoot().getTextContent());
}

describe("Android composer beforeinput", () => {
  it("exposes Lexical's canceled deletion without a replacement deletion", () => {
    const editor = createEditor();
    const deleteCharacter = vi.fn(() => false);
    editor.registerCommand(
      lexical.DELETE_CHARACTER_COMMAND,
      deleteCharacter,
      lexical.COMMAND_PRIORITY_HIGH,
    );

    expect(beforeInput(editor).defaultPrevented).toBe(true);
    expect(deleteCharacter).not.toHaveBeenCalled();
    expect(textOf(editor)).toBe("letter");
  });

  it.each([true, false])(
    "allows native deletion without a second model edit, cancelable=%s",
    (cancelable) => {
      const editor = createEditor("r");
      enableAndroidInput(editor);
      const deleteCharacter = vi.fn(() => false);
      editor.registerCommand(
        lexical.DELETE_CHARACTER_COMMAND,
        deleteCharacter,
        lexical.COMMAND_PRIORITY_HIGH,
      );

      expect(
        beforeInput(editor, new BeforeInputEvent("deleteContentBackward", cancelable))
          .defaultPrevented,
      ).toBe(false);
      expect(deleteCharacter).not.toHaveBeenCalled();
      expect(textOf(editor)).toBe("r");
    },
  );

  it("keeps the composing node and caret intact until native input arrives", () => {
    const editor = createEditor();
    enableAndroidInput(editor);
    editor.update(
      () => {
        const selection = lexical.$getSelection();
        if (!lexical.$isRangeSelection(selection)) throw new Error("Expected text selection");
        lexical.$setCompositionKey(selection.anchor.key);
      },
      { discrete: true },
    );
    const selection = editor.getEditorState().read(() => lexical.$getSelection()?.clone());

    expect(beforeInput(editor).defaultPrevented).toBe(false);
    expect(editor.isComposing()).toBe(true);
    expect(editor.getEditorState().read(() => lexical.$getSelection()?.is(selection!))).toBe(true);
    expect(textOf(editor)).toBe("letter");
  });

  it("leaves text-start and element-point deletion to Lexical", () => {
    const editor = createEditor("after", 0);
    enableAndroidInput(editor);
    const fallback = vi.fn(() => false);
    editor.registerCommand(lexical.BEFORE_INPUT_COMMAND, fallback, lexical.COMMAND_PRIORITY_NORMAL);
    expect(beforeInput(editor).defaultPrevented).toBe(true);
    editor.update(
      () => {
        const selection = lexical.$getSelection();
        if (!lexical.$isRangeSelection(selection)) throw new Error("Expected text selection");
        selection.anchor.getNode().getParentOrThrow().select(0, 0);
      },
      { discrete: true },
    );

    expect(beforeInput(editor).defaultPrevented).toBe(true);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("does not claim selected text, token text, or other input types", () => {
    const editor = createEditor();
    enableAndroidInput(editor);
    const fallback = vi.fn(() => true);
    editor.registerCommand(lexical.BEFORE_INPUT_COMMAND, fallback, lexical.COMMAND_PRIORITY_NORMAL);
    beforeInput(editor, new BeforeInputEvent("insertCompositionText"));
    beforeInput(editor, new BeforeInputEvent("insertText"));
    beforeInput(editor, new BeforeInputEvent("deleteContentForward"));
    editor.update(
      () => {
        const node = lexical.$getRoot().getAllTextNodes()[0]!;
        node.select(1, 3);
      },
      { discrete: true },
    );
    beforeInput(editor);
    editor.update(
      () => {
        const node = lexical.$getRoot().getAllTextNodes()[0]!;
        node.setMode("token").selectEnd();
      },
      { discrete: true },
    );
    beforeInput(editor);
    expect(fallback).toHaveBeenCalledTimes(5);
  });

  it.each([
    "Mozilla/5.0 Chrome/145.0",
    "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Safari/604.1",
    "Mozilla/5.0 (Android 17) Firefox/145.0",
  ])("leaves other platforms unchanged: %s", (userAgent) => {
    const editor = createEditor();
    vi.stubGlobal("navigator", { userAgent });
    registerComposerAndroidInput(editor);
    const fallback = vi.fn(() => true);
    editor.registerCommand(lexical.BEFORE_INPUT_COMMAND, fallback, lexical.COMMAND_PRIORITY_NORMAL);
    beforeInput(editor);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("unregisters when the composer unmounts", () => {
    const editor = createEditor();
    const unregister = enableAndroidInput(editor);
    unregister();
    expect(beforeInput(editor).defaultPrevented).toBe(true);
  });
});
