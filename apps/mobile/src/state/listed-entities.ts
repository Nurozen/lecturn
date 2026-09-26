import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import {
  isArchivedStaveProject,
  withoutArchivedStaveProjects,
} from "@lecturn/client-runtime/state/stave-archive";

import { scopedProjectKey } from "../lib/scopedEntities";

/**
 * Projects offered by lists and pickers. An archived Stave space keeps its
 * project and threads, but they come back only through New project → Stave →
 * Existing space. Returns the input unchanged when nothing is archived.
 */
export function listedProjects(
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyArray<EnvironmentProject> {
  return projects.some(isArchivedStaveProject) ? withoutArchivedStaveProjects(projects) : projects;
}

/** Thread shells for lists: those of archived Stave spaces leave with their project. */
export function listedThreadShells(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const archived = new Set(
    projects
      .filter(isArchivedStaveProject)
      .map((project) => scopedProjectKey(project.environmentId, project.id)),
  );
  return archived.size === 0
    ? threads
    : threads.filter(
        (thread) => !archived.has(scopedProjectKey(thread.environmentId, thread.projectId)),
      );
}
