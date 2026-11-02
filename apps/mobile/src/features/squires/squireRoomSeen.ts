import { Atom } from "effect/reactivity";

/**
 * In memory only: it bridges the read cursor's round-trip, after which the server's `unread`
 * is authoritative again, so nothing needs to survive a relaunch.
 */
export const squireRoomSeenAtom = Atom.make<ReadonlyMap<string, string>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-squire-room-seen"),
);
