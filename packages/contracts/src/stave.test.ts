import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  STAVE_OPERATION_ERROR_CODES,
  type StaveManifest,
  StaveName,
  StaveOperation,
  StaveOperationError,
  StaveOperationResult,
  StaveProgressEvent,
  StaveRunOperationInput,
  type StaveOperationKind,
} from "./stave.ts";

const decodeOperation = Schema.decodeUnknownSync(StaveOperation);
const encodeOperation = Schema.encodeUnknownSync(StaveOperation);
const decodeOperationExit = Schema.decodeUnknownExit(StaveOperation);
const decodeProgress = Schema.decodeUnknownSync(StaveProgressEvent);
const encodeProgress = Schema.encodeUnknownSync(StaveProgressEvent);
const decodeResultExit = Schema.decodeUnknownExit(StaveOperationResult);
const decodeError = Schema.decodeUnknownSync(StaveOperationError);
const encodeError = Schema.encodeUnknownSync(StaveOperationError);
const decodeNameExit = Schema.decodeUnknownExit(StaveName);
const decodeRunInput = Schema.decodeUnknownSync(StaveRunOperationInput);

const ROOT = "/work/spaces/ticket-42";
const SAGA_ROOT = "/work/spaces/epic-7";

/** One wire payload per operation kind; the record keeps the table exhaustive. */
const OPERATIONS: { readonly [K in StaveOperationKind]: Record<string, unknown> } = {
  createSpace: {
    kind: "createSpace",
    spaceId: "ticket-42",
    title: "Ticket 42",
    spaceKind: "ticket",
    specText: "# Goal\nShip it.\n",
    edits: [{ repo: "t3code", base: "space:epic-7" }, { repo: "stave" }],
    references: [{ repo: "effect", ref: "v4.0.0" }],
    memory: [{ spec: "." }],
    saga: "epic-7",
    after: ["ticket-41"],
    common: true,
    includeWeak: false,
    noLearn: false,
  },
  registerRepo: {
    kind: "registerRepo",
    name: "t3code",
    url: "git@github.com:x/t3code.git",
    adopt: false,
  },
  addRepo: {
    kind: "addRepo",
    workspaceRoot: ROOT,
    repo: "effect",
    mode: "reference",
    base: "main",
    noFetch: false,
    linkMemory: true,
  },
  removeRepo: {
    kind: "removeRepo",
    workspaceRoot: ROOT,
    repo: "effect",
    mode: "reference",
    force: false,
  },
  syncSpace: { kind: "syncSpace", workspaceRoot: ROOT, referencesOnly: true },
  retarget: { kind: "retarget", workspaceRoot: ROOT, repo: "t3code", base: "space:epic-8" },
  archiveSpace: { kind: "archiveSpace", workspaceRoot: ROOT, force: false, memory: "contribute" },
  destroySpace: {
    kind: "destroySpace",
    workspaceRoot: ROOT,
    force: true,
    memory: "destroy",
    expectedManifestCreatedAt: "2026-09-01T10:00:00.123456789Z",
  },
  restoreSpace: {
    kind: "restoreSpace",
    workspaceRoot: `${ROOT}/.archive/ticket-42-20260901`,
    from: "ticket-42-20260901",
  },
  removePartialSpace: {
    kind: "removePartialSpace",
    spaceId: "ticket-42",
    expectedManifestCreatedAt: "2026-09-01T10:00:00.123456789Z",
  },
  setup: { kind: "setup", force: false },
  memoryAttach: {
    kind: "memoryAttach",
    workspaceRoot: ROOT,
    specs: [{ spec: "marmot:shared-den" }],
  },
  memoryDetach: { kind: "memoryDetach", workspaceRoot: ROOT, alias: "default", fate: "keep" },
  createSaga: {
    kind: "createSaga",
    sagaId: "epic-7",
    title: "Epic 7",
    references: [{ repo: "t3code" }],
    memory: [],
  },
  sagaAdd: {
    kind: "sagaAdd",
    sagaRoot: SAGA_ROOT,
    memberRoot: ROOT,
    after: ["ticket-41"],
    clearAfter: true,
  },
  sagaRemove: { kind: "sagaRemove", sagaRoot: SAGA_ROOT, memberRoot: ROOT },
  sagaSync: { kind: "sagaSync", sagaRoot: SAGA_ROOT },
  sagaArchive: { kind: "sagaArchive", sagaRoot: SAGA_ROOT, force: false, memory: "keep" },
  sagaDestroy: { kind: "sagaDestroy", sagaRoot: SAGA_ROOT, force: false, memory: "contribute" },
};

const manifest: StaveManifest = {
  version: 1,
  id: "ticket-42",
  kind: "ticket",
  createdAt: "2026-09-01T10:00:00.123456789Z",
  repos: [
    {
      name: "t3code",
      mode: "edit",
      path: "t3code",
      base: "main",
      branch: "stave/ticket-42/t3code",
      bareRepoPath: "/work/bare/t3code.git",
    },
  ],
  memories: [{ name: "default", provider: "marmot", id: "den-1", owned: true }],
};

const spaceMutation = { spaceId: "ticket-42", spacePath: ROOT, manifest, notes: ["note"] };
const sagaMutation = { sagaId: "epic-7", spacePath: SAGA_ROOT, manifest, notes: [] };
const sagaLifecycle = {
  sagaId: "epic-7",
  action: "archived",
  memory: "keep",
  members: [
    {
      id: "ticket-42",
      action: "archived",
      path: ROOT,
      archivedPath: `${ROOT}/.archive/ticket-42-1`,
    },
    {
      id: "ticket-41",
      action: "skipped",
      note: "already archived",
      path: "/work/spaces/ticket-41",
    },
  ],
  notes: [],
  sagaPath: SAGA_ROOT,
  sagaArchivedPath: `${SAGA_ROOT}/.archive/epic-7-1`,
};
const syncReport = {
  spaceId: "ticket-42",
  spacePath: ROOT,
  manifest,
  repos: [{ name: "effect", mode: "reference", action: "updated", ahead: 0, behind: 0 }],
  notes: [],
};

/** One valid result per operation kind, paired the way `finished` carries it. */
const RESULTS: { readonly [K in StaveOperationKind]: Record<string, unknown> } = {
  createSpace: { ...spaceMutation, projectId: "project-1", sequence: 12 },
  registerRepo: {
    name: "t3code",
    url: "git@github.com:x/t3code.git",
    bareRepoPath: "/work/bare/t3code.git",
    defaultBranch: "main",
    adopted: false,
    notes: [],
  },
  addRepo: spaceMutation,
  removeRepo: spaceMutation,
  syncSpace: syncReport,
  retarget: spaceMutation,
  archiveSpace: {
    spaceId: "ticket-42",
    archivedPath: `${ROOT}/.archive/ticket-42-1`,
    memory: "contribute",
    notes: [],
  },
  destroySpace: {
    spaceId: "ticket-42",
    spacePath: ROOT,
    destroyed: true,
    memory: "destroy",
    notes: [],
  },
  restoreSpace: spaceMutation,
  removePartialSpace: {
    spaceId: "ticket-42",
    spacePath: ROOT,
    destroyed: true,
    memory: "keep",
    notes: [],
  },
  setup: {
    configPath: "/home/u/.config/stave/config.yaml",
    root: "/work",
    bareReposDir: "/work/bare",
    agentWorkDir: "/work/spaces",
    created: ["/work"],
    existed: [],
  },
  memoryAttach: {
    ...spaceMutation,
    attachments: [
      {
        name: "default",
        provider: "marmot",
        id: "den-1",
        owned: true,
        linked: [{ reference: "effect", kind: "read-only", resolvedVia: "tether" }],
      },
    ],
  },
  memoryDetach: {
    ...spaceMutation,
    detached: [{ name: "default", provider: "marmot", id: "den-1", owned: false, fate: "keep" }],
  },
  createSaga: sagaMutation,
  sagaAdd: sagaMutation,
  sagaRemove: sagaMutation,
  sagaSync: {
    sagaId: "epic-7",
    spacePath: SAGA_ROOT,
    members: [{ id: "ticket-42", state: "live", repos: syncReport.repos }],
    repos: [],
    notes: [],
  },
  sagaArchive: sagaLifecycle,
  sagaDestroy: { ...sagaLifecycle, action: "destroyed", members: [] },
};

const OPERATION_KINDS = Object.keys(OPERATIONS) as ReadonlyArray<StaveOperationKind>;

describe("StaveOperation", () => {
  it.each(OPERATION_KINDS)("round-trips %s over the wire", (kind) => {
    const wire = OPERATIONS[kind];
    const decoded = decodeOperation(wire);
    expect(decoded.kind).toBe(kind);
    expect(encodeOperation(decoded)).toEqual(wire);
  });

  it("covers every member of the union", () => {
    const unionKinds = StaveOperation.members.map((member) => member.fields.kind.literal);
    expect(new Set(unionKinds)).toEqual(new Set(OPERATION_KINDS));
  });

  it("rejects ids outside the Stave name charset", () => {
    for (const bad of ["", "-lead", "has space", "slash/id", ".dot", "tab\tid"]) {
      expect(Exit.isFailure(decodeNameExit(bad)), bad).toBe(true);
    }
    for (const good of ["a", "ticket-42", "v1.2_rc"]) {
      expect(Exit.isSuccess(decodeNameExit(good)), good).toBe(true);
    }
    expect(
      Exit.isFailure(decodeOperationExit({ ...OPERATIONS.createSpace, spaceId: "bad id" })),
    ).toBe(true);
    expect(
      Exit.isFailure(decodeOperationExit({ ...OPERATIONS.sagaAdd, after: ["ok", "not ok"] })),
    ).toBe(true);
  });

  it("rejects an unknown operation kind and a mode outside the enum", () => {
    expect(Exit.isFailure(decodeOperationExit({ kind: "formatDisk" }))).toBe(true);
    expect(Exit.isFailure(decodeOperationExit({ ...OPERATIONS.addRepo, mode: "symlink" }))).toBe(
      true,
    );
    expect(
      Exit.isFailure(decodeOperationExit({ ...OPERATIONS.archiveSpace, memory: "destroy" })),
    ).toBe(true);
  });

  it("accepts start-or-attach input with and without a cursor", () => {
    const fresh = decodeRunInput({ operationId: "op-1", operation: OPERATIONS.setup });
    expect(fresh.afterSequence).toBeUndefined();
    const attach = decodeRunInput({
      operationId: "op-1",
      afterSequence: 7,
      operation: OPERATIONS.setup,
    });
    expect(attach.afterSequence).toBe(7);
  });
});

describe("StaveOperationResult", () => {
  it.each(OPERATION_KINDS)("pairs %s with its result schema", (kind) => {
    const exit = decodeResultExit({ kind, result: RESULTS[kind] });
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("refuses a result shape that belongs to another kind", () => {
    expect(
      Exit.isFailure(decodeResultExit({ kind: "archiveSpace", result: RESULTS.destroySpace })),
    ).toBe(true);
    expect(Exit.isFailure(decodeResultExit({ kind: "createSpace", result: RESULTS.addRepo }))).toBe(
      true,
    );
  });

  it("reads literal members a newer Stave adds as unknown", () => {
    const exit = decodeResultExit({
      kind: "sagaArchive",
      result: {
        ...sagaLifecycle,
        action: "quarantined",
        memory: "frozen",
        members: [{ id: "m", action: "teleported", path: "/p" }],
      },
    });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit) && exit.value.kind === "sagaArchive") {
      expect(exit.value.result.action).toBe("unknown");
      expect(exit.value.result.memory).toBe("unknown");
      expect(exit.value.result.members[0]?.action).toBe("unknown");
    }
  });
});

describe("StaveProgressEvent", () => {
  const base = { operationId: "op-1" };
  const EVENTS: ReadonlyArray<Record<string, unknown>> = [
    {
      ...base,
      sequence: 0,
      kind: "phase_started",
      phase: "create space",
      commandLine: "stave space create ticket-42 --json",
    },
    { ...base, sequence: 1, kind: "output", phase: "create space", stream: "notes", text: "" },
    {
      ...base,
      sequence: 2,
      kind: "output",
      phase: "register repos",
      stream: "stdout",
      text: "Cloning...",
    },
    { ...base, sequence: 3, kind: "phase_finished", phase: "create space", durationMs: 1200 },
    { ...base, sequence: 4, kind: "reset", earliestSequence: 3 },
    { ...base, sequence: 5, kind: "finished", result: { kind: "setup", result: RESULTS.setup } },
    {
      ...base,
      sequence: 6,
      kind: "failed",
      error: {
        code: "space_exists",
        message: "space exists",
        details: { spaceId: "ticket-42" },
        verb: "space create",
      },
    },
  ];

  it.each(EVENTS.map((event) => [event.kind, event] as const))("round-trips %s", (_kind, wire) => {
    const decoded = decodeProgress(wire);
    expect(encodeProgress(decoded)).toEqual(wire);
  });

  it("keeps sequence numbers non-negative integers", () => {
    const decodeExit = Schema.decodeUnknownExit(StaveProgressEvent);
    expect(Exit.isFailure(decodeExit({ ...EVENTS[4], sequence: -1 }))).toBe(true);
    expect(Exit.isFailure(decodeExit({ ...EVENTS[4], sequence: 1.5 }))).toBe(true);
  });
});

describe("StaveOperationError", () => {
  it("keeps every shipped code and reads a newer one as unknown", () => {
    expect(STAVE_OPERATION_ERROR_CODES).toContain("operation_expired");
    expect(STAVE_OPERATION_ERROR_CODES).toContain("invalid_arguments");
    for (const code of STAVE_OPERATION_ERROR_CODES) {
      expect(decodeError({ code, message: "m", details: null }).code).toBe(code);
    }
    const future = decodeError({ code: "quantum_flux", message: "m", details: null });
    expect(future.code).toBe("unknown");
    expect(encodeError(future)).toEqual({ code: "unknown", message: "m", details: null });
  });
});
