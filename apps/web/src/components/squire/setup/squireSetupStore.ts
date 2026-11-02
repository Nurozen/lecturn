import type { EnvironmentId, SquireCardId, SquireId } from "@lecturn/contracts";
import type { SquireCardPayload } from "@lecturn/contracts";
import { useSyncExternalStore } from "react";

type SquireProposalPayload = Extract<SquireCardPayload, { readonly type: "squire-proposal" }>;

/**
 * Every entry point opens the one setup sheet: the view's gear, the "+" menu, the
 * palette, Settings, and Edit on a Lead proposal, which saves as a new Squire and then
 * dismisses the proposal.
 */
export type SquireSetupTarget =
  | {
      readonly kind: "create";
      readonly environmentId: EnvironmentId;
    }
  | {
      readonly kind: "edit";
      readonly environmentId: EnvironmentId;
      readonly squireId: SquireId;
    }
  | {
      readonly kind: "proposal";
      readonly environmentId: EnvironmentId;
      readonly cardId: SquireCardId;
      readonly proposal: SquireProposalPayload;
    };

let current: SquireSetupTarget | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function openSquireSetup(target: SquireSetupTarget) {
  current = target;
  emit();
}

export function closeSquireSetup() {
  if (current === null) return;
  current = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => current;

export function useSquireSetupTarget(): SquireSetupTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
