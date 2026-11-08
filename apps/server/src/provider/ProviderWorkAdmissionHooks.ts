/**
 * Foreground is claimed after `beforeTurnStart` (interrupting a background decision writer on the
 * same provider instance) and released at the run's terminal notice, so background work never
 * starves a foreground turn and a foreground turn never overlaps a running helper.
 */
import type { RunId, ThreadId } from "@lecturn/contracts";
import { Effect } from "effect";
import type { LecturnOrchestrationHooksContribution } from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import type { ProviderWorkAdmission } from "./ProviderWorkAdmission.ts";

export const makeProviderWorkAdmissionContribution = (
  admission: ProviderWorkAdmission["Service"],
): LecturnOrchestrationHooksContribution => {
  // Retries of one run replace its token; only that run's terminal releases it.
  const foreground = new Map<RunId, { readonly threadId: ThreadId; readonly token: number }>();
  return {
    name: "provider-work-admission",
    beforeTurnStart: ({ thread, run }) =>
      admission.beginForeground(run.providerInstanceId, thread.id).pipe(
        Effect.tap((token) =>
          Effect.sync(() => foreground.set(run.id, { threadId: thread.id, token })),
        ),
        Effect.asVoid,
      ),
    onRunTerminal: ({ runId }) =>
      Effect.suspend(() => {
        const claimed = foreground.get(runId);
        if (claimed === undefined) return Effect.void;
        foreground.delete(runId);
        return admission.abandonForeground(claimed.threadId, claimed.token);
      }),
  };
};
