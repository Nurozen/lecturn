import type { EnvironmentId } from "@lecturn/contracts";

// A completed mutation may have partially changed disk state even when it failed.
const listeners = new Set<(environmentId: EnvironmentId) => void>();
export function notifyStaveMutation(environmentId: EnvironmentId) {
  for (const listener of listeners) listener(environmentId);
}
export function subscribeStaveMutation(listener: (environmentId: EnvironmentId) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
