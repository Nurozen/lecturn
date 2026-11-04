import { scopeProjectRef, scopeThreadRef } from "@lecturn/client-runtime/environment";
import { type SquireQueueChip, squireSupersededNote } from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  SquireCardId,
  SquireCardRow,
  SquireId,
  SquireRuleOffer,
} from "@lecturn/contracts";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { GlassCard } from "../../components/GlassCard";
import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { squireEnvironment } from "../../state/squire";
import { RequestActionButton } from "../threads/RequestActionButton";
import { SquireHeldActions, SquirePairedHoldLine } from "./SquireHeldActions";
import { useSquireAgeClock, useSquireProviderNames } from "./SquireEvidence";
import {
  squireRowAgeText,
  squireRowMetaText,
  squireRowProviderName,
  squireRowTargetName,
} from "./squireEvidence.logic";
import { SquireItemCard, type SquireActedHandler } from "./SquireItemCard";
import { SquireRuleOfferPrompt } from "./SquireRuleOffer";
import {
  SQUIRE_KIND_LABEL,
  squireAcceptOffer,
  squireActedLabel,
  squireHoldPairing,
  squireQueueView,
  squireRowAction,
  squireRowTitle,
  squireUndoOffer,
  type SquireHeldRow,
} from "./squireQueue.logic";
import { useSquireItemsAct, useSquireQueuePages } from "./squireQueueState";

export function SquireQueue(props: {
  readonly environmentId: EnvironmentId;
  /** The viewed Squire; the Lead's id lists its combined queue. */
  readonly squireId: SquireId;
  readonly teamFilter: SquireId | null;
  /** The route's `item`: expanded on arrival. */
  readonly initialItemId: SquireCardId | null;
  /** Raiser names on the Lead's combined queue; null elsewhere. */
  readonly raiserName: ((squireId: SquireId) => string) | null;
  /** The view's holds: each shows under its open card, or as a banner above the queue. */
  readonly held: ReadonlyArray<SquireHeldRow>;
}) {
  const { environmentId } = props;
  const [chip, setChip] = useState<SquireQueueChip>("all");
  const [pageCount, setPageCount] = useState(1);
  const [expandedId, setExpandedId] = useState<SquireCardId | null>(props.initialItemId);
  // The user's own acts, kept out of the open groups until the refetched rows agree.
  const [acted, setActed] = useState<ReadonlyMap<SquireCardId, string>>(new Map());
  // Kept apart from the confirmations, so the offer outlasts the row leaving the queue.
  const [offer, setOffer] = useState<{
    readonly card: Pick<SquireCardRow, "id" | "squireId" | "kind" | "origin" | "steerKind">;
    readonly offer: SquireRuleOffer;
    readonly after: "accept" | "undo";
  } | null>(null);
  const pages = useSquireQueuePages(environmentId, props.squireId, pageCount);
  const now = useSquireAgeClock();
  // A linked card off the loaded pages (older, or already settled) is read on its own.
  const linkedId =
    expandedId !== null && pages.loaded && !pages.rows.some((row) => row.id === expandedId)
      ? expandedId
      : null;
  const linked = useEnvironmentQuery(
    linkedId === null
      ? null
      : squireEnvironment.item({
          environmentId,
          input: { squireId: props.squireId, cardId: linkedId },
        }),
  );
  const view = squireQueueView(pages.rows, {
    chip,
    teamFilter: props.teamFilter,
    selected: linked.data?.card.id === linkedId ? (linked.data?.card ?? null) : null,
    hasMore: pages.nextBefore !== null,
    acted,
  });
  const onActed: SquireActedHandler = (row, action, ruleOffer) => {
    setActed((current) => new Map(current).set(row.id, squireActedLabel(row, action)));
    setExpandedId((current) => (current === row.id ? null : current));
    if (action === "accept") {
      setOffer(ruleOffer === undefined ? null : { card: row, offer: ruleOffer, after: "accept" });
    }
  };
  const rowProps = (row: SquireCardRow) => ({
    environmentId,
    row,
    raiserName: props.raiserName?.(row.squireId) ?? null,
    expanded: expandedId === row.id,
    now,
    onToggle: () => setExpandedId(expandedId === row.id ? null : row.id),
    onActed,
  });

  // A hold beside a listed open card of its kind shows under that card as one block; the
  // held card's own row and banner would repeat its title.
  const pairing = squireHoldPairing(view.decision?.items ?? [], props.held);
  const decisions = pairing.rows;

  return (
    <View className="gap-4">
      <SquireHeldActions environmentId={environmentId} held={pairing.lone} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8 }}
        accessibilityLabel="Filter by type"
      >
        {view.chips.map((entry) => (
          <Chip
            key={entry.chip}
            label={`${entry.label} ${entry.countLabel}`}
            selected={chip === entry.chip}
            onPress={() => setChip(entry.chip)}
          />
        ))}
      </ScrollView>
      {view.confirmations.map(({ row, label }) => (
        <View key={row.id} className="flex-row items-center gap-2 px-1">
          <SymbolView name="checkmark" size={13} tintColorClassName="accent-icon-muted" />
          <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={1}>
            {label} · {row.title}
          </Text>
        </View>
      ))}
      {offer === null ? null : (
        <SquireRuleOfferPrompt
          key={offer.card.id}
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
      {decisions.length === 0 || view.decision === null ? null : (
        <QueueGroup label={view.decision.label}>
          {decisions.map((row) => {
            const newer = pairing.byOpen.get(row.id);
            return (
              <SquireQueueRow
                key={row.id}
                {...rowProps(row)}
                newerHold={
                  newer === undefined ? null : (
                    <SquirePairedHoldLine
                      environmentId={environmentId}
                      hold={newer}
                      onUndone={(ruleOffer) =>
                        setOffer(
                          ruleOffer === undefined
                            ? null
                            : {
                                card: { ...row, id: newer.cardId, squireId: newer.squireId },
                                offer: ruleOffer,
                                after: "undo",
                              },
                        )
                      }
                    />
                  )
                }
              />
            );
          })}
        </QueueGroup>
      )}
      {view.fyi === null ? null : (
        <QueueGroup label={view.fyi.label}>
          {view.fyi.items.map((row) => (
            <SquireQueueRow key={row.id} {...rowProps(row)} />
          ))}
        </QueueGroup>
      )}
      {pages.error === null ? null : (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {pages.error}
        </Text>
      )}
      {!pages.loaded && pages.error === null ? (
        <Text className="font-sans text-sm text-foreground-muted">Loading…</Text>
      ) : null}
      {pages.loaded && decisions.length === 0 && view.fyi === null ? (
        <Text className="py-6 text-center font-sans text-sm text-foreground-muted">
          {chip === "all"
            ? "Nothing is waiting on you."
            : `No open ${SQUIRE_KIND_LABEL[chip].toLowerCase()} items.`}
        </Text>
      ) : null}
      {pages.nextBefore === null ? null : (
        <RequestActionButton
          label={pages.pending ? "Loading…" : "Show older items"}
          tone="secondary"
          disabled={pages.pending}
          onPress={() => setPageCount((count) => count + 1)}
        />
      )}
    </View>
  );
}

function QueueGroup(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="gap-2" accessibilityLabel={props.label}>
      <Text
        accessibilityRole="header"
        className="px-1 font-lecturn-bold text-2xs uppercase tracking-[1.1px] text-foreground-muted"
      >
        {props.label}
      </Text>
      {props.children}
    </View>
  );
}

function SquireQueueRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: SquireCardRow;
  readonly raiserName: string | null;
  readonly expanded: boolean;
  /** The queue's age clock. */
  readonly now: number;
  readonly onToggle: () => void;
  readonly onActed: SquireActedHandler;
  /** The newer hold of this card's kind, shown under it; it replaces the card when it runs. */
  readonly newerHold?: ReactNode;
}) {
  const { environmentId, row } = props;
  const superseded = props.newerHold !== undefined && props.newerHold !== null;
  const target = useSquireRowTarget(environmentId, row);
  const age = squireRowAgeText(row, props.expanded, props.now);
  const { canAct, run } = useSquireItemsAct(environmentId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inline = props.expanded || !canAct ? null : squireRowAction(row);
  const act = async (action: "accept" | "dismiss") => {
    setBusy(true);
    setError(null);
    const outcome = await run([row.id], action);
    setBusy(false);
    if (outcome === null) return;
    if (outcome.ok) props.onActed(row, action, outcome.ruleOffer);
    else setError(outcome.error);
  };
  const meta = squireRowMetaText({
    kind: SQUIRE_KIND_LABEL[row.kind],
    title: row.title,
    raiser: props.raiserName,
    ...target,
  });

  return (
    <GlassCard radius={20} className="gap-3 px-4 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel={`${SQUIRE_KIND_LABEL[row.kind]}: ${row.title}`}
        onPress={props.onToggle}
        className="gap-1 active:opacity-70"
      >
        <View className="flex-row items-baseline gap-2">
          <Text className="flex-1 font-sans text-xs text-foreground-muted" numberOfLines={1}>
            {meta}
          </Text>
          {age === "" ? null : (
            <Text className="shrink-0 font-sans text-xs tabular-nums text-foreground-muted">
              {age}
            </Text>
          )}
        </View>
        <Text
          className="font-lecturn-bold text-base text-foreground"
          numberOfLines={props.expanded ? undefined : 2}
        >
          {squireRowTitle(row)}
        </Text>
        {row.status === "held" ? (
          <Text className="font-sans text-xs text-foreground-muted">Held</Text>
        ) : row.status === "accepting" || row.status === "executing" ? (
          <Text className="font-sans text-xs text-foreground-muted">Sending…</Text>
        ) : superseded ? (
          <Text className="font-sans text-xs text-warning-foreground">
            {squireSupersededNote(row.kind)}
          </Text>
        ) : null}
      </Pressable>
      {props.newerHold}
      {inline === null ? null : (
        <View className="flex-row flex-wrap gap-2">
          {inline.type === "accept" ? (
            <RequestActionButton
              label={inline.label}
              disabled={busy}
              onPress={() => void act("accept")}
            />
          ) : inline.type === "expand" ? (
            <RequestActionButton label={inline.label} tone="secondary" onPress={props.onToggle} />
          ) : inline.type === "dismiss" ? (
            <RequestActionButton
              label={inline.label}
              tone="secondary"
              disabled={busy}
              onPress={() => void act("dismiss")}
            />
          ) : (
            <>
              <RequestActionButton
                label="Keep"
                disabled={busy}
                onPress={() => void act("accept")}
              />
              <RequestActionButton
                label="Pause"
                tone="secondary"
                disabled={busy}
                onPress={() => void act("dismiss")}
              />
            </>
          )}
        </View>
      )}
      {error === null ? null : (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      )}
      {props.expanded ? (
        <SquireItemCard
          environmentId={environmentId}
          row={row}
          onActed={props.onActed}
          now={props.now}
        />
      ) : null}
    </GlassCard>
  );
}

/** What a row points at and who runs it: its thread, or a proposal's project and provider. */
function useSquireRowTarget(environmentId: EnvironmentId, row: SquireCardRow) {
  const shell = useQuietThreadShell(
    row.targetThreadId === null ? null : scopeThreadRef(environmentId, row.targetThreadId),
  );
  const project = useProject(
    row.targetThreadId === null && row.projectId !== null
      ? scopeProjectRef(environmentId, row.projectId)
      : null,
  );
  const names = useSquireProviderNames(environmentId);
  const instanceId = shell?.providerInstanceId ?? null;
  return {
    name: squireRowTargetName(row, {
      threadTitle: shell?.title ?? null,
      projectTitle: project?.title ?? null,
    }),
    provider: squireRowProviderName(
      row,
      instanceId === null ? null : names.instanceName(instanceId),
      names,
    ),
  };
}
