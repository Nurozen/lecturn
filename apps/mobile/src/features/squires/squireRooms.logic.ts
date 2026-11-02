import {
  applySquireMention,
  SQUIRE_ROOM_PORTRAIT_CAP,
  squireRoomMentionState,
  squireRoomTtlHours,
  squireRoomTtlLabel,
  type SquireEnvironmentState,
  type SquireMentionCandidate,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  SquireId,
  SquireRoom,
  SquireRoomId,
  SquireRoomRow,
} from "@lecturn/contracts";

export type SquireRoomScreenState =
  | { readonly status: "unsupported" | "loading" | "missing" }
  | {
      readonly status: "ready";
      readonly row: SquireRoomRow;
      readonly squires: ReadonlyArray<SquireSnapshotEntry>;
      readonly lead: SquireSnapshotEntry | null;
    };

export function squireRoomScreenState(
  supported: boolean,
  state: SquireEnvironmentState | null,
  roomId: SquireRoomId,
): SquireRoomScreenState {
  if (!supported) return { status: "unsupported" };
  if (state === null) return { status: "loading" };
  const row = state.rooms.find((room) => room.id === roomId);
  if (row === undefined) return { status: "missing" };
  const lead = state.squires.find((entry) => entry.squire.id === state.lead) ?? null;
  return { status: "ready", row, squires: state.squires, lead };
}

/** Up to three member portraits, then the "+N" count (0 shows none). */
export function squireRoomPortraits(members: ReadonlyArray<SquireId>): {
  readonly portraits: ReadonlyArray<SquireId>;
  readonly overflow: number;
} {
  return {
    portraits: members.slice(0, SQUIRE_ROOM_PORTRAIT_CAP),
    overflow: Math.max(0, members.length - SQUIRE_ROOM_PORTRAIT_CAP),
  };
}

/** "Research, Release, Lead · Closes after 1 day idle", or the closed reason once closed. */
export function squireRoomStatusLine(input: {
  readonly row: Pick<SquireRoomRow, "members" | "includesLead" | "status" | "muted">;
  readonly room: Pick<SquireRoom, "idleTtlSeconds" | "closedReason"> | null;
  readonly nameOf: (squireId: SquireId) => string;
  readonly leadName: string | null;
}): string {
  const { row, room } = input;
  const names = row.members.map(input.nameOf);
  if (row.includesLead && input.leadName !== null) names.push(input.leadName);
  const parts = [names.join(", ")];
  if (row.status === "closed") {
    parts.push(room?.closedReason ? `Closed: ${room.closedReason}` : "Closed");
  } else if (room !== null) {
    parts.push(`Closes after ${squireRoomTtlLabel(squireRoomTtlHours(room))} idle`);
  }
  if (row.muted) parts.push("Muted");
  return parts.join(" · ");
}

export function squireRoomComposerPlaceholder(closed: boolean, canPost: boolean): string {
  if (closed) return "This room is closed. Reopen it to post.";
  if (!canPost) return "You can read this room but not post in it.";
  return "Post to the room. @ to mention a Squire.";
}

/**
 * The `@` completion at the cursor, and what tapping a suggestion leaves in the field. The
 * cursor is clamped because the selection event can land before the text event.
 */
export function squireRoomCompletion(
  text: string,
  cursor: number,
  members: ReadonlyArray<{ readonly squireId: SquireId; readonly name: string }>,
  lead: { readonly squireId: SquireId; readonly name: string } | null,
): {
  readonly candidates: ReadonlyArray<SquireMentionCandidate>;
  readonly insert: (name: string) => { readonly text: string; readonly cursor: number };
} | null {
  const state = squireRoomMentionState(text, Math.min(cursor, text.length), members, lead);
  if (state === null) return null;
  return {
    candidates: state.candidates,
    insert: (name) => applySquireMention(text, state.mention, name),
  };
}

/** Within this many points of the end, the log counts as showing its newest post. */
export const SQUIRE_ROOM_PINNED_SLACK = 80;

export function squireRoomPinned(metrics: {
  readonly contentHeight: number;
  readonly offsetY: number;
  readonly viewportHeight: number;
}): boolean {
  return (
    metrics.contentHeight - metrics.offsetY - metrics.viewportHeight < SQUIRE_ROOM_PINNED_SLACK
  );
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY_TIME = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Rooms live for days, so a post from another day carries its date. */
export function squireRoomPostTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toDateString() === new Date(now).toDateString()
    ? TIME.format(at)
    : DAY_TIME.format(at);
}

const seenKey = (environmentId: EnvironmentId, roomId: SquireRoomId) =>
  `${environmentId}\n${roomId}`;

/**
 * Each room's `lastPostAt` when this client last showed its newest post, so the home dot clears
 * at once instead of waiting for the read cursor to round-trip. Returns the same map when
 * nothing changed, so readers do not re-render.
 */
export function withSquireRoomSeen(
  seen: ReadonlyMap<string, string>,
  environmentId: EnvironmentId,
  roomId: SquireRoomId,
  lastPostAt: string | null,
): ReadonlyMap<string, string> {
  const key = seenKey(environmentId, roomId);
  if (lastPostAt === null || seen.get(key) === lastPostAt) return seen;
  return new Map(seen).set(key, lastPostAt);
}

export function squireRoomSeenAt(
  seen: ReadonlyMap<string, string>,
  environmentId: EnvironmentId,
  roomId: SquireRoomId,
): string | null {
  return seen.get(seenKey(environmentId, roomId)) ?? null;
}
