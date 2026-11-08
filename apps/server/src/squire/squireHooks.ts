/**
 * Writers read the registry with `Effect.serviceOption` and features register into it when built, so layer order
 * does not matter as long as one registry instance sits below both.
 * @module squire/squireHooks
 */
import type { RunId, SquireTurnSummary, ThreadId } from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { SquireSummaryStage } from "./SquireSummaries.ts";

/** A summary just stored, live (`SquireSummaries`) or injected (`SquireDevFixtures`). */
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
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logWarning(message, { cause: Cause.pretty(cause) }),
        ),
      ),
    { discard: true },
  );

const make = Effect.sync(() => {
  const summaryHooks: Array<SquireSummaryStoredHook> = [];
  const threadHooks: Array<SquireThreadChangedHook> = [];
  return SquireHooks.of({
    onSummaryStored: Effect.fn("SquireHooks.onSummaryStored")(function (hook) {
      return Effect.sync(() => void summaryHooks.push(hook));
    }),
    onThreadChanged: Effect.fn("SquireHooks.onThreadChanged")(function (hook) {
      return Effect.sync(() => void threadHooks.push(hook));
    }),
    summaryStored: Effect.fn("SquireHooks.summaryStored")(function (stored) {
      return runAll(summaryHooks, stored, "Squire summary hook failed");
    }),
    threadChanged: Effect.fn("SquireHooks.threadChanged")(function (threadId) {
      return runAll(threadHooks, threadId, "Squire thread hook failed");
    }),
  });
});

export const layer = Layer.effect(SquireHooks, make);
