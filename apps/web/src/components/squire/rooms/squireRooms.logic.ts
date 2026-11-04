import { SQUIRE_ROOM_PORTRAIT_CAP, squireRoomUnread } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireId, SquireRoomId, SquireRoomRow } from "@lecturn/contracts";

const SQUIRE_ROOM_MIN_MEMBERS = 2;
export const SQUIRE_ROOM_MAX_MEMBERS = 6;

export interface SquireRoomSidebarRow {
  readonly id: SquireRoomId;
  readonly topic: string;
  /** Up to three member portraits, in member order. */
  readonly portraits: ReadonlyArray<SquireId>;
  /** The "+N" after the portraits; 0 shows none. */
  readonly overflow: number;
  readonly unread: boolean;
}

const postedAt = (row: Pick<SquireRoomRow, "lastPostAt">) =>
  row.lastPostAt === null ? Number.NEGATIVE_INFINITY : Date.parse(row.lastPostAt);

/**
 * Rows under the Lead after its Squires: open rooms only, most recent post first (a room
 * with no posts sorts by nothing newer, so it comes last), unread only for a member who has not
 * muted the room (`squireRoomUnread`). `seen` is this client's last shown `lastPostAt` per room.
 */
export function squireRoomSidebarRows(
  rooms: ReadonlyArray<SquireRoomRow>,
  seen: ReadonlyMap<SquireRoomId, string | null>,
): ReadonlyArray<SquireRoomSidebarRow> {
  return rooms
    .filter((room) => room.status === "open")
    .toSorted((a, b) => postedAt(b) - postedAt(a))
    .map((room) => ({
      id: room.id,
      topic: room.topic,
      portraits: room.members.slice(0, SQUIRE_ROOM_PORTRAIT_CAP),
      overflow: Math.max(0, room.members.length - SQUIRE_ROOM_PORTRAIT_CAP),
      unread: squireRoomUnread(room, seen.get(room.id)),
    }));
}

/** Palette "Open room: <topic>" per open room; closed rooms stay reachable from the Rooms menu. */
export function squireRoomPaletteEntries(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly rooms: ReadonlyArray<SquireRoomRow>;
  }>,
): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly roomId: SquireRoomId;
  readonly title: string;
}> {
  return environments.flatMap(({ environmentId, rooms }) =>
    rooms
      .filter((room) => room.status === "open")
      .map((room) => ({ environmentId, roomId: room.id, title: `Open room: ${room.topic}` })),
  );
}

/** The Rooms menu: open rooms by recent post, then closed ones the same way. */
export function squireRoomMenuGroups(rooms: ReadonlyArray<SquireRoomRow>): {
  readonly open: ReadonlyArray<SquireRoomRow>;
  readonly closed: ReadonlyArray<SquireRoomRow>;
} {
  const sorted = rooms.toSorted((a, b) => postedAt(b) - postedAt(a));
  return {
    open: sorted.filter((room) => room.status === "open"),
    closed: sorted.filter((room) => room.status === "closed"),
  };
}

const TTL_PRESETS = [1, 4, 12, 24, 48, 72, 168] as const;

/** Idle TTL choices (1 h to 7 days), keeping a value set elsewhere that is not a preset. */
export function squireRoomTtlOptions(current: number | null): ReadonlyArray<number> {
  if (current === null || TTL_PRESETS.some((hours) => hours === current)) return TTL_PRESETS;
  return [...TTL_PRESETS, current].toSorted((a, b) => a - b);
}

/** Client-side checks before New room sends; the server's cap errors show as they come. */
export function squireRoomCreateProblem(input: {
  readonly topic: string;
  readonly memberCount: number;
}): string | null {
  if (input.memberCount < SQUIRE_ROOM_MIN_MEMBERS) return "Choose at least 2 Squires.";
  if (input.memberCount > SQUIRE_ROOM_MAX_MEMBERS) return "A room holds at most 6 Squires.";
  if (input.topic.trim() === "") return "Add a topic.";
  return null;
}
