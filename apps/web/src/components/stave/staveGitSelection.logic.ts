import type { ProjectGitTarget } from "@t3tools/client-runtime/state/projectGit";

/** A removed/retargeted checkout cannot remain the destination of a later Git action. */
export function selectStaveGitTarget(targets: readonly ProjectGitTarget[], selectedKey?: string) {
  return (
    targets.find((target) => target.key === selectedKey) ??
    targets.find((target) => target.mode === "edit") ??
    targets[0] ??
    null
  );
}
