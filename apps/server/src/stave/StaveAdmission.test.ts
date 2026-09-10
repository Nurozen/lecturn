import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, type StaveProjectInfo } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { StaveLifecycleRepository } from "../persistence/Services/StaveLifecycleRepository.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as StaveAdmission from "./StaveAdmission.ts";
import { STAVE_MANIFEST_FILE_NAME } from "./staveManifest.ts";
import * as StaveWorkspaceReader from "./StaveWorkspaceReader.ts";

const SPACE_ROOT = "/spaces/alpha";
const PLAIN_ROOT = "/projects/plain";

const spaceInfo: StaveProjectInfo = {
  spaceId: "alpha",
  isSaga: false,
  repos: [],
  memories: [],
  state: "live",
};

/** Reader that knows exactly one space and counts every manifest read. */
const makeRecordingReader = (loads: string[]) =>
  Layer.mock(StaveWorkspaceReader.StaveWorkspaceReader)({
    load: (root) =>
      Effect.sync(() => {
        loads.push(root);
        return root === SPACE_ROOT ? Option.some(spaceInfo) : Option.none();
      }),
  });

const makeAdmissionLayer = (loads: string[] = []) =>
  StaveAdmission.layer.pipe(Layer.provide(makeRecordingReader(loads)));

const check = (input: StaveAdmission.StaveAdmissionInput) =>
  Effect.flatMap(StaveAdmission.StaveAdmission, (admission) => admission.check(input));

const expectRefused = (input: StaveAdmission.StaveAdmissionInput) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(check(input));
    expect(error._tag).toBe("StaveWorktreeForbiddenError");
    expect(error.projectRoot).toBe(input.projectRoot);
    expect(error.intent).toBe(input.intent);
    expect(error.message).toBe(StaveAdmission.STAVE_WORKTREE_FORBIDDEN_MESSAGE);
    return error;
  });

describe("StaveAdmission worktree rule", () => {
  it.effect("admits every intent for a root that is not a Stave space", () => {
    const loads: string[] = [];
    return Effect.gen(function* () {
      yield* check({ projectRoot: PLAIN_ROOT, intent: "thread.create", worktreePath: "/wt/a" });
      yield* check({
        projectRoot: PLAIN_ROOT,
        intent: "thread.turn.start",
        worktreePath: null,
        prepareWorktree: true,
      });
      yield* check({ projectRoot: PLAIN_ROOT, intent: "thread.fork", worktreePath: "/wt/a" });
      yield* check({ projectRoot: PLAIN_ROOT, intent: "vcs.createWorktree" });
      yield* check({ projectRoot: PLAIN_ROOT, intent: "pr.prepare" });
      expect(loads).toEqual([PLAIN_ROOT, PLAIN_ROOT, PLAIN_ROOT, PLAIN_ROOT, PLAIN_ROOT]);
    }).pipe(Effect.provide(makeAdmissionLayer(loads)));
  });

  it.effect("refuses thread.create with a worktreePath in a Stave space", () =>
    Effect.gen(function* () {
      const error = yield* expectRefused({
        projectRoot: SPACE_ROOT,
        intent: "thread.create",
        worktreePath: "/wt/alpha",
      });
      expect(StaveAdmission.isStaveAdmissionError(error)).toBe(true);
    }).pipe(Effect.provide(makeAdmissionLayer())),
  );

  it.effect("refuses thread.meta.update that binds a worktree in a Stave space", () =>
    expectRefused({
      projectRoot: SPACE_ROOT,
      intent: "thread.meta.update",
      worktreePath: "/wt/alpha",
    }).pipe(Effect.provide(makeAdmissionLayer())),
  );

  it.effect("refuses a bootstrap turn start that prepares a worktree in a Stave space", () =>
    Effect.gen(function* () {
      yield* expectRefused({
        projectRoot: SPACE_ROOT,
        intent: "thread.turn.start",
        worktreePath: null,
        prepareWorktree: true,
      });
      yield* expectRefused({
        projectRoot: SPACE_ROOT,
        intent: "thread.turn.start",
        worktreePath: "/wt/alpha",
        prepareWorktree: false,
      });
    }).pipe(Effect.provide(makeAdmissionLayer())),
  );

  it.effect("refuses a fork that would inherit a worktree, admits one in the space root", () =>
    Effect.gen(function* () {
      yield* expectRefused({
        projectRoot: SPACE_ROOT,
        intent: "thread.fork",
        worktreePath: "/wt/alpha",
      });
      yield* check({ projectRoot: SPACE_ROOT, intent: "thread.fork", worktreePath: null });
    }).pipe(Effect.provide(makeAdmissionLayer())),
  );

  it.effect("refuses the worktree-producing RPCs in a Stave space regardless of payload", () =>
    Effect.gen(function* () {
      yield* expectRefused({ projectRoot: SPACE_ROOT, intent: "vcs.createWorktree" });
      yield* expectRefused({ projectRoot: SPACE_ROOT, intent: "pr.prepare" });
    }).pipe(Effect.provide(makeAdmissionLayer())),
  );

  it.effect("checks manifest lifecycle for intents that stay in the project root", () => {
    const loads: string[] = [];
    return Effect.gen(function* () {
      yield* check({ projectRoot: SPACE_ROOT, intent: "thread.create", worktreePath: null });
      yield* check({ projectRoot: SPACE_ROOT, intent: "thread.meta.update" });
      yield* check({
        projectRoot: SPACE_ROOT,
        intent: "thread.turn.start",
        worktreePath: null,
        prepareWorktree: false,
      });
      expect(loads).toEqual([SPACE_ROOT, SPACE_ROOT, SPACE_ROOT]);
    }).pipe(Effect.provide(makeAdmissionLayer(loads)));
  });

  it("intentUsesWorktree is the pure shape of the rule", () => {
    expect(
      StaveAdmission.intentUsesWorktree({ projectRoot: SPACE_ROOT, intent: "thread.create" }),
    ).toBe(false);
    expect(
      StaveAdmission.intentUsesWorktree({
        projectRoot: SPACE_ROOT,
        intent: "thread.create",
        worktreePath: "/wt",
      }),
    ).toBe(true);
    expect(
      StaveAdmission.intentUsesWorktree({
        projectRoot: SPACE_ROOT,
        intent: "thread.turn.start",
        prepareWorktree: true,
      }),
    ).toBe(true);
    expect(
      StaveAdmission.intentUsesWorktree({ projectRoot: SPACE_ROOT, intent: "vcs.createWorktree" }),
    ).toBe(true);
    expect(
      StaveAdmission.intentUsesWorktree({ projectRoot: SPACE_ROOT, intent: "pr.prepare" }),
    ).toBe(true);
  });

  it.effect("layerNoop admits worktree intents even for a Stave root", () =>
    check({ projectRoot: SPACE_ROOT, intent: "vcs.createWorktree" }).pipe(
      Effect.provide(StaveAdmission.layerNoop),
    ),
  );
});

const nullResolverLayer = Layer.succeed(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  RepositoryIdentityResolver.RepositoryIdentityResolver.of({
    resolve: () => Effect.succeed(null),
  }),
);

it.layer(NodeServices.layer)("StaveAdmission with the real reader", (it) => {
  it.effect("refuses worktrees under a temp root carrying a .stave.yaml manifest", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-stave-admission-" });
      const spaceRoot = path.join(base, "space");
      const plainRoot = path.join(base, "plain");
      yield* fileSystem.makeDirectory(spaceRoot, { recursive: true });
      yield* fileSystem.makeDirectory(plainRoot, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(spaceRoot, STAVE_MANIFEST_FILE_NAME),
        "version: 1\nid: fixture-space\n",
      );

      const admissionLayer = StaveAdmission.layer.pipe(
        Layer.provide(StaveWorkspaceReader.layer),
        Layer.provide(nullResolverLayer),
      );
      yield* Effect.gen(function* () {
        yield* expectRefused({ projectRoot: spaceRoot, intent: "vcs.createWorktree" });
        yield* check({ projectRoot: plainRoot, intent: "vcs.createWorktree" });
      }).pipe(Effect.provide(admissionLayer));
    }),
  );
});

describe("Stave lifecycle admission", () => {
  it.effect("refuses a local thread in an archived space", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        check({ projectRoot: SPACE_ROOT, intent: "thread.create", worktreePath: null }),
      );
      expect(result._tag).toBe("StaveArchivedProjectError");
    }).pipe(
      Effect.provide(
        StaveAdmission.layer.pipe(
          Layer.provide(
            Layer.mock(StaveWorkspaceReader.StaveWorkspaceReader)({
              load: () => Effect.succeed(Option.some({ ...spaceInfo, state: "archived" })),
            }),
          ),
        ),
      ),
    ),
  );
  it.effect("fails closed while a lifecycle owner holds the lease", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        check({ projectRoot: SPACE_ROOT, intent: "thread.turn.start" }),
      );
      expect(result._tag).toBe("StaveSpaceTransitioningError");
    }).pipe(
      Effect.provide(
        StaveAdmission.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              makeRecordingReader([]),
              Layer.mock(StaveLifecycleRepository)({
                getByWorkspaceRoot: () =>
                  Effect.succeed(
                    Option.some({
                      projectId: ProjectId.make("p"),
                      workspaceRoot: SPACE_ROOT,
                      spaceId: "alpha",
                      manifestCreatedAt: null,
                      disposition: "archiving",
                      ownerToken: "owner",
                      leaseEpoch: 1,
                      leaseUntil: "2026-09-09T00:00:00Z",
                      deleteIntentSequence: null,
                      sagaRemoveConfirmed: false,
                      refusalCode: null,
                      refusalMessage: null,
                      anchorAt: null,
                      scheduledAt: null,
                      archiveDeadlineAt: null,
                      archiveBasename: null,
                      updatedAt: "2026-09-09T00:00:00Z",
                      refreshedAt: null,
                    }),
                  ),
              }),
            ),
          ),
        ),
      ),
    ),
  );
});

it.effect("ignores an old project's terminal row after a root is re-added", () => {
  const oldRow = {
    projectId: ProjectId.make("old"),
    workspaceRoot: SPACE_ROOT,
    spaceId: "old-space",
    manifestCreatedAt: "2020-01-01T00:00:00Z",
    disposition: "destroyed" as const,
    ownerToken: null,
    leaseEpoch: 1,
    leaseUntil: null,
    deleteIntentSequence: null,
    sagaRemoveConfirmed: false,
    refusalCode: null,
    refusalMessage: null,
    anchorAt: null,
    scheduledAt: null,
    archiveDeadlineAt: null,
    archiveBasename: null,
    updatedAt: "2020-01-01T00:00:00Z",
    refreshedAt: null,
  };
  return Effect.gen(function* () {
    yield* check({
      projectRoot: SPACE_ROOT,
      projectId: ProjectId.make("new"),
      intent: "thread.create",
    });
    // A caller without a project id must still bind the lifecycle incarnation.
    yield* check({ projectRoot: SPACE_ROOT, intent: "thread.create" });
  }).pipe(
    Effect.provide(
      StaveAdmission.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            makeRecordingReader([]),
            Layer.mock(StaveLifecycleRepository)({
              getByWorkspaceRoot: () => Effect.succeed(Option.some(oldRow)),
              getByProjectId: () => Effect.succeed(Option.none()),
            }),
          ),
        ),
      ),
    ),
  );
});

it.effect(
  "blocks a lease held by the previous project even when the new project has no row",
  () => {
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        check({
          projectRoot: SPACE_ROOT,
          projectId: ProjectId.make("new"),
          intent: "thread.create",
        }),
      );
      expect(error._tag).toBe("StaveSpaceTransitioningError");
    }).pipe(
      Effect.provide(
        StaveAdmission.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              makeRecordingReader([]),
              Layer.mock(StaveLifecycleRepository)({
                getByWorkspaceRoot: () =>
                  Effect.succeed(
                    Option.some({
                      projectId: ProjectId.make("old"),
                      workspaceRoot: SPACE_ROOT,
                      spaceId: "alpha",
                      manifestCreatedAt: null,
                      disposition: "archiving",
                      ownerToken: "old-owner",
                      leaseEpoch: 2,
                      leaseUntil: "2030-01-01T00:00:00Z",
                      deleteIntentSequence: null,
                      sagaRemoveConfirmed: false,
                      refusalCode: null,
                      refusalMessage: null,
                      anchorAt: null,
                      scheduledAt: null,
                      archiveDeadlineAt: null,
                      archiveBasename: null,
                      updatedAt: "2026-01-01T00:00:00Z",
                      refreshedAt: null,
                    }),
                  ),
                getByProjectId: () =>
                  Effect.die("A root lease must refuse before looking up the new project"),
              }),
            ),
          ),
        ),
      ),
    );
  },
);
