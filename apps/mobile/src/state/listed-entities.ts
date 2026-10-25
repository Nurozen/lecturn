import {
  isAppProject,
  projectsForProjectsMode,
  threadsForProjectsMode,
} from "@lecturn/client-runtime/state/app-projects";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import {
  isArchivedStaveProject,
  withoutArchivedStaveProjects,
} from "@lecturn/client-runtime/state/stave-archive";

import { scopedProjectKey } from "../lib/scopedEntities";

const NO_PROJECTS: ReadonlyArray<EnvironmentProject> = [];
const NO_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];

/**
 * Projects offered by the Threads tab, its lists and pickers. An archived Stave
 * space keeps its project and threads, but they come back only through New
 * project → Stave → Existing space; a connected app's workspaces live under the
 * Apps tab. Returns the input unchanged when nothing is hidden.
 */
export function listedProjects(
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyArray<EnvironmentProject> {
  return projectsForProjectsMode(projects);
}

/** Thread shells for the Threads tab: those of hidden projects leave with their project. */
export function listedThreadShells(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  return threadsForProjectsMode(projects, threads);
}

/**
 * Projects a new thread may be started in once a caller names one: the Apps
 * tab starts threads in app workspaces, which the Threads tab's pickers leave out.
 */
export function newThreadTargetProjects(
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyArray<EnvironmentProject> {
  return projects.some(isArchivedStaveProject) ? withoutArchivedStaveProjects(projects) : projects;
}

/** The Apps tab's projects: every connected app's workspaces, in every environment. */
export function appListedProjects(
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyArray<EnvironmentProject> {
  return projects.some(isAppProject) ? projects.filter(isAppProject) : NO_PROJECTS;
}

/** Thread shells for the Apps tab: the threads of app workspaces. */
export function appListedThreadShells(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const appKeys = new Set(
    projects
      .filter(isAppProject)
      .map((project) => scopedProjectKey(project.environmentId, project.id)),
  );
  return appKeys.size === 0
    ? NO_THREADS
    : threads.filter((thread) =>
        appKeys.has(scopedProjectKey(thread.environmentId, thread.projectId)),
      );
}
