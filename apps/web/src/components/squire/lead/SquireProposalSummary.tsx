import type { EnvironmentId } from "@lecturn/contracts";

import { cn } from "../../../lib/utils";
import { useProjects } from "../../../state/entities";
import { Badge } from "../../ui/badge";
import { SquireCompanion } from "../SquireCompanion";
import { SQUIRE_PALETTE_TINT } from "../squirePaletteTint";
import {
  squireProposalCardText,
  squireProposalPaletteLabel,
  squireProposalPortrait,
  type SquireProposalPayload,
} from "./squireLead.logic";

/**
 * A proposed Squire as it would be created (P17.2): its figure as a still bust, name, scope by
 * name, permissions, and brief. Shared by the onboarding cards and the queue's card.
 */
export function SquireProposalSummary(props: {
  readonly environmentId: EnvironmentId;
  readonly proposal: SquireProposalPayload;
}) {
  const { environmentId, proposal } = props;
  const projects = useProjects();
  const text = squireProposalCardText(proposal, {
    project: (projectId) =>
      projects.find(
        (project) => project.environmentId === environmentId && project.id === projectId,
      )?.title ?? null,
    thread: () => null,
  });
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-start gap-3">
        <SquireProposalBust
          companion={proposal.companion}
          label={`${text.name}'s ${proposal.companion.presence === "emblem" ? "emblem" : "figure"}`}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="break-words text-sm font-medium text-foreground">{text.name}</span>
          <span className="break-words text-xs text-muted-foreground">{text.scope}</span>
          <span
            className={cn(
              "flex items-center gap-1.5 pt-0.5 text-xs text-muted-foreground",
              SQUIRE_PALETTE_TINT[proposal.companion.palette],
            )}
          >
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-(--squire-ring)" />
            {squireProposalPaletteLabel(proposal.companion.palette)}
          </span>
          <div className="pt-1">
            <Badge size="sm" variant="outline">
              {text.permissions}
            </Badge>
          </div>
        </div>
      </div>
      {text.brief === null ? null : (
        <p className="whitespace-pre-wrap text-sm text-foreground/90">{text.brief}</p>
      )}
    </div>
  );
}

/**
 * The proposed companion as a still bust: head, hood, shoulders, and held equipment, cropped
 * as the sidebar hover bust is. Still companions paint one frame and never take the live lease,
 * so a batch of cards costs no animation (spec P16.5).
 */
export function SquireProposalBust(props: {
  readonly companion: SquireProposalPayload["companion"];
  readonly label: string;
}) {
  const companion = squireProposalPortrait(props.companion);
  // The stage is 1122 x 1402: at 120 px wide the top 110 px runs from the hood to the held
  // equipment.
  return (
    <div
      data-testid="squire-proposal-bust"
      className="relative h-27.5 w-26 shrink-0 overflow-hidden rounded-md bg-muted/40"
    >
      <SquireCompanion
        companion={companion}
        state="attentive"
        placement="onboarding"
        label={props.label}
        className={
          companion.presence === "figure"
            ? "absolute -top-0.5 left-1/2 w-30 -translate-x-1/2"
            : "absolute inset-y-1.5 left-1/2 w-24 -translate-x-1/2"
        }
      />
    </div>
  );
}
