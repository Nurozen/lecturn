import { useAtomValue } from "@effect/atom-react";
import {
  createSquireEnvironmentAtoms,
  type SquireEnvironmentState,
} from "@lecturn/client-runtime/state/squire";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@lecturn/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { useEnvironmentIdentities } from "./environments";
import { environmentProjects } from "./projects";
import { serverEnvironment } from "./server";
import { useEnvironmentsWithScope } from "./session";

const hasProjectAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(environmentProjects.environmentProjectsAtom(environmentId)).length > 0,
  ).pipe(Atom.withLabel(`web-squire-has-project:${environmentId}`)),
);

export const squireEnvironment = createSquireEnvironmentAtoms(connectionAtomRuntime, {
  hasProjectAtom,
});

/** R13: a server without the capability is never sent a Squire RPC. */
export const squireCapableAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities.squire ===
      true,
  ).pipe(Atom.withLabel(`web-squire-capable:${environmentId}`)),
);

const gatedStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    get(squireCapableAtom(environmentId)) ? get(squireEnvironment.state(environmentId)) : null,
  ).pipe(Atom.withLabel(`web-squire-gated-state:${environmentId}`)),
);
const gatedEnsureLeadAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    get(squireCapableAtom(environmentId))
      ? get(squireEnvironment.ensureLead(environmentId))
      : false,
  ).pipe(Atom.withLabel(`web-squire-gated-ensure-lead:${environmentId}`)),
);

const squireStatesAtom = environmentAtomList("web-squire-states", gatedStateAtom);
const ensureLeadsAtom = environmentAtomList("web-squire-ensure-leads", gatedEnsureLeadAtom);

const mergedStatesAtom = Atom.family((idsKey: string) => {
  const ids = idsKey === "" ? [] : (idsKey.split("\n") as EnvironmentId[]);
  const states = squireStatesAtom(idsKey);
  const ensureLeads = ensureLeadsAtom(idsKey);
  return Atom.make((get) => {
    // Reading keeps the D7 Lead ensure mounted wherever Squires are shown.
    get(ensureLeads);
    return get(states).flatMap((state, index) =>
      state === null ? [] : [{ environmentId: ids[index]!, state }],
    );
  }).pipe(Atom.withLabel(`web-squire-states-merged:${idsKey}`));
});

/** Read-scoped, Squire-capable environments only; others are never subscribed and refused. */
function useReadableSquireEnvironmentsKey(): string {
  const environments = useEnvironmentIdentities();
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  return environmentIdsKey(
    environments
      .map((environment) => environment.environmentId)
      .filter((environmentId) => readable.has(environmentId)),
  );
}

/**
 * Every environment's Squires, merged for the sidebar group, notch, and palette. Reading it
 * also lets an operate-scoped client create a missing Lead (D7).
 */
export function useSquireEnvironments(): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly state: SquireEnvironmentState;
}> {
  return useAtomValue(mergedStatesAtom(useReadableSquireEnvironmentsKey()));
}

/** One environment's Squire state, null while unsubscribed, unsupported, or not readable. */
export function useSquireEnvironmentState(environmentId: EnvironmentId) {
  return useAtomValue(gatedStateAtom(environmentId));
}
