/**
 * Which projects and threads belong to Projects mode and which to Apps mode,
 * shared by web and mobile. A connected app's project is marked only by its
 * `appBinding`; threads follow their project.
 */

import type { AppBinding, AppId, EnvironmentId, ProjectId } from "@lecturn/contracts";

import { scopedProjectKey } from "../environment/scoped.ts";
import { isArchivedStaveProject, listedProjects } from "./staveArchive.ts";

type AppBindingLike = { readonly appBinding?: AppBinding | undefined };
type ListedProjectLike = AppBindingLike & {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly stave?: { readonly state?: string | undefined } | null | undefined;
};
type ProjectScopedLike = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
};

export function isAppProject(project: AppBindingLike): boolean {
  return project.appBinding !== undefined;
}

function appIdOfProject(project: AppBindingLike): AppId | null {
  return project.appBinding?.appId ?? null;
}

/**
 * Lists, the scope picker, grouping and new-thread defaults in Projects mode.
 * Returns the input unchanged when nothing is hidden, so memoized consumers keep identity.
 */
export function projectsForProjectsMode<Project extends ListedProjectLike>(
  projects: ReadonlyArray<Project>,
): ReadonlyArray<Project> {
  const listed = listedProjects(projects);
  return listed.some(isAppProject) ? listed.filter((project) => !isAppProject(project)) : listed;
}

/**
 * Keys of the projects Projects mode hides: app projects and archived Stave spaces. Their
 * threads leave with them, while a thread whose project has not loaded yet stays listed.
 */
function projectsModeHiddenProjectKeys(
  projects: ReadonlyArray<ListedProjectLike>,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const project of projects) {
    if (isAppProject(project) || isArchivedStaveProject(project)) {
      hidden.add(scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }));
    }
  }
  return hidden;
}

export function threadsForProjectsMode<Thread extends ProjectScopedLike>(
  projects: ReadonlyArray<ListedProjectLike>,
  threads: ReadonlyArray<Thread>,
): ReadonlyArray<Thread> {
  const hidden = projectsModeHiddenProjectKeys(projects);
  return hidden.size === 0
    ? threads
    : threads.filter((thread) => !hidden.has(scopedProjectKey(thread)));
}

/** One app's projects in every environment. */
export function projectsForApp<Project extends ListedProjectLike>(
  projects: ReadonlyArray<Project>,
  appId: AppId,
): Project[] {
  return projects.filter((project) => project.appBinding?.appId === appId);
}

export interface AppWorkspaceGroup<Project, Thread> {
  /** The scoped project key. A normal project on the same folder is never merged in. */
  readonly key: string;
  readonly project: Project;
  /** Set only when the app's workspaces span more than one environment. */
  readonly machineLabel: string | null;
  readonly threads: ReadonlyArray<Thread>;
}

export interface AppGroup<Project, Thread> {
  readonly appId: AppId;
  readonly spansEnvironments: boolean;
  readonly workspaces: ReadonlyArray<AppWorkspaceGroup<Project, Thread>>;
}

/**
 * Apps mode: app projects grouped by app across environments, one workspace per project.
 * Groups are ordered by app id, workspaces by title then key; threads keep the input order.
 */
export function appGroups<
  Project extends ListedProjectLike & { readonly title: string },
  Thread extends ProjectScopedLike,
>(input: {
  readonly projects: ReadonlyArray<Project>;
  readonly threads: ReadonlyArray<Thread>;
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
}): ReadonlyArray<AppGroup<Project, Thread>> {
  const threadsByProject = new Map<string, Thread[]>();
  for (const thread of input.threads) {
    const key = scopedProjectKey(thread);
    const bucket = threadsByProject.get(key);
    if (bucket === undefined) threadsByProject.set(key, [thread]);
    else bucket.push(thread);
  }

  const projectsByApp = new Map<AppId, Project[]>();
  for (const project of input.projects) {
    const appId = appIdOfProject(project);
    if (appId === null) continue;
    const bucket = projectsByApp.get(appId);
    if (bucket === undefined) projectsByApp.set(appId, [project]);
    else bucket.push(project);
  }

  return [...projectsByApp.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([appId, projects]) => {
      const spansEnvironments = new Set(projects.map((project) => project.environmentId)).size > 1;
      const workspaces = projects
        .map((project) => {
          const key = scopedProjectKey({
            environmentId: project.environmentId,
            projectId: project.id,
          });
          return {
            key,
            project,
            machineLabel: spansEnvironments
              ? (input.environmentLabels.get(project.environmentId) ?? null)
              : null,
            threads: threadsByProject.get(key) ?? [],
          };
        })
        .sort(
          (left, right) =>
            left.project.title.localeCompare(right.project.title) ||
            left.key.localeCompare(right.key),
        );
      return { appId, spansEnvironments, workspaces };
    });
}
