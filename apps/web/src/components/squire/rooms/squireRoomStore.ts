import type { EnvironmentId, SquireId, SquireRef } from "@lecturn/contracts";
import { useSyncExternalStore } from "react";

/** One New room dialog for every entry point: the "+" menu, the Lead header, and the palette. */
export interface SquireRoomCreateTarget {
  readonly environmentId: EnvironmentId;
  readonly members?: ReadonlyArray<SquireId>;
  readonly about?: ReadonlyArray<SquireRef>;
}

let current: SquireRoomCreateTarget | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function openSquireRoomCreate(target: SquireRoomCreateTarget) {
  current = target;
  emit();
}

export function closeSquireRoomCreate() {
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

export function useSquireRoomCreateTarget(): SquireRoomCreateTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
