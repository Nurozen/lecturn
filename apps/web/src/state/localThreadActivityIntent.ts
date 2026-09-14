import { useSyncExternalStore } from "react";
import { randomUUID } from "../lib/utils";

export interface LocalThreadActivityIntent {
  readonly id: string;
  readonly kind: "start" | "stop" | "settle" | "unsettle";
  readonly at: number;
}
const kinds = new Map<string, LocalThreadActivityIntent["kind"]>([
  ["environment-data:commands:thread:start-turn", "start"],
  ["environment-data:commands:thread:respond-to-approval", "start"],
  ["environment-data:commands:thread:respond-to-user-input", "start"],
  ["environment-data:commands:thread:interrupt-turn", "stop"],
  ["environment-data:commands:thread:stop-session", "stop"],
  ["environment-data:commands:thread:settle", "settle"],
  ["environment-data:commands:thread:unsettle", "unsettle"],
]);
export const localThreadActivityKey = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);

/** Local UI intent only: no prompt text, durable data, or server protocol changes. */
export function createLocalThreadActivityIntentStore(
  nextId: () => string = randomUUID,
  now: () => number = Date.now,
) {
  let snapshot: ReadonlyMap<string, LocalThreadActivityIntent> = new Map();
  const listeners = new Set<() => void>();
  const publish = (next: ReadonlyMap<string, LocalThreadActivityIntent>) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin: (commandLabel: string | undefined, target: unknown) => {
      const kind = commandLabel ? kinds.get(commandLabel) : undefined;
      if (
        !kind ||
        !target ||
        typeof target !== "object" ||
        !("environmentId" in target) ||
        typeof target.environmentId !== "string" ||
        !("input" in target) ||
        !target.input ||
        typeof target.input !== "object" ||
        !("threadId" in target.input) ||
        typeof target.input.threadId !== "string"
      )
        return null;
      const key = localThreadActivityKey(target.environmentId, target.input.threadId);
      const intent: LocalThreadActivityIntent = { id: nextId(), kind, at: now() };
      const next = new Map(snapshot);
      next.delete(key);
      next.set(key, intent);
      while (next.size > 200) next.delete(next.keys().next().value!);
      publish(next);
      return { key, id: intent.id };
    },
    cancel: (handle: { key: string; id: string } | null) => {
      if (!handle || snapshot.get(handle.key)?.id !== handle.id) return;
      const next = new Map(snapshot);
      next.delete(handle.key);
      publish(next);
    },
  };
}
export const localThreadActivityIntents = createLocalThreadActivityIntentStore();
export const useLocalThreadActivityIntents = () =>
  useSyncExternalStore(
    localThreadActivityIntents.subscribe,
    localThreadActivityIntents.getSnapshot,
    localThreadActivityIntents.getSnapshot,
  );
