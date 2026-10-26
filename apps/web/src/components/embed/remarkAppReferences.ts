import {
  formatAppReferenceHref,
  splitAppReferences,
  wholeAppReference,
} from "@lecturn/shared/appReferences";

import type { MarkdownNode } from "~/vendor/mdast-find-and-replace";

// A reference inside a link is that link's text; fenced code is not a `text` node, so it stays literal.
const IGNORED_TYPES = new Set(["link", "linkReference"]);

const appReferenceLink = (ref: string): MarkdownNode => ({
  type: "link",
  url: formatAppReferenceHref(ref),
  children: [{ type: "text", value: ref }],
});

/** Turns app references in message text into links the markdown renderer draws as chips. */
export function remarkAppReferences(options: { readonly refPrefixes: ReadonlyArray<string> }) {
  const visit = (node: MarkdownNode) => {
    const children = node.children;
    if (children === undefined) return;
    node.children = children.flatMap((child): MarkdownNode[] => {
      if (IGNORED_TYPES.has(child.type)) return [child];
      // Agents quote references as code even when told not to; a span that is only a reference is one.
      if (child.type === "inlineCode" && child.value !== undefined) {
        const ref = wholeAppReference(child.value, options.refPrefixes);
        return [ref === null ? child : appReferenceLink(ref)];
      }
      if (child.type !== "text" || child.value === undefined) {
        visit(child);
        return [child];
      }
      const segments = splitAppReferences(child.value, options.refPrefixes);
      if (!segments.some((segment) => segment.type === "ref")) return [child];
      return segments.map((segment) =>
        segment.type === "text"
          ? { type: "text", value: segment.text }
          : appReferenceLink(segment.ref),
      );
    });
  };
  return (tree: MarkdownNode) => {
    if (options.refPrefixes.length > 0) visit(tree);
  };
}
