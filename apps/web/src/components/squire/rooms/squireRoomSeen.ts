import type { EnvironmentId, SquireRoomId } from "@lecturn/contracts";
import { useSyncExternalStore } from "react";

/**
 * Each room's `lastPostAt` when this client last showed its newest post, so the sidebar dot
 * clears at once instead of waiting for the server's read cursor to round-trip.
 */
const STORAGE_KEY = "lecturn:squire-room-seen:v1";

type SeenRecord = Record<string, Record<string, string>>;

const EMPTY: ReadonlyMap<SquireRoomId, string | null> = new Map();
let record: SeenRecord | null = null;
const maps = new Map<string, ReadonlyMap<SquireRoomId, string | null>>();
const listeners = new Set<() => void>();

function load(): SeenRecord {
  if (record !== null) return record;
  record = {};
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw == null ? null : JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") record = parsed as SeenRecord;
  } catch {
    // Unreadable storage leaves the dot to the server's `unread` alone.
  }
  return record;
}

export function markSquireRoomSeen(
  environmentId: EnvironmentId,
  roomId: SquireRoomId,
  lastPostAt: string | null,
) {
  if (lastPostAt === null) return;
  const current = load();
  if (current[environmentId]?.[roomId] === lastPostAt) return;
  record = { ...current, [environmentId]: { ...current[environmentId], [roomId]: lastPostAt } };
  maps.delete(environmentId);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // The in-memory copy still clears the dot for this session.
  }
  for (const listener of listeners) listener();
}

function seenFor(environmentId: EnvironmentId): ReadonlyMap<SquireRoomId, string | null> {
  const cached = maps.get(environmentId);
  if (cached !== undefined) return cached;
  const entries = load()[environmentId];
  const map =
    entries === undefined
      ? EMPTY
      : new Map(Object.entries(entries) as Array<[SquireRoomId, string]>);
  maps.set(environmentId, map);
  return map;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSquireRoomSeen(environmentId: EnvironmentId) {
  const snapshot = () => seenFor(environmentId);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
