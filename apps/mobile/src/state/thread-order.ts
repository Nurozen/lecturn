import { environmentProjects } from "./projects";
import { listedThreadShells } from "./listed-entities";
import { scopedProjectKey } from "../lib/scopedEntities";
import { useAtomValue } from "@effect/atom-react";
import { deadlineStore, minuteTick } from "@lecturn/client-runtime/clock";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import {
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "../features/threads/threadOrder";
import {
  getThreadListV2OrderedSection,
  nextSnoozeWakeAfter,
} from "../features/threads/threadListV2";
import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";
import { queuedThreadKeysAtom } from "./use-thread-outbox";

export const threadArrangementOpenAtom = Atom.make(false).pipe(Atom.keepAlive);

export const threadDropBusyAtom = Atom.make(false).pipe(Atom.keepAlive);

export const pendingThreadOrderAtom = Atom.make<PendingThreadOrder | null>(null).pipe(
  Atom.keepAlive,
);

/**
 * `scopes` maps each project key to the project keys of its move scope, as the list groups them
 * now. A scoped hold whose scope regrouped since it began is retired.
 */
export function usePendingThreadOrder(scopes?: ReadonlyMap<string, readonly string[]>) {
  const pending = useAtomValue(pendingThreadOrderAtom);
  // oxlint-disable-next-line lecturn/react-effect-budget -- Move scopes come from the rendered grouping, which no store holds.
  useEffect(() => {
    if (scopes) retirePendingOrderOutsideScopes(scopes);
  }, [scopes]);
  return pending;
}

let refreshPendingOrder: (() => void) | undefined;
let cancelPendingOrder: (() => void) | undefined;
// Only one hold is live at a time; starting another tears down the previous
// hold's subscriptions so its clocks and listeners do not outlive it.
let teardownPendingOrder: (() => void) | undefined;

export function getPendingThreadOrder(): PendingThreadOrder | null {
  refreshPendingOrder?.();
  return appAtomRegistry.get(pendingThreadOrderAtom);
}

function retirePendingOrderOutsideScopes(scopes: ReadonlyMap<string, readonly string[]>): void {
  const current = getPendingThreadOrder();
  if (!current?.scopeProjectKeys) return;
  const expected = JSON.stringify(current.scopeProjectKeys);
  if (current.scopeProjectKeys.some((key) => JSON.stringify(scopes.get(key)) !== expected)) {
    cancelPendingOrder?.();
  }
}

export function beginPendingThreadOrder(pending: PendingThreadOrder) {
  const unsubscribers: (() => void)[] = [];
  // A timed wake can change section membership without a shell event, so the
  // hold also re-checks on each minute and at the next snooze expiry.
  let wake: { readonly atMs: number | null; readonly unsubscribe: () => void } | null = null;
  const armWake = (atMs: number | null) => {
    if (wake?.atMs === atMs) return;
    wake?.unsubscribe();
    wake = { atMs, unsubscribe: deadlineStore(atMs).subscribe(refresh) };
  };
  const teardown = () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    wake?.unsubscribe();
    wake = null;
  };
  const cancel = () => {
    if (refreshPendingOrder !== refresh) return;
    refreshPendingOrder = undefined;
    cancelPendingOrder = undefined;
    teardownPendingOrder = undefined;
    teardown();
    appAtomRegistry.set(pendingThreadOrderAtom, null);
  };
  const refresh = () => {
    if (refreshPendingOrder !== refresh) return;
    const current = appAtomRegistry.get(pendingThreadOrderAtom);
    if (current === null) return;
    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    const threads = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
    const scope = current.scopeProjectKeys ? new Set(current.scopeProjectKeys) : null;
    const eligible =
      scope === null
        ? threads
        : listedThreadShells(appAtomRegistry.get(environmentProjects.projectsAtom), threads).filter(
            (row) => scope.has(scopedProjectKey(row.environmentId, row.projectId)),
          );
    const nowMs = Date.now();
    const ordered = getThreadListV2OrderedSection({
      threads: eligible,
      section: current.section,
      listingCapabilities: appAtomRegistry.get(environmentThreadShells.listingCapabilitiesAtom),
      now: new Date(nowMs).toISOString(),
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
    if (next === null) {
      cancel();
      return;
    }
    if (next !== current) appAtomRegistry.set(pendingThreadOrderAtom, next);
    armWake(nextSnoozeWakeAfter(threads, nowMs));
  };
  teardownPendingOrder?.();
  refreshPendingOrder = refresh;
  cancelPendingOrder = cancel;
  teardownPendingOrder = teardown;
  appAtomRegistry.set(pendingThreadOrderAtom, pending);
  unsubscribers.push(
    appAtomRegistry.subscribe(environmentThreadShells.threadShellsAtom, refresh),
    appAtomRegistry.subscribe(environmentServerConfigsAtom, refresh),
    appAtomRegistry.subscribe(queuedThreadKeysAtom, refresh),
    ...(pending.scopeProjectKeys
      ? [appAtomRegistry.subscribe(environmentProjects.projectsAtom, refresh)]
      : []),
    minuteTick.subscribe(refresh),
  );
  armWake(
    nextSnoozeWakeAfter(appAtomRegistry.get(environmentThreadShells.threadShellsAtom), Date.now()),
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
