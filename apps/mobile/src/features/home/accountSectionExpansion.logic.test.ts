import { describe, expect, it, vi } from "vite-plus/test";
import { makeAccountSectionActions } from "./accountSectionExpansion.logic";

function harness(initial: ReadonlyArray<string> | null) {
  let keys = initial;
  const listeners = new Set<() => void>();
  const save = vi.fn((next: ReadonlyArray<string>) => {
    keys = next;
  });
  const actions = makeAccountSectionActions({
    read: () => keys,
    save,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return {
    actions,
    save,
    read: () => keys,
    hydrate: (next: ReadonlyArray<string>) => {
      keys = next;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

describe("account section preference updates", () => {
  it("waits for hydration and preserves other collapsed groups", () => {
    const state = harness(null);
    state.actions.expand("a");
    state.actions.toggle("connect-account:b");
    state.actions.setProject("project:two", true);
    expect(state.save).not.toHaveBeenCalled();
    state.hydrate(["project:one", "connect-account:a"]);
    expect(state.read()).toEqual(["project:one", "connect-account:b", "project:two"]);
    expect(state.listeners.size).toBe(0);
  });
  it("preserves an account expansion when a project toggle carries a stale account list", () => {
    const state = harness(["connect-account:a", "connect-account:b"]);
    state.actions.expand("a");
    state.actions.replaceProjects(["project:one", "connect-account:a", "connect-account:b"]);
    expect(state.read()).toEqual(["project:one", "connect-account:b"]);
    state.actions.toggle("connect-account:b");
    state.actions.toggle("connect-account:b");
    expect(state.read()).toEqual(["project:one", "connect-account:b"]);
  });
  it("does not persist an already-expanded account", () => {
    const state = harness(["project:one"]);
    state.actions.expand("a");
    expect(state.save).not.toHaveBeenCalled();
  });
});
