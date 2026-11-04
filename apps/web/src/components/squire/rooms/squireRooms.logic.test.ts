import { EnvironmentId, SquireId, SquireRoomId, type SquireRoomRow } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  squireRoomCreateProblem,
  squireRoomMenuGroups,
  squireRoomPaletteEntries,
  squireRoomSidebarRows,
  squireRoomTtlOptions,
} from "./squireRooms.logic";

const ids = ["a", "b", "c", "d", "e"].map((id) => SquireId.make(id));
const room = (id: string, patch: Partial<SquireRoomRow> = {}): SquireRoomRow => ({
  id: SquireRoomId.make(id),
  topic: `Topic ${id}`,
  status: "open",
  muted: false,
  members: ids.slice(0, 2),
  includesLead: false,
  unread: false,
  lastPostAt: null,
  ...patch,
});

describe("squireRoomSidebarRows", () => {
  it("lists open rooms only, most recent post first", () => {
    const rows = squireRoomSidebarRows(
      [
        room("old", { lastPostAt: "2026-11-01T09:00:00.000Z" }),
        room("closed", { status: "closed", lastPostAt: "2026-11-01T12:00:00.000Z" }),
        room("new", { lastPostAt: "2026-11-01T11:00:00.000Z" }),
        room("silent"),
      ],
      new Map(),
    );
    expect(rows.map((row) => row.id)).toEqual(["new", "old", "silent"]);
  });

  it("stacks up to three portraits and counts the rest", () => {
    const [row] = squireRoomSidebarRows([room("r", { members: ids })], new Map());
    expect(row?.portraits).toEqual(ids.slice(0, 3));
    expect(row?.overflow).toBe(2);
  });

  it("shows unread only when unmuted and newer than what this client last showed", () => {
    const at = "2026-11-01T10:00:00.000Z";
    const rows = squireRoomSidebarRows(
      [
        room("unread", { unread: true, lastPostAt: at }),
        room("muted", { unread: true, muted: true, lastPostAt: at }),
        room("seen", { unread: true, lastPostAt: at }),
      ],
      new Map([[SquireRoomId.make("seen"), at]]),
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, row.unread]))).toEqual({
      unread: true,
      muted: false,
      seen: false,
    });
  });
});

describe("squireRoomPaletteEntries", () => {
  it("offers Open room for open rooms only", () => {
    const environmentId = EnvironmentId.make("env");
    const entries = squireRoomPaletteEntries([
      { environmentId, rooms: [room("r"), room("c", { status: "closed" })] },
    ]);
    expect(entries.map((entry) => entry.title)).toEqual(["Open room: Topic r"]);
  });
});

describe("squireRoomMenuGroups", () => {
  it("lists open rooms then closed ones, each by most recent post", () => {
    const { open, closed } = squireRoomMenuGroups([
      room("c1", { status: "closed", lastPostAt: "2026-11-01T08:00:00.000Z" }),
      room("o1", { lastPostAt: "2026-11-01T08:00:00.000Z" }),
      room("c2", { status: "closed", lastPostAt: "2026-11-01T09:00:00.000Z" }),
      room("o2", { lastPostAt: "2026-11-01T09:00:00.000Z" }),
    ]);
    expect(open.map((r) => r.id)).toEqual(["o2", "o1"]);
    expect(closed.map((r) => r.id)).toEqual(["c2", "c1"]);
  });
});

describe("room settings", () => {
  it("keeps a TTL set elsewhere among the presets", () => {
    expect(squireRoomTtlOptions(24)).toEqual([1, 4, 12, 24, 48, 72, 168]);
    expect(squireRoomTtlOptions(6)).toEqual([1, 4, 6, 12, 24, 48, 72, 168]);
  });

  it("needs 2 to 6 Squires and a topic before New room sends", () => {
    expect(squireRoomCreateProblem({ topic: "Release", memberCount: 1 })).toBe(
      "Choose at least 2 Squires.",
    );
    expect(squireRoomCreateProblem({ topic: "  ", memberCount: 2 })).toBe("Add a topic.");
    expect(squireRoomCreateProblem({ topic: "Release", memberCount: 6 })).toBeNull();
  });
});
