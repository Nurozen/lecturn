import {
  isWindowsAbsolutePath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "@t3tools/shared/path";

interface StaveReviewRepository {
  readonly workspaceRoot: string;
  readonly repositoryRoot: string;
  readonly repoName: string;
}

/** Comments use the agent's space-root paths, while diff metadata keeps Git-relative paths. */
function reviewPath(filePath: string, repository: StaveReviewRepository): string {
  const root = normalizeProjectPathForDispatch(repository.repositoryRoot);
  const workspace = normalizeProjectPathForDispatch(repository.workspaceRoot);
  const normalizedRoot = isWindowsAbsolutePath(root)
    ? normalizeProjectPathForComparison(root).replaceAll("\\", "/")
    : root;
  const normalizedWorkspace = isWindowsAbsolutePath(workspace)
    ? normalizeProjectPathForComparison(workspace).replaceAll("\\", "/")
    : workspace;
  const workspacePrefix = normalizedWorkspace.endsWith("/")
    ? normalizedWorkspace
    : `${normalizedWorkspace}/`;
  const displayRoot = isWindowsAbsolutePath(root) ? root.replaceAll("\\", "/") : root;
  if (normalizedRoot === normalizedWorkspace) return filePath;
  if (normalizedRoot.startsWith(workspacePrefix)) {
    return `${displayRoot.slice(workspacePrefix.length)}/${filePath}`;
  }
  // References may live outside the space. An absolute path remains unambiguous there.
  return `${displayRoot.replace(/\/$/, "")}/${filePath}`;
}

export function scopeStaveDiffReview<T extends { readonly filePath: string }>(input: {
  readonly repository: StaveReviewRepository | null;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly files: readonly T[];
}): { readonly sectionId: string; readonly sectionTitle: string; readonly files: readonly T[] } {
  const { repository, sectionId, sectionTitle, files } = input;
  if (!repository) return { sectionId, sectionTitle, files };
  return {
    sectionId: JSON.stringify([
      "stave-git",
      normalizeProjectPathForComparison(repository.repositoryRoot),
      sectionId,
    ]),
    sectionTitle: `${repository.repoName} · ${sectionTitle}`,
    files: files.map((file) => ({ ...file, filePath: reviewPath(file.filePath, repository) })),
  };
}
