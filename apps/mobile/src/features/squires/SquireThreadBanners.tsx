import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import type {
  SquireEnvironmentState,
  SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireCardId, SquireId, SquireRuleOffer } from "@lecturn/contracts";
import { useNavigation } from "@react-navigation/native";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { uuidv4 } from "../../lib/uuid";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { squireEnvironment, useSquireSupported } from "../../state/squire";
import { useAtomCommand } from "../../state/use-atom-command";
import { useVisibleSecondClock } from "../threads/use-visible-second-clock";
import { squireUndoOffer } from "./squireApproval.logic";
import { SquireRuleOfferPrompt } from "./SquireRuleOffer";
import {
  squireComposerBannerState,
  squireHoldText,
  trackedThreadBanner,
  type SquireHoldBannerState,
} from "./squireThreadBanners.logic";
import { squiresWithThreadDecisions } from "./squireTracking.logic";

const NO_STATE_ATOM = Atom.make<SquireEnvironmentState | null>(null);

const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Lecturn: the Squire banners above a thread's composer. A home thread shows its Squire's held
 * actions and budget notice; an ordinary thread shows each tracking Squire's open decisions on
 * it. Probes, and environments without Squires, show nothing.
 */
export function SquireThreadBanners(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: EnvironmentThreadShell;
}) {
  const supported = useSquireSupported(props.environmentId);
  const state = useAtomValue(
    supported ? squireEnvironment.state(props.environmentId) : NO_STATE_ATOM,
  );
  if (state === null) return null;
  const marker = props.thread.squire;
  if (marker?.role === "home") {
    const entry = state.squires.find((candidate) => candidate.squire.id === marker.squireId);
    return entry === undefined ? null : (
      <SquireComposerBanners environmentId={props.environmentId} entry={entry} />
    );
  }
  const squires = squiresWithThreadDecisions(state, props.thread);
  if (squires.length === 0) return null;
  return (
    <View className="mx-4 mb-3 gap-2">
      {squires.map((squire) => (
        <TrackedThreadBanner
          key={squire.squireId}
          environmentId={props.environmentId}
          threadId={props.thread.id}
          squireId={squire.squireId}
          name={squire.name}
        />
      ))}
    </View>
  );
}

function TrackedThreadBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly squireId: SquireId;
  readonly name: string;
}) {
  const navigation = useNavigation();
  const items = useEnvironmentQuery(
    squireEnvironment.decisionItems({
      environmentId: props.environmentId,
      squireId: props.squireId,
    }),
  );
  const banner = trackedThreadBanner(items.data?.items ?? [], props.threadId, props.name);
  if (banner === null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={banner.text}
      accessibilityHint="Opens the Squire's chat"
      onPress={() =>
        navigation.navigate("Squire", {
          environmentId: props.environmentId,
          squireId: props.squireId,
        })
      }
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3 active:opacity-70"
    >
      <SymbolView name="questionmark.bubble" size={16} tintColorClassName="accent-icon-muted" />
      <AppText className="min-w-0 flex-1 text-sm font-lecturn-medium text-foreground">
        {banner.text}
      </AppText>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
    </Pressable>
  );
}

function SquireComposerBanners(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
}) {
  // Ticks only while something is held; an executed or undone hold leaves the snapshot.
  const now = useVisibleSecondClock(props.entry.held.length > 0);
  const state = squireComposerBannerState(props.entry, now, formatTime);
  // Held here, since the undone hold leaves the snapshot and takes its banner with it.
  const [undoOffer, setUndoOffer] = useState<{
    readonly cardId: SquireCardId;
    readonly offer: SquireRuleOffer;
  } | null>(null);
  if (state.kind === "none" && undoOffer === null) return null;
  const holds = state.kind === "none" ? [] : state.holds;
  const budget = state.kind === "none" ? null : state.budget;
  return (
    <View className="mx-4 mb-3 gap-2">
      {holds.map((hold) => (
        <SquireHoldBanner
          key={hold.cardId}
          environmentId={props.environmentId}
          hold={hold}
          onUndone={(offer) =>
            setUndoOffer(offer === undefined ? null : { cardId: hold.cardId, offer })
          }
        />
      ))}
      {undoOffer === null ? null : (
        <SquireRuleOfferPrompt
          key={undoOffer.cardId}
          environmentId={props.environmentId}
          card={{ id: undoOffer.cardId, squireId: props.entry.squire.id }}
          offer={undoOffer.offer}
          prompt={squireUndoOffer(undoOffer.offer)}
          onClose={() => setUndoOffer(null)}
        />
      )}
      {budget === null ? null : (
        <View
          accessible
          className="flex-row items-center gap-3 rounded-2xl border border-warning-border bg-warning px-3.5 py-3"
        >
          <SymbolView
            name="exclamationmark.circle"
            size={16}
            tintColorClassName="accent-warning-foreground"
          />
          <View className="min-w-0 flex-1">
            <AppText className="text-sm font-lecturn-medium text-warning-foreground">
              {budget.text}
            </AppText>
            {budget.detail === null ? null : (
              <AppText className="text-xs text-warning-foreground">{budget.detail}</AppText>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function SquireHoldBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly hold: SquireHoldBannerState;
  readonly onUndone: (offer: SquireRuleOffer | undefined) => void;
}) {
  const { environmentId, hold } = props;
  const target = useQuietThreadShell(
    hold.targetThreadId === null ? null : scopeThreadRef(environmentId, hold.targetThreadId),
  );
  const canUndo = useAtomValue(squireEnvironment.itemsAct.permissionAtom(environmentId));
  const act = useAtomCommand(squireEnvironment.itemsAct, "undo held Squire action");
  const [undoing, setUndoing] = useState(false);
  const undo = async () => {
    setUndoing(true);
    const result = await act({
      environmentId,
      input: { requestId: uuidv4(), cardIds: [hold.cardId], action: "undo" },
    });
    setUndoing(false);
    if (result._tag !== "Success") return;
    props.onUndone(result.value.results.find((r) => r.cardId === hold.cardId)?.ruleOffer);
  };
  const disabled = !canUndo || undoing || hold.seconds === 0;
  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-2.5">
      <SymbolView name="timer" size={16} tintColorClassName="accent-icon-muted" />
      <AppText className="min-w-0 flex-1 text-sm font-lecturn-medium text-foreground tabular-nums">
        {squireHoldText(hold.kind, target?.title ?? null, hold.seconds)}
      </AppText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Undo"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => void undo()}
        hitSlop={8}
        className="min-h-8 justify-center rounded-lg border border-border bg-subtle px-3 active:opacity-65"
        style={{ opacity: disabled ? 0.5 : 1 }}
      >
        <AppText className="text-xs font-lecturn-bold text-foreground">Undo</AppText>
      </Pressable>
    </View>
  );
}
