import type { SquireId } from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

// A Squire's home thread runs in its own Git repository. Checkpoint
// capture finds the repository by walking up from the cwd, so a plain folder
// under a Lecturn home that sits inside a Git checkout (a dev home in a
// worktree, a $HOME kept in Git) would write hidden refs into that checkout.
// `git init` here makes the workspace its own top level. Capture works on an
// unborn HEAD, so no initial commit is needed.

export class SquireWorkspaceError extends Schema.TaggedError<SquireWorkspaceError>()(
  "SquireWorkspaceError",
  {
    squireId: Schema.String,
    operation: Schema.Literals(["ensure", "remove"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the workspace for Squire ${this.squireId}.`;
  }
}

export class SquireWorkspacePathError extends Schema.TaggedError<SquireWorkspacePathError>()(
  "SquireWorkspacePathError",
  { path: Schema.String },
) {
  override get message(): string {
    return "This folder belongs to a Squire.";
  }
}

/**
 * Whether `target` is at or under `<stateDir>/squires`. Both sides are
 * compared lexically and with symlinks resolved component by component, so
 * neither a symlink nor a `..` after one can hide a Squire workspace.
 */
export const isSquireWorkspacePath = Effect.fn("SquireWorkspace.isSquireWorkspacePath")(function* (
  stateDir: string,
  target: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A `..` applies to the real parent, as the OS does; Node's realpath
  // normalizes `..` lexically first.
  const canonical = Effect.fnUntraced(function* (candidate: string) {
    const absolute = path.isAbsolute(candidate)
      ? candidate
      : `${path.resolve(".")}${path.sep}${candidate}`;
    const { root } = path.parse(absolute);
    let current = root;
    for (const segment of absolute.slice(root.length).split(/[\\/]/)) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        current = path.dirname(current);
        continue;
      }
      const next = path.join(current, segment);
      current = yield* fileSystem.realPath(next).pipe(Effect.orElseSucceed(() => next));
    }
    return current;
  });
  const within = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const squiresRoot = path.join(stateDir, "squires");
  const roots = [path.resolve(squiresRoot), yield* canonical(squiresRoot)];
  const candidates = [path.resolve(target), yield* canonical(target)];
  return roots.some((root) => candidates.some((candidate) => within(root, candidate)));
});

/** Fails with SquireWorkspacePathError for a path `isSquireWorkspacePath` accepts. */
export const refuseSquireWorkspacePath = (stateDir: string, target: string) =>
  isSquireWorkspacePath(stateDir, target).pipe(
    Effect.flatMap((owned) =>
      owned ? Effect.fail(new SquireWorkspacePathError({ path: target })) : Effect.void,
    ),
  );

export class SquireWorkspace extends Context.Service<
  SquireWorkspace,
  {
    /** `<userdata>/squires/<squireId>/workspace`. */
    readonly pathFor: (squireId: SquireId) => Effect.Effect<string, SquireWorkspaceError>;
    /** Creates the folder and its repository; a no-op once the folder is its own Git top level. */
    readonly ensure: (squireId: SquireId) => Effect.Effect<string, SquireWorkspaceError>;
    /** Deletes the workspace; a no-op when it is already gone. Only Squire deletion calls it. */
    readonly remove: (squireId: SquireId) => Effect.Effect<void, SquireWorkspaceError>;
  }
>()("lecturn/squire/SquireWorkspace") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;

  const resolve = (
    squireId: SquireId,
    operation: SquireWorkspaceError["operation"],
  ): Effect.Effect<string, SquireWorkspaceError> =>
    // `remove` deletes recursively, so the id must stay one path segment.
    squireId === "." || squireId === ".." || path.basename(squireId) !== squireId
      ? Effect.fail(
          new SquireWorkspaceError({
            squireId,
            operation,
            cause: new Error("The Squire id is not a single path segment."),
          }),
        )
      : Effect.succeed(path.join(config.stateDir, "squires", squireId, "workspace"));
  const pathFor: SquireWorkspace["Service"]["pathFor"] = (squireId) => resolve(squireId, "ensure");

  const git = (cwd: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
    vcsProcess.run({
      operation: "SquireWorkspace.git",
      command: "git",
      cwd,
      args,
      allowNonZeroExit,
      timeoutMs: 15_000,
      maxOutputBytes: 16_384,
    });

  const isOwnRepository = (workspace: string) =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(path.join(workspace, ".git")))) return false;
      const topLevel = yield* git(workspace, ["rev-parse", "--show-toplevel"], true);
      if (topLevel.exitCode !== 0) return false;
      return (
        (yield* fileSystem.realPath(topLevel.stdout.trim())) ===
        (yield* fileSystem.realPath(workspace))
      );
    });

  const ensure: SquireWorkspace["Service"]["ensure"] = (squireId) =>
    resolve(squireId, "ensure").pipe(
      Effect.flatMap((workspace) =>
        Effect.gen(function* () {
          if (yield* isOwnRepository(workspace)) return workspace;
          yield* fileSystem.makeDirectory(workspace, { recursive: true });
          // Re-running init repairs a half-written .git and never touches
          // existing objects or refs.
          yield* git(workspace, ["-c", "init.defaultBranch=main", "init", "--quiet"]);
          return workspace;
        }).pipe(
          Effect.mapError(
            (cause) => new SquireWorkspaceError({ squireId, operation: "ensure", cause }),
          ),
        ),
      ),
    );

  const remove: SquireWorkspace["Service"]["remove"] = (squireId) =>
    resolve(squireId, "remove").pipe(
      Effect.flatMap((workspace) =>
        fileSystem
          .remove(workspace, { recursive: true, force: true })
          .pipe(
            Effect.mapError(
              (cause) => new SquireWorkspaceError({ squireId, operation: "remove", cause }),
            ),
          ),
      ),
    );

  return SquireWorkspace.of({ pathFor, ensure, remove });
});

export const layer = Layer.effect(SquireWorkspace, make);
