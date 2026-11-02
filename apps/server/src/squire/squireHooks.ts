/**
 * Hooks that let feature layers follow stored summaries and thread changes
 * without the summary writers or the reactor depending on them (7.3). The
 * writers read the registry with `Effect.serviceOption` when they are built,
 * and features register into it when they are built, so layer order does
 * not matter as long as one registry instance sits below both.
 *
 * @module squire/squireHooks
 */
import type { RunId, SquireTurnSummary, ThreadId } from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { SquireSummaryStage } from "./SquireSummaries.ts";

/** A summary just stored, live (`SquireSummaries`) or injected (`SquireDevFixtures`, D44j). */
export interface SquireStoredSummaryHookInput {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly stage: SquireSummaryStage;
  readonly summary: SquireTurnSummary;
}

export type SquireSummaryStoredHook = (stored: SquireStoredSummaryHookInput) => Effect.Effect<void>;
export type SquireThreadChangedHook = (threadId: ThreadId) => Effect.Effect<void>;

export class SquireHooks extends Context.Service<
  SquireHooks,
  {
    readonly onSummaryStored: (hook: SquireSummaryStoredHook) => Effect.Effect<void>;
    readonly onThreadChanged: (hook: SquireThreadChangedHook) => Effect.Effect<void>;
    /** Runs every summary hook in registration order; a failing hook is logged, never raised. */
    readonly summaryStored: (stored: SquireStoredSummaryHookInput) => Effect.Effect<void>;
    /** A PR link, settle, archive, delete, or metadata change committed on the thread. */
    readonly threadChanged: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("lecturn/squire/squireHooks") {}

const runAll = <A>(
  hooks: ReadonlyArray<(input: A) => Effect.Effect<void>>,
  input: A,
  message: string,
) =>
  Effect.forEach(
    hooks,
    (hook) =>
      hook(input).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning(message, { cause: Cause.pretty(cause) }),
        ),
      ),
    { discard: true },
  );

export const make = Effect.sync(() => {
  const summaryHooks: Array<SquireSummaryStoredHook> = [];
  const threadHooks: Array<SquireThreadChangedHook> = [];
  return SquireHooks.of({
    onSummaryStored: (hook) => Effect.sync(() => void summaryHooks.push(hook)),
    onThreadChanged: (hook) => Effect.sync(() => void threadHooks.push(hook)),
    summaryStored: (stored) => runAll(summaryHooks, stored, "Squire summary hook failed"),
    threadChanged: (threadId) => runAll(threadHooks, threadId, "Squire thread hook failed"),
  });
});

export const layer = Layer.effect(SquireHooks, make);
