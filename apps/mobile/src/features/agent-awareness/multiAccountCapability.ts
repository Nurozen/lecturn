import { useEffect, useSyncExternalStore } from "react";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";

let supported = false;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
export function getMultiAccountPushSupported(): boolean {
  return supported;
}
export async function refreshMultiAccountPushCapability(): Promise<void> {
  if (pending) return pending;
  const relay = resolveCloudPublicConfig().relay.url;
  if (!relay) return;
  pending = (async () => {
    let next = false;
    try {
      const response = await fetch(
        `${relay.replace(/\/$/, "")}/.well-known/oauth-protected-resource`,
      );
      if (response.ok) {
        const document: unknown = await response.json();
        next =
          typeof document === "object" &&
          document !== null &&
          "capabilities" in document &&
          typeof document.capabilities === "object" &&
          document.capabilities !== null &&
          "multiAccountPush" in document.capabilities &&
          document.capabilities.multiAccountPush === true;
      }
    } catch {
      /* Unknown relays fail closed for adding accounts on iOS. */
    }
    if (next !== supported) {
      supported = next;
      for (const listener of listeners) listener();
    }
  })().finally(() => {
    pending = null;
  });
  return pending;
}
export function useMultiAccountPushSupported(): boolean {
  const result = useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, getMultiAccountPushSupported);
  useEffect(() => {
    void refreshMultiAccountPushCapability();
  }, []);
  return result;
}
