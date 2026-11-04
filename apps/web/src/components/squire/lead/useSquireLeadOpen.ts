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
 * `squire.lead.open` once per Lead view open. The server queues onboarding on the first
 * open and records the client's time zone for the digest; a queued onboarding shows the "looking" state.
 */
export function useSquireLeadOpen(environmentId: EnvironmentId, enabled: boolean) {
  const allowed = useAtomValue(squireEnvironment.leadOpen.permissionAtom(environmentId));
  const leadOpen = useAtomCommand(squireEnvironment.leadOpen, { reportFailure: false });
  // The route keys the view by Squire, so the ref lives exactly as long as one view open.
  const opened = useRef(false);
  useEffect(() => {
    if (!enabled || !allowed || opened.current) return;
    opened.current = true;
    void leadOpen({ environmentId, input: { requestId: randomUUID() } }).then((result) => {
      if (result._tag === "Success" && result.value.onboardingQueued) {
        squireLeadOnboardingRuns.queued(environmentId);
      }
    });
  }, [allowed, enabled, environmentId, leadOpen]);
}
