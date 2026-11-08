import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import {
  squireEntryIndicator,
  squireStateLine,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId } from "@lecturn/contracts";
import { SettingsIcon } from "lucide-react";
import { memo } from "react";

import { isElectron } from "../../env";
import { useQuietThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SquireActivity } from "./SquireActivity";
import { SquireIndicator } from "./SquireIndicator";
import { SquireLeadAskMore, useSquireLeadOnboardingCardIds } from "./lead/SquireLeadOnboarding";
import { SquireRoomsMenu } from "./rooms/SquireRoomsMenu";
import { SquireFindWorkButton } from "./setup/SquireLeadSweep";

const TOPBAR_PORTRAIT_PX = 20;

/** The home thread's shell, which alone carries the turn status the indicator follows. */
export function useSquireHomeShell(environmentId: EnvironmentId, entry: SquireSnapshotEntry) {
  const homeThreadId = entry.squire.homeThreadId;
  return useQuietThreadShell(
    homeThreadId === null ? null : scopeThreadRef(environmentId, homeThreadId),
  );
}

export function useSquireIndicator(environmentId: EnvironmentId, entry: SquireSnapshotEntry) {
  return squireEntryIndicator(entry, useSquireHomeShell(environmentId, entry));
}

export function useSquireViewStateLine(environmentId: EnvironmentId, entry: SquireSnapshotEntry) {
  const indicator = useSquireIndicator(environmentId, entry);
  const line = squireStateLine({
    squire: entry.squire,
    indicator,
    openDecisionCount: entry.openDecisionCount,
    heldCount: entry.held.length,
  });
  return { indicator, line };
}

export function SquirePortrait(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly size: number;
  readonly label: string;
}) {
  const indicator = useSquireIndicator(props.environmentId, props.entry);
  const { companion, role } = props.entry.squire;
  return (
    <SquireIndicator
      state={indicator.state}
      palette={companion.palette}
      presence={companion.presence}
      appearance={companion.appearance}
      hood={companion.hood}
      isLead={role === "lead"}
      size={props.size}
      label={props.label}
    />
  );
}

/** The Squire's page header: its portrait and name, activity, settings, and the Lead's tools. */
export const SquireTopbar = memo(function SquireTopbar(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly isLead: boolean;
  readonly onOpenSettings: () => void;
}) {
  const { environmentId, entry, isLead } = props;
  const { squire } = entry;
  // The onboarding panel offers its own "Ask for more proposals" under its cards.
  const onboardingProposals = useSquireLeadOnboardingCardIds(
    environmentId,
    isLead ? squire.id : null,
  ).size;
  return (
    <WorkspacePageHeader electron={isElectron}>
      <WorkspaceBreadcrumb ariaLabel="Squire" className="min-w-0 flex-1">
        <WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbText>Squires</WorkspaceBreadcrumbText>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current>
          <SquirePortrait
            environmentId={environmentId}
            entry={entry}
            size={TOPBAR_PORTRAIT_PX}
            label={squire.name}
          />
          <WorkspaceBreadcrumbText>{squire.name}</WorkspaceBreadcrumbText>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {isLead ? (
          <>
            <SquireFindWorkButton environmentId={environmentId} />
            {onboardingProposals > 0 ? null : (
              <SquireLeadAskMore environmentId={environmentId} lead={entry} />
            )}
            <SquireRoomsMenu environmentId={environmentId} />
          </>
        ) : null}
        <SquireActivity environmentId={environmentId} squireId={squire.id} name={squire.name} />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`${squire.name} settings`}
          onClick={props.onOpenSettings}
        >
          <SettingsIcon />
        </Button>
      </div>
    </WorkspacePageHeader>
  );
});
