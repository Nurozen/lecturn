import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import {
  squireEntryIndicator,
  squireWatchScopeLine,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireId } from "@lecturn/contracts";
import { InboxIcon, SettingsIcon } from "lucide-react";
import { memo } from "react";

import { isElectron } from "../../env";
import { useQuietThreadShell } from "../../state/entities";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
import { squireHeaderCounts } from "./queue/squireQueue.logic";
import { useSquireQueuePages } from "./queue/squireQueueState";
import { SquireRoomsMenu } from "./rooms/SquireRoomsMenu";
import { SquireFindWorkButton } from "./setup/SquireLeadSweep";
import {
  SQUIRE_INBOX_NARROW_HINT,
  squireHeaderStateLine,
  squireLeadScopeLine,
} from "./squirePage.logic";

const TEAM_PORTRAIT_PX = 24;

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

/**
 * The view's state line, counting the rows its queue shows (the first page, which holds every
 * open decision and hold, and is the queue's own query). The sidebar badge stays own-items-only.
 */
export function useSquireViewStateLine(
  environmentId: EnvironmentId,
  entry: SquireSnapshotEntry,
  team: ReadonlyArray<SquireSnapshotEntry>,
) {
  const indicator = useSquireIndicator(environmentId, entry);
  const pages = useSquireQueuePages(environmentId, entry.squire.id, 1);
  const line = squireHeaderStateLine(
    {
      squire: entry.squire,
      indicator,
      openDecisionCount: entry.openDecisionCount,
      heldCount: entry.held.length,
    },
    pages.loaded ? squireHeaderCounts(pages.rows) : null,
    entry.squire.role === "lead" ? team : null,
  );
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

/** Stays put while the queue scrolls under it; carries the desktop drag region. */
export const SquireTopbar = memo(function SquireTopbar(props: {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  readonly name: string;
  /** Offered only at widths where the inbox fits; otherwise shown disabled, never hidden. */
  readonly inbox: {
    readonly offered: boolean;
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
  };
}) {
  const { inbox } = props;
  return (
    <WorkspacePageHeader electron={isElectron}>
      <WorkspaceBreadcrumb ariaLabel="Squire" className="min-w-0 flex-1">
        <WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbText>Squires</WorkspaceBreadcrumbText>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current>
          <WorkspaceBreadcrumbText>{props.name}</WorkspaceBreadcrumbText>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <SquireActivity
          environmentId={props.environmentId}
          squireId={props.squireId}
          name={props.name}
        />
        {inbox.offered ? (
          <Toggle
            size="xs-label"
            variant="ghost"
            pressed={inbox.open}
            onPressedChange={inbox.onOpenChange}
          >
            <InboxIcon />
            Inbox
          </Toggle>
        ) : (
          <Tooltip>
            {/* A disabled button gets no pointer events, so the wrapper carries the tooltip. */}
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Toggle size="xs-label" variant="ghost" pressed={false} disabled>
                <InboxIcon />
                Inbox
              </Toggle>
            </TooltipTrigger>
            <TooltipPopup>{SQUIRE_INBOX_NARROW_HINT}</TooltipPopup>
          </Tooltip>
        )}
      </div>
    </WorkspacePageHeader>
  );
});

/** Portrait, name, state line, watch scope; the Lead adds its team strip. */
export const SquireHeader = memo(function SquireHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly team: ReadonlyArray<SquireSnapshotEntry>;
  readonly teamFilter: SquireId | null;
  readonly onTeamFilterChange: (squireId: SquireId | null) => void;
  readonly portraitSize: number;
  readonly onOpenSettings: () => void;
}) {
  const { environmentId, entry, team } = props;
  const { indicator, line: stateLine } = useSquireViewStateLine(environmentId, entry, team);
  const isLead = entry.squire.role === "lead";
  // The onboarding panel offers its own "Ask for more proposals" under its cards.
  const onboardingProposals = useSquireLeadOnboardingCardIds(
    environmentId,
    isLead ? entry.squire.id : null,
  ).size;
  const scope = isLead
    ? squireLeadScopeLine(team, onboardingProposals)
    : `${squireWatchScopeLine(entry.trackedCount)}${
        entry.containerNames.length === 0 ? "" : ` · ${entry.containerNames.join(", ")}`
      }`;
  return (
    <div className="flex flex-col gap-3 px-6 pt-2 pb-3">
      <div className="flex min-w-0 items-center gap-4">
        <SquireIndicator
          state={indicator.state}
          palette={entry.squire.companion.palette}
          presence={entry.squire.companion.presence}
          appearance={entry.squire.companion.appearance}
          hood={entry.squire.companion.hood}
          isLead={isLead}
          size={props.portraitSize}
          label={`${entry.squire.name}: ${stateLine}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <h1 className="truncate text-lg font-semibold">{entry.squire.name}</h1>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`${entry.squire.name} settings`}
              onClick={props.onOpenSettings}
            >
              <SettingsIcon />
            </Button>
            {isLead ? (
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <SquireFindWorkButton environmentId={environmentId} />
                {onboardingProposals > 0 ? null : (
                  <SquireLeadAskMore environmentId={environmentId} lead={entry} />
                )}
                <SquireRoomsMenu environmentId={environmentId} />
              </div>
            ) : null}
          </div>
          <p className="truncate text-sm text-foreground/80">{stateLine}</p>
          <p className="truncate text-xs text-muted-foreground">{scope}</p>
        </div>
      </div>
      {team.length === 0 ? null : (
        <div
          role="group"
          aria-label="Filter by Squire"
          className="flex flex-wrap items-center gap-1.5"
        >
          {team.map((member) => (
            <TeamChip
              key={member.squire.id}
              environmentId={environmentId}
              member={member}
              pressed={props.teamFilter === member.squire.id}
              onSelect={props.onTeamFilterChange}
            />
          ))}
        </div>
      )}
    </div>
  );
});

function TeamChip(props: {
  readonly environmentId: EnvironmentId;
  readonly member: SquireSnapshotEntry;
  readonly pressed: boolean;
  readonly onSelect: (squireId: SquireId | null) => void;
}) {
  const { member } = props;
  const decisions = member.openDecisionCount;
  return (
    <Toggle
      size="sm-label"
      variant="outline"
      aria-label={`${member.squire.name}: show only its items${decisions > 0 ? `, ${decisions} need a decision` : ""}`}
      pressed={props.pressed}
      onPressedChange={(next) => props.onSelect(next ? member.squire.id : null)}
    >
      <SquirePortrait
        environmentId={props.environmentId}
        entry={member}
        size={TEAM_PORTRAIT_PX}
        label={member.squire.name}
      />
      <span className="truncate">{member.squire.name}</span>
      {decisions > 0 ? (
        <span className="text-xs font-medium text-muted-foreground tabular-nums">{decisions}</span>
      ) : null}
    </Toggle>
  );
}
