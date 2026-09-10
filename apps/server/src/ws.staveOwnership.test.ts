import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProject } from "@t3tools/contracts";
import { Effect, FileSystem, Option, Path } from "effect";
import { checkStaveWorktreeRpcOwnership } from "./ws.ts";
import { StaveWorktreeForbiddenError } from "./stave/StaveAdmission.ts";

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
