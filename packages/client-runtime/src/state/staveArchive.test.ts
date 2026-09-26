import {
  ProjectId,
  type StaveDryRunPlan,
  type StaveOperation,
  type StaveOperationResult,
  type StaveSpaceListRow,
} from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  deleteStaveArchive,
  existingStaveSpaceDetail,
  existingStaveSpaces,
  restoreStaveArchive,
  staveArchiveUndo,
  type StaveArchiveClient,
  type StaveArchiveTaskState,
  staveRestoreSteps,
  undoStaveArchive,
  withoutArchivedStaveProjects,
} from "./staveArchive.ts";
import type { StaveOperationState } from "./staveOperation.ts";

const WORK = "/stave/agent-work";
const STAMP = "2026-09-01T10:00:00.123456Z";

const row = (
  id: string,
  overrides: Partial<StaveSpaceListRow> & { readonly basename?: string } = {},
): StaveSpaceListRow => {
  const { basename, ...rest } = overrides;
  const archived = rest.archived ?? basename !== undefined;
  return {
    id: basename ?? id,
    logicalId: id,
    path: archived ? `${WORK}/.archive/${basename ?? id}` : `${WORK}/${id}`,
    isSaga: false,
    repos: [{ name: "api", mode: "edit" }],
    archived,
    manifestVersion: 2,
    memories: [],
    manifestCreatedAt: STAMP,
    ...(archived ? { archiveBasename: basename ?? id } : {}),
    ...rest,
  };
};

const project = (
  id: string,
  workspaceRoot: string,
  stave?: { spaceId: string; createdAt?: string; state?: "live" | "archived" },
) => ({ id: ProjectId.make(id), title: id, workspaceRoot, stave });

describe("withoutArchivedStaveProjects", () => {
  it("hides archived Stave projects and keeps everything else", () => {
    const projects = [
      project("plain", "/repo"),
      project("live", `${WORK}/a`, { spaceId: "a", state: "live" }),
      project("gone", `${WORK}/.archive/b`, { spaceId: "b", state: "archived" }),
      project("unknown", `${WORK}/c`, { spaceId: "c" }),
    ];
    expect(withoutArchivedStaveProjects(projects).map((entry) => entry.id)).toEqual([
      "plain",
      "live",
      "unknown",
    ]);
  });
});

describe("existingStaveSpaces", () => {
  const rows = [
    row("added"),
    row("cli-made"),
    row("alpha", { basename: "alpha", archivedAt: "2026-09-02T00:00:00.000Z" }),
    row("alpha", {
      basename: "alpha-20260905",
      archivedAt: "2026-09-05T00:00:00.000Z",
      manifestCreatedAt: "2026-09-04T00:00:00Z",
    }),
    row("saga", { isSaga: true }),
    row("broken", { error: "unreadable manifest" }),
  ];
  const projects = [
    project("added-project", `${WORK}/added`, { spaceId: "added", state: "live" }),
    // Matched by incarnation even though its recorded root differs.
    project("alpha-project", `${WORK}/.archive/alpha`, {
      spaceId: "alpha",
      createdAt: "2026-09-01T10:00:00.123456000Z",
      state: "archived",
    }),
  ];

  it("offers active spaces that are not projects, hiding archives by default", () => {
    const listed = existingStaveSpaces({ rows, projects, kind: "space", showArchived: false });
    expect(listed.entries.map((entry) => entry.spaceId)).toEqual(["cli-made"]);
    expect(listed.archivedCount).toBe(2);
  });

  it("lists archives newest first with the project a restore reuses", () => {
    const listed = existingStaveSpaces({ rows, projects, kind: "space", showArchived: true });
    expect(listed.entries.map((entry) => [entry.key, entry.project?.id ?? null])).toEqual([
      [`${WORK}/cli-made`, null],
      [`${WORK}/.archive/alpha-20260905`, null],
      [`${WORK}/.archive/alpha`, "alpha-project"],
    ]);
  });

  it("keeps sagas and spaces apart", () => {
    const listed = existingStaveSpaces({ rows, projects, kind: "saga", showArchived: true });
    expect(listed.entries.map((entry) => entry.spaceId)).toEqual(["saga"]);
  });

  it("labels archives with their date and entry, active spaces with their repos", () => {
    const listed = existingStaveSpaces({ rows, projects, kind: "space", showArchived: true });
    const format = (iso: string) => iso.slice(0, 10);
    expect(listed.entries.map((entry) => existingStaveSpaceDetail(entry, format))).toEqual([
      "api",
      "Archived 2026-09-05 · alpha-20260905",
      "Archived 2026-09-02 · alpha",
    ]);
  });
});

describe("staveRestoreSteps", () => {
  it("restores a saga space first, then each rostered member's matching archive", () => {
    const saga = row("sg", {
      basename: "sg",
      isSaga: true,
      sagaMembers: [{ id: "m1", createdAt: STAMP }, { id: "m2" }, { id: "live-member" }],
    });
    const rows = [
      saga,
      row("m1", { basename: "m1" }),
      row("m1", { basename: "m1-old", manifestCreatedAt: "2025-01-01T00:00:00Z" }),
      row("m2", { basename: "m2-a", archivedAt: "2026-09-01T00:00:00.000Z" }),
      row("m2", { basename: "m2-b", archivedAt: "2026-09-03T00:00:00.000Z" }),
      row("live-member"),
    ];
    expect(staveRestoreSteps(saga, rows).map((step) => step.operation)).toEqual([
      {
        kind: "restoreSpace",
        workspaceRoot: `${WORK}/.archive/sg`,
        from: "sg",
        expectedManifestCreatedAt: STAMP,
      },
      {
        kind: "restoreSpace",
        workspaceRoot: `${WORK}/.archive/m1`,
        from: "m1",
        expectedManifestCreatedAt: STAMP,
      },
      {
        kind: "restoreSpace",
        workspaceRoot: `${WORK}/.archive/m2-b`,
        from: "m2-b",
        expectedManifestCreatedAt: STAMP,
      },
    ]);
  });
});

const manifest = (id: string) => ({ id, createdAt: STAMP, repos: [], memories: [] });

/** Runs operations against a script of outcomes and records what it was asked. */
function fakeClient(options: {
  readonly rows?: ReadonlyArray<StaveSpaceListRow>;
  readonly fail?: (operation: StaveOperation) => string | null;
  readonly dryRun?: StaveDryRunPlan;
}) {
  const ran: StaveOperation[] = [];
  let ids = 0;
  const client: StaveArchiveClient = {
    newOperationId: () => `op-${++ids}`,
    listSpaces: async () => options.rows ?? [],
    dryRun: async () => options.dryRun ?? { dryRun: true, plan: [] },
    run: async (operationId, operation): Promise<StaveOperationState> => {
      ran.push(operation);
      const base = { operationId, phases: [], lastSequence: 1, truncated: false };
      const failure = options.fail?.(operation) ?? null;
      if (failure !== null)
        return {
          ...base,
          status: "failed",
          error: { code: "unknown", message: failure, details: null },
        };
      if (operation.kind === "restoreSpace") {
        const id = operation.from.replace(/-.*$/, "");
        const result: StaveOperationResult = {
          kind: "restoreSpace",
          result: {
            spaceId: id,
            spacePath: `${WORK}/${id}`,
            manifest: manifest(id),
            notes: [],
            projectId: ProjectId.make(`project-${id}`),
            sequence: ids * 10,
          },
        };
        return { ...base, status: "finished", result };
      }
      return {
        ...base,
        status: "finished",
        result: {
          kind: "destroySpace",
          result: { spaceId: "x", spacePath: "x", destroyed: true, memory: "keep", notes: [] },
        },
      };
    },
  };
  return { client, ran };
}

describe("archive undo", () => {
  it("builds the toast from a saga archive and restores forward from the listing", async () => {
    const undo = staveArchiveUndo({
      kind: "sagaArchive",
      result: {
        sagaId: "sg",
        action: "archived",
        memory: "keep",
        notes: [],
        sagaPath: `${WORK}/sg`,
        sagaArchivedPath: `${WORK}/.archive/sg`,
        members: [
          { id: "m2", action: "archived", path: `${WORK}/m2`, archivedPath: `${WORK}/.archive/m2` },
          { id: "m1", action: "archived", path: `${WORK}/m1`, archivedPath: `${WORK}/.archive/m1` },
          { id: "m0", action: "skipped", path: `${WORK}/m0`, archivedPath: `${WORK}/.archive/m0` },
        ],
      },
    });
    expect(undo).toMatchObject({
      title: "Saga archived",
      description: "Restore it any time from New project → Stave.",
    });
    const { client, ran } = fakeClient({
      rows: [
        row("m1", { basename: "m1" }),
        row("sg", { basename: "sg", isSaga: true }),
        row("m2", { basename: "m2" }),
      ],
    });
    const states: StaveArchiveTaskState[] = [];
    const final = await undoStaveArchive(client, undo!, (state) => states.push(state));
    expect(ran.map((operation) => operation.kind === "restoreSpace" && operation.from)).toEqual([
      "sg",
      "m1",
      "m2",
    ]);
    expect(final).toEqual({
      status: "finished",
      projectId: "project-sg",
      sequence: 10,
      restored: { spacePath: `${WORK}/sg`, createdAt: STAMP },
    });
    expect(states.at(-1)).toEqual(final);
  });

  it("fails clearly when the archive is no longer listed", async () => {
    const undo = staveArchiveUndo({
      kind: "archiveSpace",
      result: { spaceId: "a", archivedPath: `${WORK}/.archive/a`, memory: "keep", notes: [] },
    })!;
    const { client, ran } = fakeClient({ rows: [] });
    expect(await undoStaveArchive(client, undo)).toEqual({
      status: "failed",
      message: `The archive at ${WORK}/.archive/a is gone.`,
    });
    expect(ran).toEqual([]);
  });
});

describe("restoreStaveArchive", () => {
  it("stops at the first failed restore and reports Stave's message", async () => {
    const saga = row("sg", { basename: "sg", isSaga: true, sagaMembers: [{ id: "m1" }] });
    const { client, ran } = fakeClient({
      fail: (operation) =>
        operation.kind === "restoreSpace" && operation.from === "sg" ? "space_exists: sg" : null,
    });
    expect(
      await restoreStaveArchive(client, { row: saga, rows: [saga, row("m1", { basename: "m1" })] }),
    ).toEqual({
      status: "failed",
      message: "space_exists: sg",
    });
    expect(ran).toHaveLength(1);
  });
});

describe("deleteStaveArchive", () => {
  it("restores then destroys a space through the ordinary destroy", async () => {
    const { client, ran } = fakeClient({});
    const final = await deleteStaveArchive(client, row("a", { basename: "a-2026" }));
    expect(final.status).toBe("finished");
    expect(ran).toEqual([
      expect.objectContaining({ kind: "restoreSpace", from: "a-2026" }),
      {
        kind: "destroySpace",
        workspaceRoot: `${WORK}/a`,
        expectedManifestCreatedAt: STAMP,
        force: false,
        memory: "keep",
        sagaRemoveConfirmed: true,
      },
    ]);
  });

  it("refuses to destroy a saga whose members are live again", async () => {
    const participant = (spaceId: string, state: string) => ({
      spaceId,
      createdAt: STAMP,
      workspaceRoot: `${WORK}/${spaceId}`,
      state,
      threadIds: [],
    });
    const { client, ran } = fakeClient({
      dryRun: {
        dryRun: true,
        plan: [],
        sagaReview: {
          fingerprint: "fp",
          sagaRoot: `${WORK}/sg`,
          sagaCreatedAt: STAMP,
          target: "destroy",
          force: false,
          memory: "keep",
          participants: [
            participant("sg", "live"),
            participant("m1", "live"),
            participant("m2", "archived"),
          ],
        },
      },
    });
    const final = await deleteStaveArchive(client, row("sg", { basename: "sg", isSaga: true }));
    expect(final).toMatchObject({ status: "failed" });
    expect(final.status === "failed" && final.message).toContain("members m1 are still live");
    expect(ran.map((operation) => operation.kind)).toEqual(["restoreSpace"]);
  });
});
