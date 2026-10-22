import type { EnvironmentId, ServerConfig } from "@lecturn/contracts";
import { Atom } from "effect/reactivity";

/** Environments whose server advertises `threadForking`. */
export type ThreadForkSupport = ReadonlySet<EnvironmentId>;

/**
 * Thread-list fork gate: the server advertises `threadForking`. The provider
 * does not gate: V2 forks natively when it can and otherwise carries the
 * transcript as portable context (presentation `conversationFork` only
 * describes the native path). The value keeps its identity while the gate is
 * unchanged, so provider freshness updates do not re-render list rows.
 */
export function createThreadForkSupportAtom(
  configsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>,
) {
  let previousKey: string | null = null;
  let previous: ThreadForkSupport = new Set();
  return Atom.make((get) => {
    const next = new Set<EnvironmentId>();
    for (const [environmentId, config] of get(configsAtom)) {
      if (config.environment.capabilities.threadForking === true) next.add(environmentId);
    }
    const key = JSON.stringify([...next]);
    if (key !== previousKey) {
      previousKey = key;
      previous = next;
    }
    return previous;
  }).pipe(Atom.withLabel("thread-fork-support"));
}

export function threadForkSupported(
  support: ThreadForkSupport,
  thread: { readonly environmentId: EnvironmentId },
): boolean {
  return support.has(thread.environmentId);
}
