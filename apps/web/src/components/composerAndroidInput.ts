import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  BEFORE_INPUT_COMMAND,
  COMMAND_PRIORITY_HIGH,
  type LexicalEditor,
} from "lexical";

export function registerComposerAndroidInput(editor: LexicalEditor): () => void {
  if (
    typeof navigator === "undefined" ||
    !/Android/.test(navigator.userAgent) ||
    !/Chrome\//.test(navigator.userAgent)
  ) {
    return () => {};
  }

  return editor.registerCommand(
    BEFORE_INPUT_COMMAND,
    (event) => {
      if (event.defaultPrevented || event.inputType !== "deleteContentBackward") return false;
      const selection = $getSelection();
      if (
        !$isRangeSelection(selection) ||
        !selection.isCollapsed() ||
        selection.anchor.type !== "text" ||
        selection.anchor.offset === 0
      ) {
        return false;
      }
      const node = selection.anchor.getNode();
      if (!$isTextNode(node) || !node.isSimpleText() || !node.canInsertTextAfter()) return false;

      // Lexical 0.41 cancels this event on Android but relies on Chrome ignoring
      // that cancellation. WebViews that honor it never delete. Let native input
      // delete within plain text and let Lexical's input handler reconcile it,
      // keeping the IME's composing node intact. Chips and boundaries stay Lexical-owned.
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}
