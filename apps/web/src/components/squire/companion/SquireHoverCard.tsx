import {
  squireFigureState,
  squireStateLine,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type { SquireIndicatorState } from "@lecturn/client-runtime/state/squireIndicator";
import { useEffect, useSyncExternalStore, type ReactElement } from "react";

import { useRelativeTimeState } from "../../../hooks/useRelativeTimeState";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../../ThreadHoverCard";
import { Tooltip, TooltipTrigger } from "../../ui/tooltip";
import { SquireCompanion } from "../SquireCompanion";
import { squireRecentFromSnapshot, squireRecentLabel } from "../squirePage.logic";

// One card at a time. The open card's key lives here, so opening a second card
// closes the first rather than leaving two live busts.
let openCard: string | null = null;
const openCardListeners = new Set<() => void>();

function setOpenCard(next: string | null) {
  if (openCard === next) return;
  openCard = next;
  for (const listener of openCardListeners) listener();
}

function subscribeOpenCard(listener: () => void) {
  openCardListeners.add(listener);
  return () => {
    openCardListeners.delete(listener);
  };
}

// Never on touch. Base UI's hover is mouse-only already; this also refuses pen.
let lastPointerType = "mouse";

/** "just now", "5m ago": re-renders only when the text changes. */
export function useActivityAge(at: string | null): string | null {
  const relative = useRelativeTimeState(at);
  if (relative.status !== "relative") return null;
  return relative.suffix === null ? relative.value : `${relative.value} ${relative.suffix}`;
}

/** Wraps a sidebar portrait; hovering it with a mouse opens the Squire's live bust. */
export function SquireHoverCard(props: {
  readonly cardKey: string;
  readonly entry: SquireSnapshotEntry;
  readonly indicator: SquireIndicatorState;
  readonly isLead: boolean;
  readonly children: ReactElement;
}) {
  const { cardKey } = props;
  const open = useSyncExternalStore(
    subscribeOpenCard,
    () => openCard === cardKey,
    () => false,
  );
  // A row unmounted mid-hover must not reopen its card when it mounts again.
  useEffect(
    () => () => {
      if (openCard === cardKey) setOpenCard(null);
    },
    [cardKey],
  );

  return (
    <Tooltip
      open={open}
      disableHoverablePopup
      onOpenChange={(next) => {
        if (next && lastPointerType === "mouse") setOpenCard(cardKey);
        else if (!next && openCard === cardKey) setOpenCard(null);
      }}
    >
      <TooltipTrigger
        delay={350}
        closeDelay={0}
        onPointerEnter={(event) => {
          lastPointerType = event.pointerType;
        }}
        render={<span className="inline-flex shrink-0" />}
      >
        {props.children}
      </TooltipTrigger>
      <ThreadHoverCardPopup side="right" align="start" sideOffset={8}>
        <SquireHoverCardBody
          entry={props.entry}
          indicator={props.indicator}
          isLead={props.isLead}
          live={open}
        />
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}

function SquireHoverCardBody(props: {
  readonly entry: SquireSnapshotEntry;
  readonly indicator: SquireIndicatorState;
  readonly isLead: boolean;
  /** False while the card fades out, so the bust (and its lease) goes the moment it closes. */
  readonly live: boolean;
}) {
  const { entry, indicator, isLead, live } = props;
  const { squire } = entry;
  const stateLine = squireStateLine({
    squire,
    indicator,
    openDecisionCount: entry.openDecisionCount,
    heldCount: entry.held.length,
  });
  const last = squireRecentFromSnapshot(entry.recentActivity, 1)[0] ?? null;
  const age = useActivityAge(last?.at ?? null);
  const figure = squire.companion.presence === "figure";

  return (
    <ThreadHoverCard title={squire.name}>
      {/* The stage is 1122 x 1402: at 262 px wide the top 180 px is head, shoulders, and chest. */}
      <div
        data-testid="squire-hover-bust"
        className="relative h-45 w-55 overflow-hidden rounded-md bg-muted/40"
      >
        {live ? (
          <SquireCompanion
            companion={squire.companion}
            state={squireFigureState(indicator.state)}
            placement="hover"
            crest={isLead}
            label={`${squire.name}: ${stateLine}`}
            facesContent
            className={
              figure
                ? "absolute -top-1.5 left-1/2 w-[262px] -translate-x-1/2"
                : "absolute inset-y-2.5 left-1/2 w-40 -translate-x-1/2"
            }
          />
        ) : null}
      </div>
      <span className="text-foreground/80">{stateLine}</span>
      {last === null ? null : (
        <span>
          {squireRecentLabel(last, { threadTitle: null, cardTitle: null })}
          {age === null ? null : ` · ${age}`}
        </span>
      )}
    </ThreadHoverCard>
  );
}
