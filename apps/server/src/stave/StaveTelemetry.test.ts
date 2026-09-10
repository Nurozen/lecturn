import { describe, expect, it } from "@effect/vitest";
import { ProjectId, type StaveOperation } from "@t3tools/contracts";
import { staveTelemetryEvent } from "./StaveTelemetry.ts";

const secret = "secret-token-user-space-den-name";
const path = `/private/${secret}`;
const timestamp = "2026-01-01T00:00:00Z";
const createSpace: Extract<StaveOperation, { kind: "createSpace" }> = {
  kind: "createSpace",
  spaceId: secret,
  title: secret,
  spaceKind: secret,
  specText: secret,
  specPath: path,
  edits: [{ repo: secret, base: secret }],
  references: [{ repo: secret, ref: secret }],
  memory: [{ spec: `marmot:${secret}` }],
  saga: secret,
  after: [secret],
  common: true,
  includeWeak: true,
  noLearn: true,
};
const lifecycle: Extract<StaveOperation, { kind: "lifecycleAction" }> = {
  kind: "lifecycleAction",
  projectId: ProjectId.make(secret),
  workspaceRoot: path,
  action: "keep",
  force: false,
  memory: "keep",
};
const cases: ReadonlyArray<readonly [StaveOperation, string | null]> = [
  [createSpace, "stave.space.created"],
  [
    {
      kind: "createSaga",
      sagaId: secret,
      title: secret,
      specText: secret,
      references: [{ repo: secret, ref: secret }],
      memory: [{ spec: secret }],
    },
    "stave.space.created",
  ],
  [
    { kind: "archiveSpace", workspaceRoot: path, force: true, memory: "keep" },
    "stave.space.archived",
  ],
  [
    { kind: "sagaArchive", sagaRoot: path, force: true, memory: "contribute" },
    "stave.space.archived",
  ],
  [
    {
      kind: "destroySpace",
      workspaceRoot: path,
      force: true,
      memory: "destroy",
      expectedManifestCreatedAt: timestamp,
    },
    "stave.space.destroyed",
  ],
  [
    { kind: "sagaDestroy", sagaRoot: path, force: true, memory: "destroy" },
    "stave.space.destroyed",
  ],
  [
    { kind: "removePartialSpace", spaceId: secret, expectedManifestCreatedAt: timestamp },
    "stave.space.destroyed",
  ],
  [lifecycle, null],
  [{ kind: "setup", force: true }, null],
  [
    { kind: "registerRepo", name: secret, url: `https://${secret}@example.test/repo`, adopt: true },
    null,
  ],
  [
    {
      kind: "addRepo",
      workspaceRoot: path,
      repo: secret,
      mode: "edit",
      base: secret,
      branch: secret,
      noFetch: false,
      linkMemory: true,
    },
    null,
  ],
  [{ kind: "removeRepo", workspaceRoot: path, repo: secret, force: true }, null],
  [{ kind: "retarget", workspaceRoot: path, repo: secret, base: secret }, null],
  [{ kind: "syncSpace", workspaceRoot: path, referencesOnly: true }, null],
  [{ kind: "restoreSpace", workspaceRoot: path, from: path }, null],
  [{ kind: "memoryAttach", workspaceRoot: path, specs: [{ spec: secret }] }, null],
  [{ kind: "memoryDetach", workspaceRoot: path, alias: secret, fate: "destroy" }, null],
  [{ kind: "sagaAdd", sagaRoot: path, memberRoot: path, after: [secret], clearAfter: false }, null],
  [{ kind: "sagaRemove", sagaRoot: path, memberRoot: path }, null],
  [{ kind: "sagaSync", sagaRoot: path }, null],
];

describe("Stave telemetry privacy boundary", () => {
  for (const [operation, event] of cases) {
    it(`maps ${operation.kind} using only the allowlisted properties`, () => {
      for (const trigger of ["interactive", "automatic"] as const) {
        expect(staveTelemetryEvent(operation, trigger, { state: "success" })).toEqual(
          event === null
            ? null
            : { event, properties: { operationKind: operation.kind, trigger, count: 1 } },
        );
        expect(
          staveTelemetryEvent(operation, trigger, { state: "failure", code: "dirty_worktrees" }),
        ).toEqual({
          event: "stave.space.failed",
          properties: { operationKind: operation.kind, trigger, count: 1, code: "dirty_worktrees" },
        });
      }
    });
  }

  for (const [action, target, event] of [
    ["archiveNow", undefined, "stave.space.archived"],
    ["retry", "archive", "stave.space.archived"],
    ["retry", "destroy", "stave.space.destroyed"],
    ["retry", undefined, null],
    ["keep", "destroy", null],
    ["dismiss", "archive", null],
  ] as const) {
    it(`maps automatic lifecycle ${action}/${target} without leaking project identifiers`, () => {
      expect(
        staveTelemetryEvent({ ...lifecycle, action, ...(target ? { target } : {}) }, "automatic", {
          state: "success",
        }),
      ).toEqual(
        event === null
          ? null
          : {
              event,
              properties: { operationKind: "lifecycleAction", trigger: "automatic", count: 1 },
            },
      );
    });
  }

  it("drops extra command, environment, output and error fields and normalizes future error codes", () => {
    const operation = {
      ...createSpace,
      command: path,
      args: [secret],
      env: { TOKEN: secret },
      stdout: secret,
    };
    const outcome = {
      state: "failure" as const,
      code: secret,
      message: secret,
      stderr: secret,
      details: { path, den: secret },
    };
    expect(staveTelemetryEvent(operation, "interactive", outcome)).toEqual({
      event: "stave.space.failed",
      properties: {
        operationKind: "createSpace",
        trigger: "interactive",
        count: 1,
        code: "unknown",
      },
    });
    expect(staveTelemetryEvent(operation, "interactive", { state: "success" })).toEqual({
      event: "stave.space.created",
      properties: { operationKind: "createSpace", trigger: "interactive", count: 1 },
    });
  });

  for (const kind of [secret, "__proto__", "constructor"]) {
    it(`normalizes an unexpected operation kind (${kind})`, () => {
      const operation = { ...createSpace, kind } as unknown as StaveOperation;
      expect(
        staveTelemetryEvent(operation, "automatic", { state: "failure", code: secret }),
      ).toEqual({
        event: "stave.space.failed",
        properties: { operationKind: "unknown", trigger: "automatic", count: 1, code: "unknown" },
      });
      expect(staveTelemetryEvent(operation, "automatic", { state: "success" })).toBeNull();
    });
  }
});
