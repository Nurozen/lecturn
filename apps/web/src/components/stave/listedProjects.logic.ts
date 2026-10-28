import { isAppProject } from "@lecturn/client-runtime/state/app-projects";
import { isArchivedStaveProject } from "@lecturn/client-runtime/state/stave-archive";
import type { AppBinding } from "@lecturn/contracts";

type ProjectKeyLike = { readonly environmentId: string; readonly id: string };
type ProjectScopedThread = { readonly environmentId: string; readonly projectId: string };

/**
 * Archived Stave spaces keep their project and threads, but project lists
 * (sidebars, pickers) leave them out: they come back through New project →
 * Stave. These helpers hide a hidden project's threads along with it.
 */
export function archivedStaveProjectKeys(
  projects: ReadonlyArray<
    ProjectKeyLike & {
      readonly stave?: { readonly state?: string | undefined } | null | undefined;
    }
  >,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const project of projects) {
    if (isArchivedStaveProject(project)) keys.add(`${project.environmentId}:${project.id}`);
  }
  return keys;
}

/**
 * Connected-app projects belong to Apps mode. Projects-mode lists drop their
 * threads, while search and the command palette keep them (with an app badge).
 */
export function appProjectKeys(
  projects: ReadonlyArray<ProjectKeyLike & { readonly appBinding?: AppBinding | undefined }>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const project of projects) {
    if (isAppProject(project)) keys.add(`${project.environmentId}:${project.id}`);
  }
  return keys;
}

/** Returns the same list when no key matches, so memoized consumers keep identity. */
export function partitionThreadsByProjectKeys<Thread extends ProjectScopedThread>(
  threads: ReadonlyArray<Thread>,
  projectKeys: ReadonlySet<string>,
): { readonly outside: ReadonlyArray<Thread>; readonly inside: ReadonlyArray<Thread> } {
  if (projectKeys.size === 0) return { outside: threads, inside: [] };
  const outside: Thread[] = [];
  const inside: Thread[] = [];
  for (const thread of threads) {
    (projectKeys.has(`${thread.environmentId}:${thread.projectId}`) ? inside : outside).push(
      thread,
    );
  }
  return inside.length === 0 ? { outside: threads, inside } : { outside, inside };
}

export function withoutArchivedStaveProjectThreads<Thread extends ProjectScopedThread>(
  threads: ReadonlyArray<Thread>,
  archivedProjectKeys: ReadonlySet<string>,
): ReadonlyArray<Thread> {
  return partitionThreadsByProjectKeys(threads, archivedProjectKeys).outside;
}
