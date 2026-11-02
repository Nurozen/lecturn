import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@lecturn/contracts";
import { Atom } from "effect/reactivity";

import { environmentIdsKey } from "../../../state/environmentAtomList";
import {
  squireCapableAtom,
  squireEnvironment,
  useSquireEnvironments,
} from "../../../state/squires";

export interface SquireCommandAccess {
  readonly canTrack: boolean;
  readonly canUntrack: boolean;
  readonly canCreate: boolean;
  readonly canEdit: boolean;
  readonly canCreateRoom: boolean;
}

const NO_ACCESS: SquireCommandAccess = {
  canTrack: false,
  canUntrack: false,
  canCreate: false,
  canEdit: false,
  canCreateRoom: false,
};

const COMMANDS = [
  squireEnvironment.track,
  squireEnvironment.untrack,
  squireEnvironment.create,
  squireEnvironment.update,
  squireEnvironment.roomCreate,
] as const;

// A string, so an unchanged grant set compares equal and wakes no reader.
const accessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    get(squireCapableAtom(environmentId))
      ? COMMANDS.map((command) => (get(command.permissionAtom(environmentId)) ? "1" : "0")).join("")
      : "",
  ).pipe(Atom.withLabel(`web-squire-access:${environmentId}`)),
);
// Encoded with its ids, so a reader needs nothing but this value after the read.
const accessListAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    key === ""
      ? ""
      : (key.split("\n") as EnvironmentId[])
          .map((environmentId) => `${environmentId}\t${get(accessAtom(environmentId))}`)
          .join("\n"),
  ).pipe(Atom.withLabel(`web-squire-access-list:${key}`)),
);

/** The Squire commands each readable environment's session allows; nothing where Squires are off. */
export function useSquireCommandAccess(): (environmentId: EnvironmentId) => SquireCommandAccess {
  const environments = useSquireEnvironments();
  const encoded = useAtomValue(
    accessListAtom(environmentIdsKey(environments.map(({ environmentId }) => environmentId))),
  );
  const byEnvironment = new Map(
    encoded === ""
      ? []
      : encoded.split("\n").map((line) => {
          const [environmentId, bits = ""] = line.split("\t");
          return [environmentId as EnvironmentId, bits] as const;
        }),
  );
  return (environmentId) => {
    const bits = byEnvironment.get(environmentId) ?? "";
    if (bits === "") return NO_ACCESS;
    return {
      canTrack: bits[0] === "1",
      canUntrack: bits[1] === "1",
      canCreate: bits[2] === "1",
      canEdit: bits[3] === "1",
      canCreateRoom: bits[4] === "1",
    };
  };
}
