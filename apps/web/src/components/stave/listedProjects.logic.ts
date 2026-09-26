import { isArchivedStaveProject } from "@lecturn/client-runtime/state/stave-archive";

/**
 * Archived Stave spaces keep their project and threads, but project lists
 * (sidebars, pickers) leave them out: they come back through New project →
 * Stave. These helpers hide a hidden project's threads along with it.
 */
export function archivedStaveProjectKeys(
  projects: ReadonlyArray<{
    readonly environmentId: string;
    readonly id: string;
    readonly stave?: { readonly state?: string | undefined } | null | undefined;
  }>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const project of projects) {
    if (isArchivedStaveProject(project)) keys.add(`${project.environmentId}:${project.id}`);
  }
  return keys;
}

export function withoutArchivedStaveProjectThreads<
  Thread extends { readonly environmentId: string; readonly projectId: string },
>(threads: ReadonlyArray<Thread>, archivedProjectKeys: ReadonlySet<string>): ReadonlyArray<Thread> {
  if (archivedProjectKeys.size === 0) return threads;
  return threads.filter(
    (thread) => !archivedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
}
