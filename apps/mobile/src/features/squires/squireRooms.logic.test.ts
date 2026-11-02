import type { SquireEnvironmentState } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireId, SquireRoomId, SquireRoomRow } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SQUIRE_HANDOFF_COLLAPSED_LINES,
  SQUIRE_ROOM_LOG_ANCHOR_INDEX,
  squireHandoffToggle,
  squireRoomCompletion,
  squireRoomComposerPlaceholder,
  squireRoomPinned,
  squireRoomPostTime,
  squireRoomScreenState,
  squireRoomSeenAt,
  squireRoomStatusLine,
  withSquireRoomSeen,
} from "./squireRooms.logic";

const ENV = "env" as EnvironmentId;
const ROOM = "room" as SquireRoomId;
const members = [
  { squireId: "r" as SquireId, name: "Research" },
  { squireId: "rel" as SquireId, name: "Release" },
];
const lead = { squireId: "lead" as SquireId, name: "Lead" };

describe("mention completion", () => {
  it("suggests members and the Lead for the @ token at the cursor, and a tap inserts the name", () => {
    const text = "@re can you check";
    const completion = squireRoomCompletion(text, 3, members, lead);
    expect(completion?.candidates.map((candidate) => candidate.name)).toEqual([
      "Release",
      "Research",
    ]);
    expect(completion!.insert("Research")).toEqual({
      text: "@Research can you check",
      cursor: 10,
    });
    // After the insert, the caret sits past the mention, so the suggestions close.
    const next = completion!.insert("Research");
    expect(squireRoomCompletion(next.text, next.cursor, members, lead)).toBeNull();
  });

  it("offers the Lead even when it is not a member", () => {
    expect(squireRoomCompletion("ask @l", 6, members, lead)?.candidates).toEqual([
      { squireId: "lead", name: "Lead", isLead: true },
    ]);
  });

  it("stays closed with no match, no @, or an email-like word", () => {
    expect(squireRoomCompletion("hi @zz", 6, members, lead)).toBeNull();
    expect(squireRoomCompletion("hello", 5, members, lead)).toBeNull();
    expect(squireRoomCompletion("me@re", 5, members, lead)).toBeNull();
  });

  it("clamps a cursor that ran ahead of the text", () => {
    expect(squireRoomCompletion("@re", 7, members, lead)?.candidates).toHaveLength(2);
  });
});

describe("room screen", () => {
  const row = (overrides: Partial<SquireRoomRow> = {}) =>
    ({
      id: ROOM,
      topic: "Flaky CI",
      status: "open",
      muted: false,
      members: ["r", "rel"],
      includesLead: true,
      unread: false,
      lastPostAt: null,
      ...overrides,
    }) as SquireRoomRow;

  it("gates on the capability, then waits for the snapshot, then finds the room", () => {
    const state = {
      lead: "lead" as SquireId,
      squires: [{ squire: { id: "lead", name: "Lead" } }],
      rooms: [row()],
    } as unknown as SquireEnvironmentState;
    expect(squireRoomScreenState(false, state, ROOM).status).toBe("unsupported");
    expect(squireRoomScreenState(true, null, ROOM).status).toBe("loading");
    expect(squireRoomScreenState(true, state, "other" as SquireRoomId).status).toBe("missing");
    expect(squireRoomScreenState(true, state, ROOM)).toMatchObject({
      status: "ready",
      lead: { squire: { id: "lead" } },
    });
  });

  it("names members, the Lead, and the idle close or closed reason", () => {
    const nameOf = (id: SquireId) => members.find((m) => m.squireId === id)?.name ?? "?";
    const room = { idleTtlSeconds: 86_400, closedReason: null };
    expect(squireRoomStatusLine({ row: row(), room, nameOf, leadName: "Lead" })).toBe(
      "Research, Release, Lead · Closes after 1 day idle",
    );
    expect(
      squireRoomStatusLine({
        row: row({ status: "closed", includesLead: false, muted: true }),
        room: { ...room, closedReason: "user" },
        nameOf,
        leadName: "Lead",
      }),
    ).toBe("Research, Release · Closed by you · Muted");
    const closed = (closedReason: string | null) =>
      squireRoomStatusLine({
        row: row({ status: "closed", includesLead: false }),
        room: { ...room, closedReason },
        nameOf,
        leadName: "Lead",
      });
    expect(closed("idle")).toBe("Research, Release · Closed after 1 day idle");
    expect(closed("members")).toBe("Research, Release · Closed: fewer than 2 Squires");
    expect(closed("lead")).toBe("Research, Release · Closed by Lead");
    expect(closed(null)).toBe("Research, Release · Closed");
    expect(squireRoomStatusLine({ row: row(), room: null, nameOf, leadName: null })).toBe(
      "Research, Release",
    );
  });

  it("explains why the composer is off", () => {
    expect(squireRoomComposerPlaceholder(true, true)).toMatch(/closed/);
    expect(squireRoomComposerPlaceholder(false, false)).toMatch(/read this room/);
    expect(squireRoomComposerPlaceholder(false, true)).toMatch(/@ to mention/);
  });

  it("counts the log as showing its newest post only near the end", () => {
    expect(squireRoomPinned({ contentHeight: 2000, offsetY: 1300, viewportHeight: 650 })).toBe(
      true,
    );
    expect(squireRoomPinned({ contentHeight: 2000, offsetY: 900, viewportHeight: 650 })).toBe(
      false,
    );
    expect(squireRoomPinned({ contentHeight: 300, offsetY: 0, viewportHeight: 650 })).toBe(true);
  });

  it("keeps the post being read in place when an earlier page loads above it", () => {
    // React Native's rule: the anchor is the first child at or after minIndexForVisible whose
    // bottom is past the scroll offset; after the mount the offset moves by the anchor's shift.
    type Child = { readonly key: string; readonly height: number };
    const tops = (children: ReadonlyArray<Child>) => {
      let y = 0;
      return new Map(children.map((child) => [child.key, (y += child.height) - child.height]));
    };
    const keepPosition = (before: ReadonlyArray<Child>, after: ReadonlyArray<Child>) => {
      const was = tops(before);
      const anchor = before
        .slice(SQUIRE_ROOM_LOG_ANCHOR_INDEX)
        .find((child) => was.get(child.key)! + child.height > 0);
      const now = tops(after).get(anchor?.key ?? "");
      return anchor === undefined || now === undefined ? 0 : now - was.get(anchor.key)!;
    };
    const posts = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({ key: `post ${from + i}`, height: 90 }));
    const header = { key: "header", height: 220 };
    const loadEarlier = { key: "load earlier", height: 47 };
    const reading = [header, loadEarlier, ...posts(11, 60)];
    // Tapping removes the button, then the page arrives: post 11 must stay where it was.
    const loading = [header, ...posts(11, 60)];
    const loaded = [header, ...posts(1, 60)];
    const shift = keepPosition(reading, loading);
    const pageShift = keepPosition(loading, loaded);
    expect(tops(loading).get("post 11")! - shift).toBe(tops(reading).get("post 11"));
    expect(tops(loaded).get("post 11")! - shift - pageShift).toBe(tops(reading).get("post 11"));
  });

  it("dates posts from another day", () => {
    const now = Date.parse("2026-11-01T15:00:00");
    expect(squireRoomPostTime("2026-11-01T10:05:00", now)).not.toMatch(/Nov/);
    expect(squireRoomPostTime("2026-10-30T10:05:00", now)).toMatch(/Oct/);
    expect(squireRoomPostTime("nope", now)).toBe("");
  });
});

describe("seen cursor", () => {
  it("records the newest shown post per room and keeps the map when nothing changed", () => {
    const empty: ReadonlyMap<string, string> = new Map();
    const at = "2026-11-01T10:00:00.000Z";
    const seen = withSquireRoomSeen(empty, ENV, ROOM, at);
    expect(squireRoomSeenAt(seen, ENV, ROOM)).toBe(at);
    expect(squireRoomSeenAt(seen, "other" as EnvironmentId, ROOM)).toBeNull();
    expect(withSquireRoomSeen(seen, ENV, ROOM, at)).toBe(seen);
    expect(withSquireRoomSeen(seen, ENV, ROOM, null)).toBe(seen);
  });
});

describe("handoff toggle", () => {
  it("offers more only when the handoff runs past its collapsed lines, and less once expanded", () => {
    expect(squireHandoffToggle(1, false)).toBeNull();
    expect(squireHandoffToggle(SQUIRE_HANDOFF_COLLAPSED_LINES, false)).toBeNull();
    expect(squireHandoffToggle(SQUIRE_HANDOFF_COLLAPSED_LINES + 1, false)).toBe("more");
    expect(squireHandoffToggle(SQUIRE_HANDOFF_COLLAPSED_LINES + 1, true)).toBe("less");
  });
});
