import { useAtomValue } from "@effect/atom-react";
import { deriveReportedModelSelection } from "@lecturn/client-runtime/state/thread-execution";

import { appAtomRegistry } from "./atom-registry";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import type {
  EnvironmentId,
  ScopedProjectRef,
  ScopedThreadRef,
  ServerConfig,
  ThreadId,
} from "@lecturn/contracts";
import { environmentSupportsStave } from "@lecturn/client-runtime/state/stave";
import { hasThreadLinks, relabelThreadLinks } from "@lecturn/shared/threadLinks";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { listedProjects, listedThreadShells } from "./listed-entities";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentThreadDetails, environmentThreadShells } from "./threads";

const EMPTY_PROJECT_ATOM = Atom.make<EnvironmentProject | null>(null).pipe(
  Atom.withLabel("mobile-project:empty"),
);
const EMPTY_THREAD_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("mobile-thread-shell:empty"),
);
const EMPTY_SERVER_CONFIG_ATOM = Atom.make<ServerConfig | null>(null).pipe(
  Atom.withLabel("mobile-server-config:empty"),
);
const EMPTY_THREAD_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("mobile-thread:empty"),
);
const EMPTY_THREAD_TITLES: ReadonlyMap<ThreadId, string> = new Map();
const EMPTY_THREAD_TITLES_ATOM = Atom.make(EMPTY_THREAD_TITLES).pipe(
  Atom.withLabel("mobile-thread-titles:empty"),
);

const threadTitlesAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous = EMPTY_THREAD_TITLES;
  return Atom.make((get) => {
    const index = get(environmentThreadShells.environmentThreadIndexAtom(environmentId));
    const unchanged =
      index.size === previous.size &&
      Array.from(index).every(([threadId, shell]) => previous.get(threadId) === shell.title);
    if (!unchanged) {
      previous = new Map(Array.from(index, ([threadId, shell]) => [threadId, shell.title]));
    }
    return previous;
  }).pipe(Atom.withLabel(`mobile-thread-titles:${environmentId}`));
});

const LISTED_PROJECTS_ATOM = Atom.make((get) =>
  listedProjects(get(environmentProjects.projectsAtom)),
).pipe(Atom.withLabel("mobile-projects:listed"));
/** Shared with routes that subscribe only while visible. */
export const LISTED_THREAD_SHELLS_ATOM = Atom.make((get) =>
  listedThreadShells(
    get(environmentProjects.projectsAtom),
    get(environmentThreadShells.navigationThreadShellsAtom),
  ),
).pipe(Atom.withLabel("mobile-thread-shells:listed"));

export function waitForProject(
  ref: ScopedProjectRef,
  timeoutMs = 10_000,
): Promise<EnvironmentProject | null> {
  const atom = environmentProjects.projectAtom(ref);
  const current = appAtomRegistry.get(atom);
  if (current !== null) return Promise.resolve(current);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      resolve(null);
    }, timeoutMs);
    const finish = (project: EnvironmentProject | null) => {
      if (project === null) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(project);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, finish);
    finish(appAtomRegistry.get(atom));
  });
}

/** Every project, archived Stave spaces included; lookups by id use this. */
export function useProjects(): ReadonlyArray<EnvironmentProject> {
  return useAtomValue(environmentProjects.projectsAtom);
}

export function useThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.threadShellsAtom);
}

/** Projects for lists and pickers: archived Stave spaces are restored from New project → Stave. */
export function useListedProjects(): ReadonlyArray<EnvironmentProject> {
  return useAtomValue(LISTED_PROJECTS_ATOM);
}

/** Navigation thread shells (no archived or subagent threads), without those of archived Stave spaces. */
export function useListedThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(LISTED_THREAD_SHELLS_ATOM);
}

export function useNavigationThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.navigationThreadShellsAtom);
}

export function useProject(ref: ScopedProjectRef | null): EnvironmentProject | null {
  return useAtomValue(ref === null ? EMPTY_PROJECT_ATOM : environmentProjects.projectAtom(ref));
}

export function useThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : environmentThreadShells.threadShellAtom(ref),
  );
}

export function useChildThreadInputs(ref: ScopedThreadRef) {
  return useAtomValue(environmentThreadShells.childThreadInputsAtom(ref));
}

export function useLiveThreadLinkLabels(markdown: string, environmentId: EnvironmentId): string {
  const titles = useAtomValue(
    hasThreadLinks(markdown) ? threadTitlesAtom(environmentId) : EMPTY_THREAD_TITLES_ATOM,
  );
  return useMemo(
    () =>
      titles.size === 0
        ? markdown
        : relabelThreadLinks(markdown, (threadId) => titles.get(threadId)),
    [markdown, titles],
  );
}

export function useEnvironmentServerConfig(
  environmentId: EnvironmentId | null,
): ServerConfig | null {
  return useAtomValue(
    environmentId === null
      ? EMPTY_SERVER_CONFIG_ATOM
      : serverEnvironment.configValueAtom(environmentId),
  );
}

/** Whether the environment's server build ships the Stave integration.
    Mobile v1 only reads the badge off the project shell, so this is the
    capability half of the gate; enabled/runnable are web-only concerns. */
export function useEnvironmentSupportsStave(environmentId: EnvironmentId | null): boolean {
  return environmentSupportsStave(useEnvironmentServerConfig(environmentId));
}

export function useServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return useAtomValue(environmentServerConfigsAtom);
}

const selectReportedModelSelection = (thread: EnvironmentThread | null) =>
  thread === null ? null : deriveReportedModelSelection(thread.projection);

export function useThreadReportedModelSelection(ref: ScopedThreadRef | null) {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_ATOM : environmentThreadDetails.threadAtom(ref),
    selectReportedModelSelection,
  );
}
