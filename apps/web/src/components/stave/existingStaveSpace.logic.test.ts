import type { StaveSpaceListRow } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  archivedSagaRow,
  deleteStaveArchiveCopy,
  existingStaveSpaceEmptyMessage,
  sagaAdoptCandidates,
  staveArchiveTaskLabel,
} from "./existingStaveSpace.logic";

function row(overrides: Partial<StaveSpaceListRow> & { id: string }): StaveSpaceListRow {
  return {
    path: `/spaces/${overrides.id}`,
    isSaga: false,
    repos: [],
    archived: false,
    logicalId: overrides.id,
    manifestCreatedAt: "2026-01-01T00:00:00.000000000Z",
    manifestVersion: 4,
    memories: [],
    ...overrides,
  };
}

describe("staveArchiveTaskLabel", () => {
  it("counts restore steps and leaves uncounted steps bare", () => {
    const running = { status: "running", operationId: null } as const;
    expect(staveArchiveTaskLabel({ ...running, label: "Restore saga", step: 2, total: 3 })).toBe(
      "Restore saga (2/3)",
    );
    expect(
      staveArchiveTaskLabel({ ...running, label: "Reading archives", step: 0, total: 0 }),
    ).toBe("Reading archives");
  });
});

describe("existingStaveSpaceEmptyMessage", () => {
  it("points at hidden archives only while they are hidden", () => {
    expect(
      existingStaveSpaceEmptyMessage({ kind: "space", showArchived: false, archivedCount: 2 }),
    ).toBe("No spaces to add. 2 archived hidden.");
    expect(
      existingStaveSpaceEmptyMessage({ kind: "saga", showArchived: true, archivedCount: 0 }),
    ).toBe("No sagas to add.");
  });
});

describe("deleteStaveArchiveCopy", () => {
  it("adds the saga member rules only for sagas", () => {
    const space = deleteStaveArchiveCopy({ spaceId: "feat", isSaga: false });
    const saga = deleteStaveArchiveCopy({ spaceId: "epic", isSaga: true });
    expect(space.title).toBe("Delete feat permanently?");
    expect(saga.paragraphs.length).toBe(space.paragraphs.length + 1);
    expect(saga.paragraphs.at(-1)).toContain("live members is restored but not deleted");
  });

  it("warns that a saga member leaves its saga", () => {
    const member = deleteStaveArchiveCopy({ spaceId: "feat", isSaga: false, memberOf: "epic" });
    expect(member.paragraphs.at(-1)).toContain("If saga epic still lists it");
  });
});

describe("archivedSagaRow", () => {
  it("finds the archived saga at the project's root, not a live space there", () => {
    const archive = row({
      id: "epic",
      path: "/spaces/.archive/epic-1",
      isSaga: true,
      archived: true,
    });
    const rows = [
      row({ id: "epic", isSaga: true }),
      row({ id: "other", path: "/spaces/.archive/epic-1", archived: true }),
      archive,
    ];
    expect(archivedSagaRow(rows, "/spaces/.archive/epic-1")).toBe(archive);
    expect(archivedSagaRow(rows, "/spaces/epic")).toBeNull();
  });
});

describe("sagaAdoptCandidates", () => {
  const rows = [
    row({ id: "free" }),
    row({ id: "mine", memberOf: "epic" }),
    row({ id: "theirs", memberOf: "other" }),
    row({ id: "saga", isSaga: true }),
    row({ id: "broken", error: "bad manifest" }),
    (({ manifestCreatedAt: _stamp, ...legacy }) => legacy)(row({ id: "legacy" })),
    row({ id: "old", path: "/spaces/.archive/old-1", archived: true, archiveBasename: "old-1" }),
    row({ id: "gone", path: "/spaces/.archive/gone", archived: true }),
  ];

  it("offers live free or own spaces and counts restorable archives", () => {
    const { candidates, archivedCount } = sagaAdoptCandidates(rows, "epic", false);
    expect(candidates.map((candidate) => candidate.id)).toEqual(["free", "mine"]);
    expect(archivedCount).toBe(1);
  });

  it("adds restorable archives when shown", () => {
    const { candidates } = sagaAdoptCandidates(rows, "epic", true);
    expect(candidates.map((candidate) => candidate.id)).toEqual(["free", "mine", "old"]);
  });
});
