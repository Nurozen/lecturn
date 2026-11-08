import type { EnvironmentId } from "@lecturn/contracts";

import { useBrowserHistoryStore } from "./browserHistoryStore";
import { useDiffPanelStore } from "./diffPanelStore";
import { useRightPanelStore } from "./rightPanelStore";
import { useTerminalUiStateStore } from "./terminalUiStateStore";
import { useUiStateStore } from "./uiStateStore";

/**
 * Drops the entries whose scoped key (`environmentId:localId`) belongs to the
 * environment. Returns the same record when it holds none, so stores do not
 * notify or persist for nothing.
 */
function withoutEnvironment<T>(
  record: Record<string, T>,
  environmentId: EnvironmentId,
): Record<string, T> {
  const prefix = `${environmentId}:`;
  const kept = Object.entries(record).filter(([key]) => !key.startsWith(prefix));
  return kept.length === Object.keys(record).length ? record : Object.fromEntries(kept);
}

/** Applies a change, and leaves the store alone when nothing in it changed. */
function sweep<S extends object>(
  store: { readonly setState: (update: (state: S) => S | Partial<S>) => void },
  change: (state: S) => Partial<S>,
): void {
  store.setState((state) => {
    const next = change(state);
    return Object.entries(next).every(([key, value]) => Object.is(state[key as keyof S], value))
      ? state
      : next;
  });
}

/**
 * Clears thread and project entries keyed by a signed-out account's environment. Shared
 * project keys (repository identity), device-level state, and the environment-agnostic
 * `prompt-stash` and `last-invoked-script-by-project` stay.
 */
export function clearEnvironmentOwnedState(environmentId: EnvironmentId): void {
  const prefix = `${environmentId}:`;
  sweep(useUiStateStore, (state) => {
    const projectOrder = state.projectOrder.filter((key) => !key.startsWith(prefix));
    return {
      projectExpandedById: withoutEnvironment(state.projectExpandedById, environmentId),
      projectOrder:
        projectOrder.length === state.projectOrder.length ? state.projectOrder : projectOrder,
      threadLastVisitedAtById: withoutEnvironment(state.threadLastVisitedAtById, environmentId),
      threadChangedFilesExpandedById: withoutEnvironment(
        state.threadChangedFilesExpandedById,
        environmentId,
      ),
    };
  });
  sweep(useTerminalUiStateStore, (state) => ({
    terminalUiStateByThreadKey: withoutEnvironment(state.terminalUiStateByThreadKey, environmentId),
    suppressedTerminalIdsByThreadKey: withoutEnvironment(
      state.suppressedTerminalIdsByThreadKey,
      environmentId,
    ),
  }));
  sweep(useRightPanelStore, (state) => ({
    byThreadKey: withoutEnvironment(state.byThreadKey, environmentId),
    userActionRevisionByThreadKey: withoutEnvironment(
      state.userActionRevisionByThreadKey,
      environmentId,
    ),
  }));
  sweep(useDiffPanelStore, (state) => ({
    byThreadKey: withoutEnvironment(state.byThreadKey, environmentId),
    branchBaseRefByThreadKey: withoutEnvironment(state.branchBaseRefByThreadKey, environmentId),
  }));
  sweep(useBrowserHistoryStore, (state) => ({
    byProjectKey: withoutEnvironment(state.byProjectKey, environmentId),
    projectKeyByThreadKey: withoutEnvironment(state.projectKeyByThreadKey, environmentId),
    pendingVisitsByThreadKey: withoutEnvironment(state.pendingVisitsByThreadKey, environmentId),
  }));
}
