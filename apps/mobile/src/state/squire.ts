import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import {
  createSquireEnvironmentAtoms,
  squireEntryIndicator,
  type SquireEnvironmentState,
  type SquireIndicatorState,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import { AuthOrchestrationReadScope, type EnvironmentId, type SquireId } from "@lecturn/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useQuietThreadShell } from "./entities";
import { environmentProjects } from "./projects";
import { serverEnvironment } from "./server";
import { useEnvironmentsWithScope } from "./session";

const hasProjectAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(environmentProjects.environmentProjectsAtom(environmentId)).length > 0,
  ).pipe(Atom.withLabel(`mobile-squire-has-project:${environmentId}`)),
);

export const squireEnvironment = createSquireEnvironmentAtoms(connectionAtomRuntime, {
  hasProjectAtom,
});

/** Old servers strip the key, so a missing capability reads as "no Squires here". */
export function useSquireSupported(environmentId: EnvironmentId | null): boolean {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return config?.environment.capabilities.squire === true;
}

/**
 * Squires by environment, for environments the session may read (`orchestration:read`) and that
 * advertise `capabilities.squire`; a phone with operate scope also creates a missing Lead.
 */
export function squireEnvironmentStatesAtom(readable: ReadonlySet<EnvironmentId>) {
  return Atom.make((get) => {
    const byEnvironment = new Map<EnvironmentId, SquireEnvironmentState>();
    for (const environmentId of readable) {
      const config = get(serverEnvironment.configValueAtom(environmentId));
      if (config?.environment.capabilities.squire !== true) continue;
      get(squireEnvironment.ensureLead(environmentId));
      const state = get(squireEnvironment.state(environmentId));
      if (state !== null) byEnvironment.set(environmentId, state);
    }
    return byEnvironment;
  });
}

/** A new map on every snapshot change; lists should derive a structural atom instead. */
export function useSquireEnvironments(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
): ReadonlyMap<EnvironmentId, SquireEnvironmentState> {
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const statesAtom = useMemo(() => squireEnvironmentStatesAtom(readable), [readable]);
  return useAtomValue(statesAtom);
}

/** Readable environment ids for `squireEnvironmentStatesAtom`. */
export function useSquireReadableEnvironments(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
): ReadonlySet<EnvironmentId> {
  return useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
}

const NO_ENTRY_ATOM = Atom.make<SquireSnapshotEntry | null>(null);

/** One Squire's snapshot entry, or null until the environment's snapshot holds it. */
export function useSquireEntry(
  environmentId: EnvironmentId | null,
  squireId: SquireId | null,
): SquireSnapshotEntry | null {
  return useAtomValue(
    environmentId === null || squireId === null
      ? NO_ENTRY_ATOM
      : squireEnvironment.entry(environmentId, squireId),
  );
}

/** P16.4 indicator state, read from the home thread's shell (working beats waiting). */
export function useSquireIndicator(
  environmentId: EnvironmentId,
  entry: Pick<SquireSnapshotEntry, "squire" | "openDecisionCount" | "held">,
): SquireIndicatorState {
  const homeThreadId = entry.squire.homeThreadId;
  const homeShell = useQuietThreadShell(
    homeThreadId === null ? null : scopeThreadRef(environmentId, homeThreadId),
  );
  return squireEntryIndicator(entry, homeShell);
}
