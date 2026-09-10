import type { StaveProjectInfo, StaveRepoEntry } from "@t3tools/contracts";
import { isWindowsAbsolutePath, normalizeProjectPathForComparison } from "@t3tools/shared/path";

/** Compare manifest-relative repo paths with the absolute primary Git target. */
function repoPathForComparison(path: string, workspaceRoot: string): string {
  const absolute = path.startsWith("/") || isWindowsAbsolutePath(path);
  const joined = absolute ? path : `${workspaceRoot}/${path}`;
  const normalized = normalizeProjectPathForComparison(joined);
  const separator = isWindowsAbsolutePath(normalized) ? "\\" : "/";
  const segments: string[] = [];
  for (const segment of normalized.split(separator)) {
    if (segment === ".") continue;
    if (!segment && segments.some((part) => part.length > 0)) continue;
    if (segment === ".." && segments.length > 1) segments.pop();
    else segments.push(segment);
  }
  return segments.join(separator);
}

/** Present the whole Stave workspace separately from its one primary Git repo. */
export function describeStaveWorkspace(
  project:
    | { readonly workspaceRoot: string; readonly stave?: StaveProjectInfo | null | undefined }
    | null
    | undefined,
): {
  label: string;
  title: string;
  primaryRepoName: string | null;
  primaryRepoPath: string | null;
  editableRepos: readonly StaveRepoEntry[];
  referenceRepos: readonly StaveRepoEntry[];
  workspaceRoot: string;
} | null {
  const stave = project?.stave;
  if (!project || !stave) return null;

  const editableRepos = stave.repos.filter((repo) => repo.mode === "edit");
  const referenceRepos = stave.repos.filter((repo) => repo.mode === "reference");
  const kind = stave.isSaga || stave.kind === "saga" ? "Stave saga" : "Stave space";
  const count = editableRepos.length
    ? `${editableRepos.length} editable repo${editableRepos.length === 1 ? "" : "s"}`
    : referenceRepos.length
      ? `${referenceRepos.length} reference${referenceRepos.length === 1 ? "" : "s"}`
      : null;
  const primaryPath = stave.primaryRepoPath;
  const primaryRepo = primaryPath
    ? editableRepos.find(
        (repo) =>
          repoPathForComparison(repo.path, project.workspaceRoot) ===
          repoPathForComparison(primaryPath, project.workspaceRoot),
      )
    : undefined;

  return {
    label: count ? `${kind} · ${count}` : kind,
    title: [
      `Workspace: ${project.workspaceRoot}`,
      `Editable repos: ${editableRepos.length ? editableRepos.map((repo) => repo.name).join(", ") : "None"}`,
      ...(referenceRepos.length
        ? [`References: ${referenceRepos.map((repo) => repo.name).join(", ")}`]
        : []),
      primaryPath
        ? `Git target: ${primaryRepo?.name ?? primaryPath}${stave.primaryBranch ? ` · ${stave.primaryBranch}` : ""}`
        : "Git target: None",
    ].join("\n"),
    primaryRepoName: primaryRepo?.name ?? null,
    primaryRepoPath: primaryPath ?? null,
    editableRepos,
    referenceRepos,
    workspaceRoot: project.workspaceRoot,
  };
}
