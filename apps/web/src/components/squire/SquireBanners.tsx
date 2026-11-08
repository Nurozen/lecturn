import { squireUndoOffer, type SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireCardId, SquireRuleOffer } from "@lecturn/contracts";
import { GaugeIcon, TimerIcon } from "lucide-react";
import { memo, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { formatShortTimestamp } from "../../timestampFormat";
import { ComposerBanner } from "../chat/ComposerBanner";
import { Button } from "../ui/button";
import { SquireHoldRuleBadge, useSquireHoldUndo } from "./chat/SquireHoldControls";
import { SquireRuleOfferPrompt } from "./chat/SquireRuleOffer";
import { squireBudgetBanner } from "./squirePage.logic";

/** Holds, with their countdown and Undo, and the budget notice, above the chat. */
export const SquireBanners = memo(function SquireBanners(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
}) {
  const { environmentId, entry } = props;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const budget = squireBudgetBanner(entry, (iso) => formatShortTimestamp(iso, timestampFormat));
  const held = entry.held;
  // Kept here because the undone hold, and its banner, leave the snapshot at once.
  const [undoOffer, setUndoOffer] = useState<{
    readonly cardId: SquireCardId;
    readonly offer: SquireRuleOffer;
  } | null>(null);
  if (held.length === 0 && budget === null && undoOffer === null) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1 px-4 pb-2">
      {held.map((hold) => (
        <SquireHoldBanner
          key={hold.cardId}
          environmentId={environmentId}
          hold={hold}
          squireId={entry.squire.id}
          receivedAt={entry.receivedAt}
          onUndone={(offer) => setUndoOffer({ cardId: hold.cardId, offer })}
        />
      ))}
      {undoOffer === null ? null : (
        <SquireRuleOfferPrompt
          environmentId={environmentId}
          card={{ id: undoOffer.cardId, squireId: entry.squire.id }}
          offer={undoOffer.offer}
          prompt={squireUndoOffer(undoOffer.offer)}
          onClose={() => setUndoOffer(null)}
        />
      )}
      {budget === null ? null : (
        <ComposerBanner.Root placement="floating" variant="warning" density="comfortable">
          <ComposerBanner.Row>
            <ComposerBanner.Icon>
              <GaugeIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              <span className="truncate">{budget.text}</span>
              {budget.detail === null ? null : (
                <>
                  <ComposerBanner.Separator />
                  <span className="truncate text-muted-foreground">{budget.detail}</span>
                </>
              )}
            </ComposerBanner.Content>
          </ComposerBanner.Row>
        </ComposerBanner.Root>
      )}
    </div>
  );
});

function SquireHoldBanner(props: Parameters<typeof useSquireHoldUndo>[0]) {
  const hold = useSquireHoldUndo(props);
  return (
    <ComposerBanner.Root placement="floating" density="comfortable">
      <ComposerBanner.Row>
        <ComposerBanner.Icon>
          <TimerIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content>
          <span className="truncate tabular-nums">{hold.text}</span>
          <SquireHoldRuleBadge label={hold.ruleLabel} />
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <Button size="xs" variant="outline" disabled={hold.undoDisabled} onClick={hold.undo}>
            Undo
          </Button>
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
}
