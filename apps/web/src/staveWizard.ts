import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Bus between the places that launch the Stave wizard (the command palette's
 * add-project sources, a saga's project section) and the dialog host mounted
 * in `__root.tsx`, on the `confirmDialog.ts` pattern: module state, a change
 * listener set, and a reset hook for tests.
 */

export type StaveWizardKind = "space" | "saga";

export interface StaveWizardRequest {
  readonly environmentId: EnvironmentId;
  readonly kind: StaveWizardKind;
  /** Launched from inside a saga: the new space is enrolled in the saga rooted here. */
  readonly saga?: { readonly root: string };
}

export type StaveWizardState =
  | { readonly status: "closed" }
  | { readonly status: "open"; readonly request: StaveWizardRequest };

const closedState: StaveWizardState = { status: "closed" };
let state: StaveWizardState = closedState;
const listeners = new Set<() => void>();

function publish(next: StaveWizardState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export function readStaveWizardState(): StaveWizardState {
  return state;
}

export function subscribeStaveWizard(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Opens the wizard for `request`; a request while one is open replaces it. */
export function openStaveWizard(request: StaveWizardRequest): void {
  publish({ status: "open", request });
}

export function closeStaveWizard(): void {
  if (state.status === "closed") return;
  publish(closedState);
}

export function resetStaveWizardForTests(): void {
  publish(closedState);
  listeners.clear();
}
