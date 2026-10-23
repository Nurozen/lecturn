import { environmentProjects } from "./projects";
import { listedThreadShells } from "./listed-entities";
import { scopedProjectKey } from "../lib/scopedEntities";
import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
import { Atom } from "effect/reactivity";

import {
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "../features/threads/threadOrder";
import { getThreadListV2OrderedSection } from "../features/threads/threadListV2";
import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";
import { queuedThreadKeysAtom } from "./use-thread-outbox";

export const threadArrangementOpenAtom = Atom.make(false).pipe(Atom.keepAlive);

export const threadDropBusyAtom = Atom.make(false).pipe(Atom.keepAlive);

export const pendingThreadOrderAtom = Atom.make<PendingThreadOrder | null>(null).pipe(
  Atom.keepAlive,
);

export function usePendingThreadOrder(
  nowMinute: string,
  snoozeWakeTick: number,
  scopes?: ReadonlyMap<string, readonly string[]>,
) {
  const pending = useAtomValue(pendingThreadOrderAtom);
  // A timed wake can change section membership without a shell event. Use the
  // lists' existing clocks to retire that hold and re-enable their move menus.
  useEffect(() => {
    const current = getPendingThreadOrder(
      new Date(Math.max(Date.parse(`${nowMinute}:00.000Z`), snoozeWakeTick)).toISOString(),
    );
    if (current?.scopeProjectKeys && scopes) {
      const expected = JSON.stringify(current.scopeProjectKeys);
      if (current.scopeProjectKeys.some((key) => JSON.stringify(scopes.get(key)) !== expected)) {
        cancelPendingOrder?.();
      }
    }
  }, [nowMinute, snoozeWakeTick, scopes]);
  return pending;
}

let cancelPendingOrder: (() => void) | undefined;
let refreshPendingOrder: ((now?: string) => void) | undefined;

export function getPendingThreadOrder(now?: string): PendingThreadOrder | null {
  refreshPendingOrder?.(now);
  return appAtomRegistry.get(pendingThreadOrderAtom);
}

export function beginPendingThreadOrder(pending: PendingThreadOrder) {
  const unsubscribers: (() => void)[] = [];
  const cancel = () => {
    if (refreshPendingOrder !== refresh) return;
    refreshPendingOrder = undefined;
    cancelPendingOrder = undefined;
    for (const unsubscribe of unsubscribers) unsubscribe();
    appAtomRegistry.set(pendingThreadOrderAtom, null);
  };
  const refresh = (now = new Date().toISOString()) => {
    if (refreshPendingOrder !== refresh) return;
    const current = appAtomRegistry.get(pendingThreadOrderAtom);
    if (current === null) return;
    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
    const scope = current.scopeProjectKeys ? new Set(current.scopeProjectKeys) : null;
    const eligible =
      scope === null
        ? shells
        : listedThreadShells(appAtomRegistry.get(environmentProjects.projectsAtom), shells).filter(
            (row) => scope.has(scopedProjectKey(row.environmentId, row.projectId)),
          );
    const ordered = getThreadListV2OrderedSection({
      threads: eligible,
      section: current.section,
      now,
      queuedThreadKeys: appAtomRegistry.get(queuedThreadKeysAtom),
      settlementEnvironmentIds: new Set(
        [...configs].flatMap(([id, config]) =>
          config.environment.capabilities.threadSettlement === true ? [id] : [],
        ),
      ),
      snoozeEnvironmentIds: new Set(
        [...configs].flatMap(([id, config]) =>
          config.environment.capabilities.threadSnooze === true ? [id] : [],
        ),
      ),
    });
    const next = reconcilePendingThreadOrder(current, ordered);
    if (next === null) cancel();
    else if (next !== current) appAtomRegistry.set(pendingThreadOrderAtom, next);
  };
  refreshPendingOrder = refresh;
  cancelPendingOrder = cancel;
  appAtomRegistry.set(pendingThreadOrderAtom, pending);
  unsubscribers.push(
    appAtomRegistry.subscribe(environmentThreadShells.threadShellsAtom, () => refresh()),
    appAtomRegistry.subscribe(environmentServerConfigsAtom, () => refresh()),
    appAtomRegistry.subscribe(queuedThreadKeysAtom, () => refresh()),
    ...(pending.scopeProjectKeys
      ? [appAtomRegistry.subscribe(environmentProjects.projectsAtom, () => refresh())]
      : []),
  );
  return {
    isPending: () => {
      refresh();
      return refreshPendingOrder === refresh;
    },
    complete: () => {
      if (refreshPendingOrder !== refresh) return;
      const current = appAtomRegistry.get(pendingThreadOrderAtom);
      if (current !== null) {
        appAtomRegistry.set(pendingThreadOrderAtom, { ...current, commandsComplete: true });
        refresh();
      }
    },
    cancel,
  };
}
