import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProject } from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { checkStaveWorktreeRpcOwnership } from "./ws.ts";
import { StaveWorktreeForbiddenError } from "./stave/StaveAdmission.ts";
import * as StaveAdmission from "./stave/StaveAdmission.ts";
import * as StaveWorkspaceReader from "./stave/StaveWorkspaceReader.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";

it.effect(
  "refuses secondary Stave repositories through separately imported roots and canonical aliases",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const space = path.join(root, "space");
      const secondary = path.join(root, "secondary");
      const alias = path.join(root, "alias");
      yield* fs.makeDirectory(secondary, { recursive: true });
      yield* fs.symlink(secondary, alias);
      const project: OrchestrationProject = {
        id: ProjectId.make("stave-owner"),
        title: "Space",
        workspaceRoot: space,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        deletedAt: null,
        stave: {
          spaceId: "space",
          isSaga: false,
          state: "live",
          repos: [
            { name: "primary", mode: "edit", path: "primary" },
            { name: "secondary", mode: "edit", path: "../secondary" },
          ],
          memories: [],
          primaryRepoPath: path.join(space, "primary"),
        },
      };
      const ordinary: OrchestrationProject = {
        ...project,
        id: ProjectId.make("ordinary"),
        workspaceRoot: secondary,
        stave: null,
      };
      for (const intent of ["pr.prepare", "vcs.createWorktree"] as const) {
        for (const cwd of [secondary, alias, path.join(secondary, "subdir")]) {
          const result = yield* checkStaveWorktreeRpcOwnership(
            {
              getShellSnapshot: () =>
                Effect.succeed({
                  snapshotSequence: 1,
                  projects: [ordinary, project],
                  threads: [],
                  updatedAt: project.updatedAt,
                }),
              getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.some(ordinary)),
            },
            {
              check: (input) => {
                expect(input.projectId).toBe(project.id);
                return Effect.fail(
                  new StaveWorktreeForbiddenError({
                    ...input,
                    message: "Stave owns this repository",
                  }),
                );
              },
            },
            { operation: intent, intent, cwd },
          ).pipe(Effect.flip);
          expect(result.detail).toContain("Stave owns this repository");
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "finds an unregistered parent space from ordinary child roots, subdirectories and aliases",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const space = path.join(root, "unregistered-space");
      const repo = path.join(space, "secondary");
      const alias = path.join(root, "alias");
      yield* fs.makeDirectory(path.join(repo, "src"), { recursive: true });
      yield* fs.symlink(repo, alias);
      yield* fs.writeFileString(
        path.join(space, ".stave.yaml"),
        "version: 2\nid: owner\ncreatedAt: '2026-09-01T00:00:00Z'\nrepos:\n  - name: secondary\n    path: secondary\n    mode: edit\nmemories: []\n",
      );
      const ordinary: OrchestrationProject = {
        id: ProjectId.make("only-child"),
        title: "Ordinary child",
        workspaceRoot: repo,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        deletedAt: null,
      };
      const admission = yield* StaveAdmission.StaveAdmission;
      for (const intent of ["pr.prepare", "vcs.createWorktree"] as const) {
        for (const cwd of [
          repo,
          path.join(repo, "src"),
          alias,
          path.join(alias, "src"),
          path.join(alias, "missing"),
        ]) {
          const result = yield* checkStaveWorktreeRpcOwnership(
            {
              getShellSnapshot: () =>
                Effect.succeed({
                  snapshotSequence: 1,
                  projects: [ordinary],
                  threads: [],
                  updatedAt: ordinary.updatedAt,
                }),
              getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
                Effect.succeed(workspaceRoot === repo ? Option.some(ordinary) : Option.none()),
            },
            admission,
            { operation: intent, intent, cwd },
          ).pipe(Effect.flip);
          expect(result.cause).toBeInstanceOf(StaveWorktreeForbiddenError);
        }
      }
      const unrelated = path.join(root, "ordinary");
      yield* fs.makeDirectory(unrelated);
      yield* checkStaveWorktreeRpcOwnership(
        {
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: [],
              updatedAt: ordinary.updatedAt,
            }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        },
        admission,
        { operation: "pr.prepare", intent: "pr.prepare", cwd: unrelated },
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        StaveAdmission.layer.pipe(
          Layer.provide(StaveWorkspaceReader.layer),
          Layer.provide(
            Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
              resolve: () => Effect.succeed(null),
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
