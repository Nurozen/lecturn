import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@lecturn/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { randomUUID } from "../../../lib/utils";
import { squireEnvironment } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { createSquireLeadOnboardingRuns, type SquireLeadOnboardingRun } from "./squireLead.logic";

/** Environments whose onboarding this page load queued, until the Lead's first turn ends. */
export const squireLeadOnboardingRuns = createSquireLeadOnboardingRuns();

export function useSquireLeadOnboardingRun(
  environmentId: EnvironmentId,
): SquireLeadOnboardingRun | null {
  const read = () => squireLeadOnboardingRuns.get(environmentId);
  return useSyncExternalStore(squireLeadOnboardingRuns.subscribe, read, read);
}

/**
 * `squire.lead.open` once per Lead view open. It records the client's time zone for the digest
 * and defers the paid onboarding, so the Lead's intro shows first; an older server ignores the
 * deferral and queues it, which shows the "looking" state.
 */
export function useSquireLeadOpen(environmentId: EnvironmentId, enabled: boolean) {
  const allowed = useAtomValue(squireEnvironment.leadOpen.permissionAtom(environmentId));
  const leadOpen = useAtomCommand(squireEnvironment.leadOpen, { reportFailure: false });
  // The route keys the view by Squire, so the ref lives exactly as long as one view open.
  const opened = useRef(false);
  useEffect(() => {
    if (!enabled || !allowed || opened.current) return;
    opened.current = true;
    void leadOpen({ environmentId, input: { requestId: randomUUID(), onboarding: "defer" } }).then(
      (result) => {
        if (result._tag === "Success" && result.value.onboardingQueued) {
          squireLeadOnboardingRuns.queued(environmentId);
        }
      },
    );
  }, [allowed, enabled, environmentId, leadOpen]);
}

/** The intro's "look over my threads": queues the paid onboarding turn. */
export function useSquireLeadStartOnboarding(environmentId: EnvironmentId) {
  const allowed = useAtomValue(squireEnvironment.leadOpen.permissionAtom(environmentId));
  const leadOpen = useAtomCommand(squireEnvironment.leadOpen, { reportFailure: false });
  const start = async () => {
    const result = await leadOpen({
      environmentId,
      input: { requestId: randomUUID(), onboarding: "start" },
    });
    if (result._tag === "Failure") return false;
    // Not queued means it already ran, from another client; the snapshot ends the intro then.
    if (result.value.onboardingQueued) squireLeadOnboardingRuns.queued(environmentId);
    return true;
  };
  return { allowed, start };
}
