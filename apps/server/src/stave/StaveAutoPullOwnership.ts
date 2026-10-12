import type { OrchestrationProjectShell } from "@lecturn/contracts";
import { Effect, FileSystem, Option, Path } from "effect";

import { isPathUnder } from "./StaveSpaceLock.ts";
import { mapManifestToProjectInfo, readManifest } from "./StaveWorkspaceReader.ts";
import { STAVE_MANIFEST_FILE_NAME } from "./staveManifest.ts";

/** Automatic pulls must not take over Stave's repository synchronisation. */
export const hasStaveAutoPullOwner = Effect.fn("hasStaveAutoPullOwner")(
  function* (projects: ReadonlyArray<OrchestrationProjectShell>, cwd: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const project of projects) {
      const workspaceRoot = yield* fs
        .realPath(project.workspaceRoot)
        .pipe(Effect.orElseSucceed(() => path.resolve(project.workspaceRoot)));
      let space = project.stave;
      if (space == null) {
        const manifest = yield* readManifest(workspaceRoot);
        if (Option.isSome(manifest)) {
          space = mapManifestToProjectInfo({
            manifest: manifest.value,
            location: {
              workspaceRoot,
              parentBasename: path.basename(path.dirname(workspaceRoot)),
              basename: path.basename(workspaceRoot),
            },
            resolveRepoPath: (repoPath) => path.resolve(workspaceRoot, repoPath),
          });
        }
      }
      if (space == null) continue;
      const primaryRepo = space.repos.find((repo) => repo.mode === "edit");
      const primaryRepoPath =
        primaryRepo === undefined
          ? space.primaryRepoPath
          : path.resolve(workspaceRoot, primaryRepo.path);
      const roots = [
        workspaceRoot,
        ...(primaryRepoPath ? [primaryRepoPath] : []),
        ...space.repos.map((repo) => path.resolve(workspaceRoot, repo.path)),
      ];
      for (const root of roots) {
        if (yield* isPathUnder(root, cwd)) return true;
      }
    }

    let candidate = path.resolve(cwd);
    const missing: string[] = [];
    while (true) {
      const canonical = yield* fs.realPath(candidate).pipe(Effect.option);
      if (Option.isSome(canonical)) {
        candidate = path.join(canonical.value, ...missing.toReversed());
        break;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      missing.push(path.basename(candidate));
      candidate = parent;
    }
    // Match Git's manifest ceiling even when no registered project has metadata.
    while (true) {
      if (yield* fs.exists(path.join(candidate, STAVE_MANIFEST_FILE_NAME))) return true;
      const parent = path.dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  },
  Effect.orElseSucceed(() => true),
);
