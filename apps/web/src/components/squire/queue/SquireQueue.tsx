import {
  type SquireQueueChip,
  type SquireSnapshotEntry,
  squireSupersededNote,
} from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  SquireCardId,
  SquireCardRow,
  SquireId,
  SquireRuleOffer,
} from "@lecturn/contracts";
import { useState, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { useEnvironmentQuery } from "../../../state/query";
import { squireEnvironment, useSquireEnvironmentState } from "../../../state/squires";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { useSquireLeadOnboardingCardIds } from "../lead/SquireLeadOnboarding";
import { SquireEvidenceBody, SquireEvidenceCard } from "./SquireEvidenceCard";
import {
  squireAcceptOffer,
  squireActedLabel,
  squireHoldPairing,
  squireQueueEmptyText,
  squireQueueView,
  squireReceiptRows,
  squireUndoOffer,
  SQUIRE_KIND_LABEL,
} from "./squireQueue.logic";
import {
  usePublishSquireShownHolds,
  useSquireItemsAct,
  useSquireMarkOpened,
  useSquireQueuePages,
} from "./squireQueueState";
import { SquireRowHoldLine } from "./SquireHoldControls";
import {
  SquireDecisionRow,
  SquireFyiRow,
  SquireKindDot,
  SquireSettledRow,
  type SquireRowCallbacks,
} from "./SquireQueueRow";
import { SquireRuleOfferPrompt } from "./SquireRuleOffer";

export interface SquireQueueProps {
  readonly environmentId: EnvironmentId;
  /** The viewed Squire; the Lead's id lists its combined queue. */
  readonly entry: SquireSnapshotEntry;
  readonly isLead: boolean;
  /** The Lead view's team-strip filter. */
  readonly teamFilter: SquireId | null;
  readonly chip: SquireQueueChip;
  readonly onChipChange: (chip: SquireQueueChip) => void;
  /** The expanded (list) or selected (inbox) item, from the route's `item` param. */
  readonly selectedItemId: SquireCardId | null;
  readonly onSelectItem: (cardId: SquireCardId | null) => void;
  /** The page offers the inbox layout only at widths where it fits (D38). */
  readonly layout: "list" | "inbox";
}

export function SquireQueue(props: SquireQueueProps) {
  const { environmentId, entry, isLead, layout, selectedItemId, onSelectItem } = props;
  const squireId = entry.squire.id;
  const [pageCount, setPageCount] = useState(1);
  const [busyIds, setBusyIds] = useState<ReadonlyArray<SquireCardId>>([]);
  // The user's own acts, kept out of the open groups until the refetched rows agree.
  const [acted, setActed] = useState<ReadonlyMap<SquireCardId, string>>(new Map());
  const markActed = (row: SquireCardRow, action: "accept" | "dismiss") => {
    setActed((current) => new Map(current).set(row.id, squireActedLabel(row, action)));
  };
  // After an accept, or after an Undo on a held row (whose hold has left the snapshot by then).
  const [offer, setOffer] = useState<{
    readonly card: SquireCardRow;
    readonly offer: SquireRuleOffer;
    readonly after: "accept" | "undo";
  } | null>(null);
  const pages = useSquireQueuePages(environmentId, squireId, pageCount);
  const state = useSquireEnvironmentState(environmentId);
  const { canAct, run } = useSquireItemsAct(environmentId);
  // Shares the expanded card's query, so a card that left the open scope stays on screen.
  const selectedDetail = useEnvironmentQuery(
    selectedItemId === null
      ? null
      : squireEnvironment.item({ environmentId, input: { squireId, cardId: selectedItemId } }),
  );
  // The detail is the fresher word on the selected card: it carries the resolution.
  const selectedDetailCard =
    selectedDetail.data?.card.id === selectedItemId ? selectedDetail.data.card : null;
  const selectedRow =
    selectedDetailCard ?? pages.rows.find((row) => row.id === selectedItemId) ?? null;
  useSquireMarkOpened(environmentId, selectedItemId, selectedRow?.openedAt);

  // The onboarding panel shows the Lead's Squire proposals as cards: the chips still count them,
  // and the groups leave them out.
  const onboardingIds = useSquireLeadOnboardingCardIds(environmentId, isLead ? squireId : null);
  const view = squireQueueView(pages.rows, {
    chip: props.chip,
    teamFilter: isLead ? props.teamFilter : null,
    selected: selectedRow,
    hasMore: pages.nextBefore !== null,
    acted,
    shownAbove: onboardingIds,
  });
  const squires = state?.squires ?? [];
  const entryOf = (id: SquireId) => squires.find((candidate) => candidate.squire.id === id) ?? null;
  const squireName = (id: SquireId) => entryOf(id)?.squire.name ?? "A Squire";
  // The Lead's combined queue shows its team's holds too, each in its own Squire's snapshot.
  const holdOf = (cardId: SquireCardId) => {
    for (const candidate of [entry, ...squires]) {
      const hold = candidate.held.find((held) => held.cardId === cardId);
      if (hold !== undefined) return { hold, receivedAt: candidate.receivedAt };
    }
    return null;
  };
  const heldShown = (view.held?.items ?? []).filter((row) => holdOf(row.id) !== null);
  // P7.6: a hold beside an open card of its kind shows under that card, not as a second row.
  // A selected hold keeps its own row so it stays the one highlighted.
  const holdPairing = squireHoldPairing(heldShown, view.decision?.items ?? [], (cardId) =>
    cardId === selectedItemId ? undefined : holdOf(cardId)?.hold.heldOverCardId,
  );
  const pairedIds = new Set([...holdPairing.byOpen.values()].map((row) => row.id));
  const loneHeld = (view.held?.items ?? []).filter((row) => !pairedIds.has(row.id));
  usePublishSquireShownHolds(
    environmentId,
    squireId,
    pages.loaded ? heldShown.map((row) => row.id) : null,
  );

  const act = async (row: SquireCardRow, action: "accept" | "dismiss") => {
    setBusyIds((ids) => [...ids, row.id]);
    const result = await run([row.id], action);
    setBusyIds((ids) => ids.filter((id) => id !== row.id));
    const outcome =
      result._tag === "Success"
        ? result.value.results.find((candidate) => candidate.cardId === row.id)
        : undefined;
    if (result._tag === "Failure" || outcome?.error) {
      toastManager.add({
        type: "error",
        title: outcome?.error?.message ?? "The item could not be updated. Try again.",
      });
      return;
    }
    markActed(row, action);
    if (action === "accept" && outcome?.ruleOffer !== undefined) {
      setOffer({ card: row, offer: outcome.ruleOffer, after: "accept" });
    }
  };

  const callbacks: SquireRowCallbacks = {
    onToggle: (row) => {
      if (row.kind === "fyi") return;
      onSelectItem(layout === "list" && selectedItemId === row.id ? null : row.id);
    },
    onAccept: (row) => void act(row, "accept"),
    onDismiss: (row) => void act(row, "dismiss"),
    // P3.6: the inactivity check's accept keeps triggers running and its dismiss pauses them.
    onInactivity: (row, keep) => void act(row, keep ? "accept" : "dismiss"),
  };
  const onActed = (
    card: SquireCardRow,
    action: "accept" | "dismiss",
    ruleOffer: SquireRuleOffer | undefined,
  ) => {
    markActed(card, action);
    if (action === "accept") {
      setOffer(ruleOffer === undefined ? null : { card, offer: ruleOffer, after: "accept" });
    }
  };

  const selectedDecision =
    selectedRow !== null && selectedRow.kind !== "fyi" && view.confirmation === null
      ? selectedRow
      : null;
  const evidenceProps = (row: SquireCardRow) => ({
    environmentId,
    squireId,
    row,
    raiser: entryOf(row.squireId),
    squireName,
    onActed,
  });

  // Inset with the row padding so row text, the expanded card, and the inbox pane line up with
  // the header's px-6, and an expanded card never runs to the pane's edge.
  const list = (
    <div className={cn("flex min-w-0 flex-col gap-3", layout === "list" && "px-4")}>
      {/* One row at every width with every chip in full; what does not fit scrolls. */}
      {view.onlyAbove ? null : (
        <div
          role="toolbar"
          aria-label="Filter by type"
          className="flex gap-1 overflow-x-auto [scrollbar-width:none] *:shrink-0 [&::-webkit-scrollbar]:hidden"
        >
          {view.chips.map((chip) => (
            <Button
              key={chip.chip}
              size="xs"
              variant={props.chip === chip.chip ? "secondary" : "ghost"}
              aria-pressed={props.chip === chip.chip}
              onClick={() => props.onChipChange(chip.chip)}
            >
              {chip.chip === "all" ? null : <SquireKindDot kind={chip.chip} />}
              {chip.label}
              <span className="tabular-nums text-muted-foreground">{chip.countLabel}</span>
            </Button>
          ))}
        </div>
      )}
      {offer === null ? null : (
        <SquireRuleOfferPrompt
          environmentId={environmentId}
          card={offer.card}
          offer={offer.offer}
          prompt={
            offer.after === "accept"
              ? squireAcceptOffer(offer.card, offer.offer)
              : squireUndoOffer(offer.offer)
          }
          onClose={() => setOffer(null)}
        />
      )}
      {isLead ? (
        <SquireRoutedGroup
          environmentId={environmentId}
          squireName={squireName}
          onSelectItem={onSelectItem}
        />
      ) : null}
      {view.confirmation === null ? null : (
        <SquireSettledRow
          environmentId={environmentId}
          viewSquireId={squireId}
          row={view.confirmation.row}
          label={view.confirmation.label}
          layout={layout}
          onClose={() => onSelectItem(null)}
        />
      )}
      {view.held === null || loneHeld.length === 0 ? null : (
        <QueueGroup label={view.held.label} count={loneHeld.length}>
          {loneHeld.map((row) => {
            const held = holdOf(row.id);
            return (
              <SquireDecisionRow
                key={row.id}
                environmentId={environmentId}
                viewSquireId={squireId}
                row={row}
                raiser={isLead ? entryOf(row.squireId) : null}
                layout={layout}
                expanded={selectedItemId === row.id}
                canAct={canAct}
                busy={busyIds.includes(row.id)}
                callbacks={callbacks}
                holdLine={
                  held === null ? null : (
                    <SquireRowHoldLine
                      environmentId={environmentId}
                      hold={held.hold}
                      squireId={squireId}
                      receivedAt={held.receivedAt}
                      onUndone={(ruleOffer) =>
                        setOffer({ card: row, offer: ruleOffer, after: "undo" })
                      }
                    />
                  )
                }
                body={
                  layout === "list" && selectedItemId === row.id ? (
                    <SquireEvidenceBody {...evidenceProps(row)} inInbox={false} />
                  ) : null
                }
              />
            );
          })}
        </QueueGroup>
      )}
      {view.decision === null ? null : (
        <QueueGroup label={view.decision.label} count={view.decision.items.length}>
          {view.decision.items.map((row) => {
            const newer = holdPairing.byOpen.get(row.id);
            const newerHold = newer === undefined ? null : holdOf(newer.id);
            return (
              <SquireDecisionRow
                key={row.id}
                environmentId={environmentId}
                viewSquireId={squireId}
                row={row}
                raiser={isLead ? entryOf(row.squireId) : null}
                layout={layout}
                expanded={selectedItemId === row.id}
                canAct={canAct}
                busy={busyIds.includes(row.id)}
                callbacks={callbacks}
                {...(newer === undefined || newerHold === null
                  ? {}
                  : {
                      supersededNote: squireSupersededNote(row.kind),
                      holdLine: (
                        <SquireRowHoldLine
                          environmentId={environmentId}
                          hold={newerHold.hold}
                          squireId={squireId}
                          receivedAt={newerHold.receivedAt}
                          paired
                          onUndone={(ruleOffer) =>
                            setOffer({ card: newer, offer: ruleOffer, after: "undo" })
                          }
                        />
                      ),
                    })}
                body={
                  layout === "list" && selectedItemId === row.id ? (
                    <SquireEvidenceBody {...evidenceProps(row)} inInbox={false} />
                  ) : null
                }
              />
            );
          })}
        </QueueGroup>
      )}
      {view.fyi === null ? null : (
        <QueueGroup label={view.fyi.label}>
          {view.fyi.items.map((row) => (
            <SquireFyiRow
              key={row.id}
              environmentId={environmentId}
              viewSquireId={squireId}
              row={row}
              raiser={isLead ? entryOf(row.squireId) : null}
              layout={layout}
              canAct={canAct}
              busy={busyIds.includes(row.id)}
              callbacks={callbacks}
            />
          ))}
        </QueueGroup>
      )}
      {pages.nextBefore === null ? null : (
        <div className="px-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={pages.pending}
            onClick={() => setPageCount((count) => count + 1)}
          >
            {pages.pending ? "Loading…" : "Show older items"}
          </Button>
        </div>
      )}
      {pages.error === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {pages.error}
        </p>
      )}
      {pages.loaded &&
      !view.onlyAbove &&
      view.held === null &&
      view.decision === null &&
      view.fyi === null ? (
        <p
          className={cn(
            "px-2 text-sm text-muted-foreground",
            view.aboveCount > 0 ? "py-1" : "py-6 text-center",
          )}
        >
          {squireQueueEmptyText(props.chip, view.aboveCount)}
        </p>
      ) : null}
    </div>
  );

  if (layout === "list") return list;
  return (
    // 45/55: the list keeps room for a readable title beside its fixed trail, with a floor for
    // narrow windows; the detail flexes.
    <div className="grid min-w-0 grid-cols-[minmax(26rem,45fr)_minmax(0,55fr)] items-start gap-4 px-4">
      {list}
      <div className="sticky top-0 min-w-0">
        {selectedDecision === null ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
            Select an item to see its evidence.
          </p>
        ) : (
          <SquireEvidenceCard key={selectedDecision.id} {...evidenceProps(selectedDecision)} />
        )}
      </div>
    </div>
  );
}

function QueueGroup(props: {
  readonly label: string;
  /** Held and decision groups only, so each count reads against the header's. */
  readonly count?: number;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={props.label} className="flex flex-col gap-0.5">
      <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
        {props.label}
        {props.count === undefined ? null : (
          <span className="ml-1.5 tabular-nums">{props.count}</span>
        )}
      </h3>
      <div role="list" className="flex flex-col gap-0.5">
        {props.children}
      </div>
    </section>
  );
}

const ROUTED_SHOWN = 5;

/** D65: the Lead's routing receipts, updated in place as the routed turns and items move. */
function SquireRoutedGroup(props: {
  readonly environmentId: EnvironmentId;
  readonly squireName: (squireId: SquireId) => string;
  readonly onSelectItem: (cardId: SquireCardId) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const receipts = useEnvironmentQuery(
    squireEnvironment.leadReceipts({ environmentId: props.environmentId, input: {} }),
  );
  const rows = squireReceiptRows(receipts.data?.receipts ?? [], props.squireName);
  if (rows.length === 0) return null;
  const shown = showAll ? rows : rows.slice(0, ROUTED_SHOWN);
  return (
    <QueueGroup label="Routed">
      {shown.map((receipt) => (
        <div
          key={receipt.taskId}
          role="listitem"
          className={cn(
            "flex min-h-8 flex-wrap items-center gap-x-2 rounded-md px-2 text-sm",
            receipt.settled ? "text-muted-foreground" : "text-foreground/90",
          )}
        >
          <span className="min-w-0 flex-1 truncate">{receipt.text}</span>
          {receipt.items.map((item) => (
            <Button
              key={item.cardId}
              size="xs"
              variant="ghost"
              onClick={() => props.onSelectItem(item.cardId)}
            >
              <SquireKindDot kind={item.kind} />
              {SQUIRE_KIND_LABEL[item.kind]}
              <span className="text-muted-foreground">{item.status}</span>
            </Button>
          ))}
        </div>
      ))}
      {rows.length > ROUTED_SHOWN ? (
        <div className="px-2">
          <Button size="xs" variant="ghost" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer" : `Show ${rows.length - ROUTED_SHOWN} more`}
          </Button>
        </div>
      ) : null}
    </QueueGroup>
  );
}
