export interface SidebarHierarchyLine {
  readonly level: number;
  readonly continues: boolean;
}

/** Resolve the visible tree's guides before virtualized rows lose their neighbors. */
export function buildSidebarHierarchy(
  items: readonly { readonly key: string; readonly depth?: number }[],
): ReadonlyMap<string, readonly SidebarHierarchyLine[]> {
  const hasNextSibling: boolean[] = [];
  const followingDepths: number[] = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const depth = items[index]?.depth ?? 0;
    while (followingDepths.length && followingDepths[followingDepths.length - 1]! > depth) {
      followingDepths.pop();
    }
    hasNextSibling[index] = followingDepths[followingDepths.length - 1] === depth;
    followingDepths.push(depth);
  }

  const guides = new Map<string, readonly SidebarHierarchyLine[]>();
  const ancestorContinues: boolean[] = [];
  for (const [index, item] of items.entries()) {
    const depth = item.depth ?? 0;
    ancestorContinues.length = depth;
    const lines: SidebarHierarchyLine[] = [];
    for (let level = 0; level < depth; level++) {
      const immediateParent = level === depth - 1;
      if (immediateParent || ancestorContinues[level + 1]) {
        lines.push({
          level,
          continues: immediateParent ? (hasNextSibling[index] ?? false) : true,
        });
      }
    }
    guides.set(item.key, lines);
    ancestorContinues[depth] = hasNextSibling[index] ?? false;
  }
  return guides;
}
