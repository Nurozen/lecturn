/**
 * StaveAdmission - Effect service that fences mutations which would break a
 * Stave space's invariants, consulted before a command or RPC is dispatched.
 *
 * A Stave project is a project whose workspace root carries a `.stave.yaml`
 * manifest (as reported by `StaveWorkspaceReader`). Threads in a space always
 * run in the space root, so the worktree rule refuses every intent that would
 * create or bind a per-thread worktree there: `thread.create` /
 * `thread.meta.update` with a non-null `worktreePath`, a bootstrap turn start
 * that prepares a worktree, a fork that would inherit a worktree, and the
 * worktree-producing git RPCs. Non-Stave roots always pass, and intents that
 * do not touch worktrees never read the manifest at all.
 *
 * Lifecycle rules (archived and transitioning spaces) are added beside the
 * worktree rule; their errors join the `StaveAdmissionError` union.
 *
 * @module StaveAdmission
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";

// ---------------------------------------------------------------------------
// Errors
//
// One class per refusal so callers (and clients matching on `_tag`) can tell
// them apart. `StaveArchivedProjectError` and `StaveSpaceTransitioningError`
// belong here too once the lifecycle table exists; add them to
// `StaveAdmissionError` so `check` keeps a closed error channel.
// ---------------------------------------------------------------------------

export const StaveAdmissionIntent = Schema.Literals([
  "thread.create",
  "thread.meta.update",
  "thread.turn.start",
  "thread.fork",
  "vcs.createWorktree",
  "pr.prepare",
]);
export type StaveAdmissionIntent = typeof StaveAdmissionIntent.Type;

export const STAVE_WORKTREE_FORBIDDEN_MESSAGE =
  "Stave spaces run threads in the space root; worktrees are not used";

export class StaveWorktreeForbiddenError extends Schema.TaggedErrorClass<StaveWorktreeForbiddenError>()(
  "StaveWorktreeForbiddenError",
  {
    projectRoot: Schema.String,
    intent: StaveAdmissionIntent,
    message: Schema.String,
  },
) {}

export type StaveAdmissionError = StaveWorktreeForbiddenError;

export const isStaveAdmissionError: (cause: unknown) => cause is StaveAdmissionError = Schema.is(
  StaveWorktreeForbiddenError,
);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface StaveAdmissionInput {
  /** Workspace root of the project the mutation targets (exact root, not a cwd inside it). */
  readonly projectRoot: string;
  readonly intent: StaveAdmissionIntent;
  /** Worktree the command would bind the thread to; `null`/absent means the project root. */
  readonly worktreePath?: string | null;
  /** Whether the command carries a `bootstrap.prepareWorktree` step. */
  readonly prepareWorktree?: boolean;
}

export class StaveAdmission extends Context.Service<
  StaveAdmission,
  {
    /**
     * Succeeds when the intent is admissible for the project; fails with the
     * typed refusal otherwise. Never fails for a non-Stave root.
     */
    readonly check: (input: StaveAdmissionInput) => Effect.Effect<void, StaveAdmissionError>;
  }
>()("t3/stave/StaveAdmission") {}

/** Intents that exist only to create a worktree, regardless of the payload. */
const WORKTREE_PRODUCING_INTENTS: ReadonlySet<StaveAdmissionIntent> = new Set([
  "vcs.createWorktree",
  "pr.prepare",
]);

/**
 * Pure worktree rule: does the intent create or use a per-thread worktree?
 * The manifest is only read when this is true.
 */
export const intentUsesWorktree = (input: StaveAdmissionInput): boolean =>
  WORKTREE_PRODUCING_INTENTS.has(input.intent) ||
  input.prepareWorktree === true ||
  (input.worktreePath !== undefined && input.worktreePath !== null);

export const make = Effect.fn("StaveAdmission.make")(function* () {
  const reader = yield* StaveWorkspaceReader;

  const check = Effect.fn("StaveAdmission.check")(function* (input: StaveAdmissionInput) {
    if (!intentUsesWorktree(input)) {
      return;
    }
    const space = yield* reader.load(input.projectRoot);
    if (Option.isNone(space)) {
      return;
    }
    return yield* new StaveWorktreeForbiddenError({
      projectRoot: input.projectRoot,
      intent: input.intent,
      message: STAVE_WORKTREE_FORBIDDEN_MESSAGE,
    });
  });

  return StaveAdmission.of({ check });
});

export const layer = Layer.effect(StaveAdmission, make());

/** Admission that admits everything — for tests whose projects are never spaces. */
export const layerNoop = Layer.succeed(
  StaveAdmission,
  StaveAdmission.of({
    check: () => Effect.void,
  }),
);
