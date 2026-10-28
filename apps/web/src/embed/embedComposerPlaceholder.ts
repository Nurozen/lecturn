import type { EmbedHostContext } from "@lecturn/contracts/embedBridge";
import { useSyncExternalStore } from "react";

// A module store rather than the bridge itself: EmbedShell starts the bridge in an effect, which
// runs after the composer below it has subscribed.
let current: string | null = null;
const listeners = new Set<() => void>();

function setPlaceholder(next: string | null): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = () => current;

/** The host's idle composer prompt; null outside the embed and until the host sets one. */
export function useEmbedComposerPlaceholder(): string | null {
  return useSyncExternalStore(subscribe, read, read);
}

interface HostContextSource {
  readonly hostContext: () => EmbedHostContext | null;
  readonly subscribeHostContext: (listener: (context: EmbedHostContext) => void) => () => void;
}

export function installEmbedComposerPlaceholder(bridge: HostContextSource | null): () => void {
  if (bridge === null) return () => undefined;
  setPlaceholder(bridge.hostContext()?.composerPlaceholder ?? null);
  const unsubscribe = bridge.subscribeHostContext((context) =>
    setPlaceholder(context.composerPlaceholder ?? null),
  );
  return () => {
    unsubscribe();
    setPlaceholder(null);
  };
}
