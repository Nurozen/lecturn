import { useCallback, useSyncExternalStore } from "react";

// Presentation state only: no thread metadata or provider session is changed.
const selections = new Map<string, string>();
const listeners = new Set<() => void>();
const MAX_SELECTIONS = 200;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThreadGitSelection(threadKey: string | null) {
  const getSnapshot = useCallback(
    () => (threadKey ? (selections.get(threadKey) ?? null) : null),
    [threadKey],
  );
  const selectedRepoKey = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const selectRepository = useCallback(
    (repoKey: string) => {
      if (!threadKey) return;
      selections.delete(threadKey);
      selections.set(threadKey, repoKey);
      while (selections.size > MAX_SELECTIONS) {
        const oldest = selections.keys().next().value;
        if (oldest !== undefined) selections.delete(oldest);
      }
      listeners.forEach((listener) => listener());
    },
    [threadKey],
  );
  return { selectedRepoKey, selectRepository };
}
