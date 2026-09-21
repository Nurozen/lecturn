const prefix = "connect-account:";
export const isAccountSectionKey = (key: string) => key.startsWith(prefix);

/** Defer transforms until hydration, then read the latest optimistic preference for each action. */
export function makeAccountSectionActions(adapter: {
  readonly read: () => ReadonlyArray<string> | null;
  readonly subscribe: (ready: () => void) => () => void;
  readonly save: (keys: ReadonlyArray<string>) => void;
}) {
  const pending: Array<(keys: ReadonlyArray<string>) => ReadonlyArray<string>> = [];
  let unsubscribe: (() => void) | null = null;
  function flush() {
    const current = adapter.read();
    if (current === null || pending.length === 0) return;
    const changes = pending.splice(0);
    unsubscribe?.();
    unsubscribe = null;
    const next = changes.reduce((keys, transform) => transform(keys), current);
    if (next.length !== current.length || next.some((key, index) => current[index] !== key))
      adapter.save(next);
  }
  function apply(transform: (keys: ReadonlyArray<string>) => ReadonlyArray<string>) {
    pending.push(transform);
    flush();
    if (pending.length && !unsubscribe) {
      unsubscribe = adapter.subscribe(flush);
      flush();
      if (!pending.length) {
        unsubscribe?.();
        unsubscribe = null;
      }
    }
  }
  return {
    expand: (accountId: string) =>
      apply((keys) => keys.filter((key) => key !== `${prefix}${accountId}`)),
    toggle: (key: string) => {
      if (isAccountSectionKey(key))
        apply((keys) =>
          keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key],
        );
    },
    setProject: (key: string, collapsed: boolean) => {
      if (!isAccountSectionKey(key))
        apply((keys) =>
          collapsed ? [...new Set([...keys, key])] : keys.filter((entry) => entry !== key),
        );
    },
    replaceProjects: (keys: ReadonlyArray<string>) =>
      apply((current) => [
        ...new Set([
          ...keys.filter((key) => !isAccountSectionKey(key)),
          ...current.filter(isAccountSectionKey),
        ]),
      ]),
  };
}
