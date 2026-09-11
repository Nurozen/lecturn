import type { StaveSpaceStatusRepo } from "@lecturn/contracts";

/**
 * One-line drift summary for a repo in the "Status" column of the Stave
 * space section: `↑2 ↓1 · dirty`, followed by any drift or reference warning
 * the probe attached. Missing checkouts are handled by the caller so the
 * warning tone can be applied to the cell.
 */
export function formatStaveRepoStatus(
  repo: Pick<StaveSpaceStatusRepo, "ahead" | "behind" | "dirty" | "driftError" | "referenceWarn">,
): string {
  const parts = [`↑${repo.ahead} ↓${repo.behind}`, repo.dirty ? "dirty" : "clean"];
  if (repo.driftError) parts.push(repo.driftError);
  if (repo.referenceWarn) parts.push(repo.referenceWarn);
  return parts.join(" · ");
}
