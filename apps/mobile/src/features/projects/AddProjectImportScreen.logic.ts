import type { ExternalSessionFolderProviderCount } from "@lecturn/client-runtime/external-session-import";
import type { ProviderInstanceId } from "@lecturn/contracts";

/** A folder row's per-provider tally, "Claude Code (4) · Codex (2)", most sessions first. */
export function folderProviderCountsLabel(
  providerCounts: ReadonlyArray<ExternalSessionFolderProviderCount>,
  providerLabelById: ReadonlyMap<ProviderInstanceId, string>,
): string {
  return providerCounts
    .map(
      (entry) =>
        `${providerLabelById.get(entry.providerInstanceId) ?? String(entry.driverKind)} (${entry.count})`,
    )
    .join(" · ");
}

/** The bulk-import failure alert body: the summary line, then one line per failed session. */
export function bulkImportFailureDetails(
  description: string | null,
  failed: ReadonlyArray<{ readonly title: string; readonly message: string }>,
): string {
  return [
    ...(description === null ? [] : [description]),
    ...failed.map((failure) => `${failure.title}: ${failure.message}`),
  ].join("\n\n");
}
