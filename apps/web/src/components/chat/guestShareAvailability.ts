import type { EnvironmentId } from "@lecturn/contracts";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";

/**
 * Whether this environment offers "Share with guest": the user may create links there, and its
 * Guest links beta is on (Settings > Beta). The server refuses links while the beta is off.
 */
export const canShareWithGuestAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(serverEnvironment.createGuestShare.permissionAtom(environmentId)) &&
      get(environmentPresentations.serverConfigsAtom).get(environmentId)?.settings
        .guestSharingEnabled === true,
  ).pipe(Atom.withLabel(`guest-share:available:${environmentId}`)),
);

/**
 * Lecturn: a Squire thread is Squire's to run and a Lecturn App thread belongs to its app, so
 * neither offers "Share with guest". The server refuses both as well.
 */
export function isGuestShareableThread(
  thread: { readonly squire?: unknown } | null | undefined,
  project: { readonly appBinding?: unknown } | null | undefined,
): boolean {
  return thread?.squire == null && project?.appBinding == null;
}
