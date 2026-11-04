import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import { squirePairedHoldText } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireRuleOffer } from "@lecturn/contracts";
import { useState } from "react";
import { View } from "react-native";

import { GlassCard } from "../../components/GlassCard";
import { AppText as Text } from "../../components/ui/AppText";
import { useQuietThreadShell } from "../../state/entities";
import { RequestActionButton } from "../threads/RequestActionButton";
import { useVisibleSecondClock } from "../threads/use-visible-second-clock";
import { SquireRuleOfferPrompt } from "./SquireRuleOffer";
import {
  squireHoldSeconds,
  squireHoldText,
  squireUndoOffer,
  type SquireHeldRow,
} from "./squireQueue.logic";
import { useSquireItemsAct } from "./squireQueueState";

/** Held actions count down once a second while the screen is visible, with Undo. */
export function SquireHeldActions(props: {
  readonly environmentId: EnvironmentId;
  readonly held: ReadonlyArray<SquireHeldRow>;
}) {
  const now = useVisibleSecondClock(props.held.length > 0);
  // The rule offer after an Undo is held here, since the undone hold leaves the list once the snapshot catches up.
  const [undoOffer, setUndoOffer] = useState<{
    readonly hold: SquireHeldRow;
    readonly offer: SquireRuleOffer;
  } | null>(null);
  if (props.held.length === 0 && undoOffer === null) return null;
  return (
    <View className="gap-2">
      {props.held.map((hold) => (
        <SquireHeldRowView
          key={hold.cardId}
          environmentId={props.environmentId}
          hold={hold}
          seconds={squireHoldSeconds(hold.receivedAt, hold.executesInMs, now)}
          onUndone={(offer) => setUndoOffer(offer === undefined ? null : { hold, offer })}
        />
      ))}
      {undoOffer === null ? null : (
        <SquireRuleOfferPrompt
          key={undoOffer.hold.cardId}
          environmentId={props.environmentId}
          card={{ id: undoOffer.hold.cardId, squireId: undoOffer.hold.squireId }}
          offer={undoOffer.offer}
          prompt={squireUndoOffer(undoOffer.offer)}
          onClose={() => setUndoOffer(null)}
        />
      )}
    </View>
  );
}

function useSquireHoldUndo(
  environmentId: EnvironmentId,
  hold: SquireHeldRow,
  onUndone: (ruleOffer: SquireRuleOffer | undefined) => void,
) {
  const { canAct, run } = useSquireItemsAct(environmentId);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undo = async () => {
    setUndoing(true);
    setError(null);
    const outcome = await run([hold.cardId], "undo");
    setUndoing(false);
    if (outcome === null) return;
    if (outcome.ok) onUndone(outcome.ruleOffer);
    else setError(outcome.error);
  };
  return { canAct, undoing, error, undo: () => void undo() };
}

/**
 * The newer hold beside an open card, as one line under that card: "Newer steer held ·
 * sending in 52s" with Undo. It ticks once a second only while the screen is visible.
 */
export function SquirePairedHoldLine(props: {
  readonly environmentId: EnvironmentId;
  readonly hold: SquireHeldRow;
  readonly onUndone: (ruleOffer: SquireRuleOffer | undefined) => void;
}) {
  const { hold } = props;
  const now = useVisibleSecondClock(true);
  const seconds = squireHoldSeconds(hold.receivedAt, hold.executesInMs, now);
  const { canAct, undoing, error, undo } = useSquireHoldUndo(
    props.environmentId,
    hold,
    props.onUndone,
  );
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center gap-3">
        <Text
          className="flex-1 font-sans text-sm text-foreground-muted"
          style={{ fontVariant: ["tabular-nums"] }}
          numberOfLines={1}
        >
          {squirePairedHoldText(hold.kind, seconds)}
        </Text>
        <RequestActionButton
          label="Undo"
          tone="secondary"
          disabled={!canAct || undoing || seconds === 0}
          onPress={undo}
        />
      </View>
      {error === null ? null : (
        <Text accessibilityRole="alert" className="font-sans text-xs text-danger-foreground">
          {error}
        </Text>
      )}
    </View>
  );
}

function SquireHeldRowView(props: {
  readonly environmentId: EnvironmentId;
  readonly hold: SquireHeldRow;
  readonly seconds: number;
  readonly onUndone: (ruleOffer: SquireRuleOffer | undefined) => void;
}) {
  const { environmentId, hold } = props;
  const target = useQuietThreadShell(
    hold.targetThreadId === null ? null : scopeThreadRef(environmentId, hold.targetThreadId),
  );
  const { canAct, undoing, error, undo } = useSquireHoldUndo(environmentId, hold, props.onUndone);
  return (
    <GlassCard radius={20} className="gap-1.5 px-4 py-3">
      <View className="flex-row items-center gap-3">
        <Text
          className="flex-1 font-lecturn-medium text-sm text-foreground"
          style={{ fontVariant: ["tabular-nums"] }}
          numberOfLines={2}
        >
          {squireHoldText(hold.kind, target?.title ?? null, props.seconds)}
        </Text>
        <RequestActionButton
          label="Undo"
          tone="secondary"
          disabled={!canAct || undoing || props.seconds === 0}
          onPress={undo}
        />
      </View>
      {error === null ? null : (
        <Text accessibilityRole="alert" className="font-sans text-xs text-danger-foreground">
          {error}
        </Text>
      )}
    </GlassCard>
  );
}
