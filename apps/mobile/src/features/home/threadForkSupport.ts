import type { EnvironmentId, ServerConfig } from "@lecturn/contracts";
import { Atom } from "effect/reactivity";

/** Environments whose server advertises `threadForking`. */
export type ThreadForkSupport = ReadonlySet<EnvironmentId>;

/**
 * Gates on the server's `threadForking` only; V2 carries the transcript as portable context
 * when it cannot fork natively. The value keeps its identity while the gate is unchanged,
 * so provider freshness updates do not re-render list rows.
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
