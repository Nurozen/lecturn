import { formatAppReferenceHref, splitAppReferences } from "@lecturn/shared/appReferences";

import type { MarkdownNode } from "~/vendor/mdast-find-and-replace";

// A reference inside a link is that link's text; code is not a `text` node, so it stays literal.
const IGNORED_TYPES = new Set(["link", "linkReference"]);

/** Turns app references in message text into links the markdown renderer draws as chips. */
export function remarkAppReferences(options: { readonly refPrefixes: ReadonlyArray<string> }) {
  const visit = (node: MarkdownNode) => {
    const children = node.children;
    if (children === undefined) return;
    node.children = children.flatMap((child): MarkdownNode[] => {
      if (IGNORED_TYPES.has(child.type)) return [child];
      if (child.type !== "text" || child.value === undefined) {
        visit(child);
        return [child];
      }
      const segments = splitAppReferences(child.value, options.refPrefixes);
      if (!segments.some((segment) => segment.type === "ref")) return [child];
      return segments.map((segment) =>
        segment.type === "text"
          ? { type: "text", value: segment.text }
          : {
              type: "link",
              url: formatAppReferenceHref(segment.ref),
              children: [{ type: "text", value: segment.ref }],
            },
      );
    });
  };
  return (tree: MarkdownNode) => {
    if (options.refPrefixes.length > 0) visit(tree);
  };
}
