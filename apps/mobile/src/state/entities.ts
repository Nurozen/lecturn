import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import type {
  EnvironmentId,
  ScopedProjectRef,
  ScopedThreadRef,
  ServerConfig,
} from "@lecturn/contracts";
import { environmentSupportsStave } from "@lecturn/client-runtime/state/stave";
import { Atom } from "effect/unstable/reactivity";

import { listedProjects, listedThreadShells } from "./listed-entities";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

const EMPTY_PROJECT_ATOM = Atom.make<EnvironmentProject | null>(null).pipe(
  Atom.withLabel("mobile-project:empty"),
);
const EMPTY_THREAD_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("mobile-thread-shell:empty"),
);
const EMPTY_SERVER_CONFIG_ATOM = Atom.make<ServerConfig | null>(null).pipe(
  Atom.withLabel("mobile-server-config:empty"),
);

const LISTED_PROJECTS_ATOM = Atom.make((get) =>
  listedProjects(get(environmentProjects.projectsAtom)),
).pipe(Atom.withLabel("mobile-projects:listed"));
const LISTED_THREAD_SHELLS_ATOM = Atom.make((get) =>
  listedThreadShells(
    get(environmentProjects.projectsAtom),
    get(environmentThreadShells.threadShellsAtom),
  ),
).pipe(Atom.withLabel("mobile-thread-shells:listed"));

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

/** Thread shells for lists, without those of archived Stave spaces. */
export function useListedThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(LISTED_THREAD_SHELLS_ATOM);
}

export function useProject(ref: ScopedProjectRef | null): EnvironmentProject | null {
  return useAtomValue(ref === null ? EMPTY_PROJECT_ATOM : environmentProjects.projectAtom(ref));
}

export function useThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : environmentThreadShells.threadShellAtom(ref),
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
