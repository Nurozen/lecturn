import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@lecturn/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { randomUUID } from "../../../lib/utils";
import { serverEnvironment } from "../../../state/server";
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
 * `squire.lead.open` once per Lead view open. It records the client's time zone for the digest.
 * A server that applies the Squires switch live also honors `defer`, so the Lead's intro shows
 * before the paid onboarding; an older one is not asked to defer and queues it on the first
 * open, which shows the "looking" state.
 */
export function useSquireLeadOpen(environmentId: EnvironmentId, enabled: boolean) {
  const allowed = useAtomValue(squireEnvironment.leadOpen.permissionAtom(environmentId));
  const defers = useSquireLeadIntroSupported(environmentId);
  const leadOpen = useAtomCommand(squireEnvironment.leadOpen, { reportFailure: false });
  // The route keys the view by Squire, so the ref lives exactly as long as one view open.
  const opened = useRef(false);
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- sends the server one lead-open request per view open once the view is enabled and allowed
  useEffect(() => {
    if (!enabled || !allowed || opened.current) return;
    opened.current = true;
    const input = { requestId: randomUUID(), ...(defers ? { onboarding: "defer" as const } : {}) };
    void leadOpen({ environmentId, input }).then((result) => {
      if (result._tag === "Success" && result.value.onboardingQueued) {
        squireLeadOnboardingRuns.queued(environmentId);
      }
    });
  }, [allowed, defers, enabled, environmentId, leadOpen]);
}

/**
 * Whether the server honors a deferred onboarding. `squireLiveSwitch` shipped with it; it is
 * also absent where `LECTURN_SQUIRE` pins the switch, which then keeps the old first-open scan.
 */
export function useSquireLeadIntroSupported(environmentId: EnvironmentId): boolean {
  return (
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .squireLiveSwitch === true
  );
}

/** The intro's "look over my threads": queues the paid onboarding turn. */
export function useSquireLeadStartOnboarding(environmentId: EnvironmentId) {
  const allowed = useAtomValue(squireEnvironment.leadOpen.permissionAtom(environmentId));
  const leadOpen = useAtomCommand(squireEnvironment.leadOpen, { reportFailure: false });
  const start = async () => {
    // "Looking" from the click, so a snapshot that lands before the reply never blinks the panel.
    squireLeadOnboardingRuns.queued(environmentId);
    const result = await leadOpen({
      environmentId,
      input: { requestId: randomUUID(), onboarding: "start" },
    });
    // Not queued means it already ran, from another client; the snapshot ends the intro then.
    if (result._tag === "Failure" || !result.value.onboardingQueued) {
      squireLeadOnboardingRuns.cancel(environmentId);
    }
    return result._tag === "Success";
  };
  return { allowed, start };
}
