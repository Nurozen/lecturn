import type { OrchestrationProjectShell } from "@lecturn/contracts";
import { Effect, FileSystem, Option, Path } from "effect";

import { mapManifestToProjectInfo, readManifest } from "./StaveWorkspaceReader.ts";
import { STAVE_MANIFEST_FILE_NAME } from "./staveManifest.ts";

/** Decode and canonicalise ownership once for a single automatic-pull pass. */
export const makeStaveAutoPullOwnerCheck = Effect.fn("makeStaveAutoPullOwnerCheck")(
  function* (projects: ReadonlyArray<OrchestrationProjectShell>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonical = Effect.fn("StaveAutoPullOwnership.canonical")(function* (root: string) {
      let candidate = path.resolve(root);
      const missing: string[] = [];
      while (true) {
        const resolved = yield* fs.realPath(candidate).pipe(Effect.option);
        if (Option.isSome(resolved)) {
          return path.join(resolved.value, ...missing.toReversed());
        }
        const parent = path.dirname(candidate);
        if (parent === candidate) return path.resolve(root);
        missing.push(path.basename(candidate));
        candidate = parent;
      }
    });
    const ownershipRoots = new Set<string>();
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
      for (const root of new Set(roots)) {
        ownershipRoots.add(yield* canonical(root));
      }
    }

    return Effect.fn("StaveAutoPullOwnership.hasOwner")(
      function* (cwd: string) {
        let candidate = yield* canonical(cwd);
        for (const root of ownershipRoots) {
          const relative = path.relative(root, candidate);
          if (
            relative === "" ||
            (relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative))
          ) {
            return true;
          }
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
  },
  Effect.orElseSucceed(() => (_cwd: string) => Effect.succeed(true)),
);

/** Automatic pulls must not take over Stave's repository synchronisation. */
export const hasStaveAutoPullOwner = Effect.fn("hasStaveAutoPullOwner")(
  function* (projects: ReadonlyArray<OrchestrationProjectShell>, cwd: string) {
    const hasOwner = yield* makeStaveAutoPullOwnerCheck(projects);
    return yield* hasOwner(cwd);
  },
  Effect.orElseSucceed(() => true),
);
