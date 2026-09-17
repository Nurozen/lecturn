import {
  SelectableMarkdownText as LecturnSelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@lecturn/mobile-markdown-text/renderer";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

export type {
  MarkdownImageRequest,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@lecturn/mobile-markdown-text/types";

// The renderer falls back to React Native Text outside iOS, so Android can use
// the same Markdown chunking while retaining native text selection.
export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  return <LecturnSelectableMarkdownText {...props} highlightCode={highlightCodeSnippet} />;
}
