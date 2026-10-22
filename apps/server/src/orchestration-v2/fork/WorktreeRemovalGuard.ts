/**
 * Lecturn: never remove a worktree another thread still works in.
 *
 * Clients remove a worktree only after deleting its owning thread, so that
 * thread is already soft-deleted and does not count. Any remaining thread
 * (archived ones included) that names the worktree keeps it alive.
 */
import { ThreadId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../ProjectionStore.ts";

export class WorktreeStillInUseError extends Schema.TaggedError<WorktreeStillInUseError>()(
  "WorktreeStillInUseError",
  {
    worktreePath: Schema.String,
    threadIds: Schema.Array(ThreadId),
  },
) {
  override get message(): string {
    return `Refused to remove worktree ${this.worktreePath}: ${this.threadIds.length} thread(s) still reference it.`;
  }
}

/** Active and archived, non-deleted threads whose worktree is `worktreePath`. */
export const listThreadIdsUsingWorktree = Effect.fn("orchestrationV2.listThreadIdsUsingWorktree")(
  function* (worktreePath: string, options?: { readonly excludeThreadId?: ThreadId }) {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const path = yield* Path.Path;
    const target = path.resolve(worktreePath);
    const [active, archived] = yield* Effect.all([
      projections.getShellSnapshot({ location: "active" }),
      projections.getShellSnapshot({ location: "archive" }),
    ]);
    const seen = new Set<ThreadId>();
    const threadIds: Array<ThreadId> = [];
    for (const thread of [
      ...active.threads,
      ...active.archivedThreads,
      ...archived.threads,
      ...archived.archivedThreads,
    ]) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      if (thread.id === options?.excludeThreadId || thread.deletedAt !== null) continue;
      if (thread.worktreePath !== null && path.resolve(thread.worktreePath) === target) {
        threadIds.push(thread.id);
      }
    }
    return threadIds;
  },
);

/**
 * Runs `remove` only when no other thread uses the worktree; fails with
 * WorktreeStillInUseError otherwise. s-surface wraps vcsRemoveWorktree in it.
 */
export const guardWorktreeRemoval = <A, E, R>(
  worktreePath: string,
  remove: Effect.Effect<A, E, R>,
  options?: { readonly excludeThreadId?: ThreadId },
): Effect.Effect<
  A,
  E | WorktreeStillInUseError | ProjectionStore.ProjectionStoreV2Error,
  R | ProjectionStore.ProjectionStoreV2 | Path.Path
> =>
  listThreadIdsUsingWorktree(worktreePath, options).pipe(
    Effect.flatMap((threadIds): Effect.Effect<A, E | WorktreeStillInUseError, R> =>
      threadIds.length === 0
        ? remove
        : Effect.fail(new WorktreeStillInUseError({ worktreePath, threadIds })),
    ),
  );
