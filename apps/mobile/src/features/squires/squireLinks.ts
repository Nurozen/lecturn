import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import { EnvironmentId, SquireId, ThreadId } from "@lecturn/contracts";

import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { useSquireEntry, useSquireSupported } from "../../state/squire";
import { environmentThreadShells } from "../../state/threads";

/** The Squire whose home thread this is, or null for any other thread. */
export type SquireHomeThreadLookup = (environmentId: string, threadId: string) => string | null;

const THREAD_PATH = /^(\/?)threads\/([^/?#]+)\/([^/?#]+)$/;
const SQUIRE_PATH = /^\/?squires\/([^/?#]+)\/([^/?#]+)(?:[?#]|$)/;

function decodeSegments(...segments: string[]): string[] | null {
  try {
    return segments.map(decodeURIComponent);
  } catch {
    return null;
  }
}

/**
 * Pushes and Live Activities carry the home thread's path, because the relay builds it
 * from the thread. A marked home thread opens its Squire screen instead; every other path,
 * and a home thread whose shell has not hydrated yet, is returned unchanged.
 */
export function resolveSquireThreadPath(path: string, lookup: SquireHomeThreadLookup): string {
  const suffixStart = path.search(/[?#]/);
  const pathname = suffixStart === -1 ? path : path.slice(0, suffixStart);
  const suffix = suffixStart === -1 ? "" : path.slice(suffixStart);
  const match = THREAD_PATH.exec(pathname);
  if (!match) return path;
  const decoded = decodeSegments(match[2]!, match[3]!);
  if (!decoded) return path;
  const [environmentId, threadId] = decoded as [string, string];
  const squireId = lookup(environmentId, threadId);
  if (squireId === null) return path;
  return `${match[1]}squires/${encodeURIComponent(environmentId)}/${encodeURIComponent(squireId)}${suffix}`;
}

export function parseSquireRoutePath(
  pathname: string,
): { readonly environmentId: EnvironmentId; readonly squireId: SquireId } | null {
  const match = SQUIRE_PATH.exec(pathname);
  if (!match || match[2] === "rooms") return null;
  const decoded = decodeSegments(match[1]!, match[2]!);
  if (!decoded) return null;
  const [environmentId, squireId] = decoded as [string, string];
  return { environmentId: EnvironmentId.make(environmentId), squireId: SquireId.make(squireId) };
}

export function squireHomeThreadPath(environmentId: string, homeThreadId: string): string {
  return `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(homeThreadId)}`;
}

/**
 * Reads the shells already loaded for the thread list. Probe forks and environments
 * without `capabilities.squire` keep their thread path, so their history stays reachable.
 */
export const appSquireHomeThreadLookup: SquireHomeThreadLookup = (environmentId, threadId) => {
  const environment = EnvironmentId.make(environmentId);
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environment));
  if (config?.environment.capabilities.squire !== true) return null;
  const shell = appAtomRegistry.get(
    environmentThreadShells.threadShellAtom(scopeThreadRef(environment, ThreadId.make(threadId))),
  );
  return shell?.squire?.role === "home" ? shell.squire.squireId : null;
};

/** While a Squire screen is open its home thread counts as on screen, so its pushes stay quiet. */
export function useSquireHomeThreadOnScreen(pathname: string): string | null {
  const route = parseSquireRoutePath(pathname);
  const supported = useSquireSupported(route?.environmentId ?? null);
  const entry = useSquireEntry(
    supported ? (route?.environmentId ?? null) : null,
    supported ? (route?.squireId ?? null) : null,
  );
  const homeThreadId = entry?.squire.homeThreadId ?? null;
  return route && homeThreadId !== null
    ? squireHomeThreadPath(route.environmentId, homeThreadId)
    : null;
}
