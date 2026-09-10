import type { StaveSagaMemberStatus, StaveSpaceListRow } from "@t3tools/contracts";

export function staveSagaMemberBadges(member: StaveSagaMemberStatus): readonly string[] {
  return [
    member.state,
    ...(member.dirty ? ["dirty"] : []),
    ...(member.state === "live" &&
    member.repos.length > 0 &&
    member.repos.every((repo) => repo.baseHealth === "merged")
      ? ["merged"]
      : []),
  ];
}

/** Ambiguous or unreadable registry rows are never mutation targets. */
export function resolveSagaMemberSpace(spaces: readonly StaveSpaceListRow[], id: string) {
  const matches = spaces.filter(
    (space) => !space.isSaga && (space.logicalId ?? space.id) === id && !space.error,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function parseSagaAfter(value: string): readonly string[] {
  return [...new Set(value.split(/[\s,]+/u).filter(Boolean))];
}

/** Collapsed children leave both the rendered list and keyboard traversal. */
export function flattenSagaSidebarTree<
  T extends { readonly group: { readonly key: string }; readonly children: readonly T[] },
>(tree: readonly T[], isExpanded: (node: T) => boolean): readonly T[] {
  return tree.flatMap((node) => [
    node,
    ...(isExpanded(node) ? flattenSagaSidebarTree(node.children, isExpanded) : []),
  ]);
}
