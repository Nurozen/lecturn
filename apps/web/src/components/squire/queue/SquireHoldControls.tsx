import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import {
  squirePairedHoldText,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireId, SquireRuleOffer } from "@lecturn/contracts";
import { useState, useSyncExternalStore } from "react";

import { randomUUID } from "../../../lib/utils";
import { useProjects, useQuietThreadShell } from "../../../state/entities";
import { useEnvironmentQuery } from "../../../state/query";
import { squireEnvironment, useSquireEnvironmentState } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { squireHoldCountdown, squireHoldRuleLabel, squireHoldText } from "../squirePage.logic";

export type SquireHold = SquireSnapshotEntry["held"][number];

/**
 * The seconds left, re-rendering only when the number changes and never after the hold runs
 * out, so a hold costs one text update a second and nothing once it ends.
 */
function useHoldSeconds(receivedAt: number, executesInMs: number): number {
  const subscribe = (onChange: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const { nextChangeInMs } = squireHoldCountdown(receivedAt, executesInMs, Date.now());
      if (nextChangeInMs === null) return;
      timer = setTimeout(() => {
        onChange();
        schedule();
      }, nextChangeInMs);
    };
    schedule();
    return () => clearTimeout(timer);
  };
  const getSnapshot = () => squireHoldCountdown(receivedAt, executesInMs, Date.now()).seconds;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * One hold's countdown text, its "Auto by rule" label, and Undo. Mounted only while the
 * snapshot carries the hold, so the 1 Hz text stops with it.
 */
export function useSquireHoldUndo(input: {
  readonly environmentId: EnvironmentId;
  readonly hold: SquireHold;
  /** The Squire whose view shows the hold; its revision refreshes the card. */
  readonly squireId: SquireId;
  readonly receivedAt: number;
  readonly onUndone: (offer: SquireRuleOffer) => void;
  /** Shown under the open card it sits beside, so it names itself as the newer one. */
  readonly paired?: boolean;
}) {
  const { environmentId, hold } = input;
  const seconds = useHoldSeconds(input.receivedAt, hold.executesInMs);
  const target = useQuietThreadShell(
    hold.targetThreadId === null ? null : scopeThreadRef(environmentId, hold.targetThreadId),
  );
  const ruleLabel = useSquireHoldRuleLabel(
    environmentId,
    input.squireId,
    hold,
    target?.title ?? null,
  );
  const canUndo = useAtomValue(squireEnvironment.itemsAct.permissionAtom(environmentId));
  const act = useAtomCommand(squireEnvironment.itemsAct);
  const [undoing, setUndoing] = useState(false);
  const undo = async () => {
    setUndoing(true);
    const result = await act({
      environmentId,
      input: { requestId: randomUUID(), cardIds: [hold.cardId], action: "undo" },
    });
    setUndoing(false);
    const offer = result._tag === "Success" ? result.value.results[0]?.ruleOffer : undefined;
    if (offer !== undefined) input.onUndone(offer);
  };
  return {
    text: input.paired
      ? squirePairedHoldText(hold.kind, seconds)
      : squireHoldText(hold.kind, target?.title ?? null, seconds),
    ruleLabel,
    undoDisabled: !canUndo || undoing || seconds === 0,
    undo: () => void undo(),
  };
}

export function SquireHoldRuleBadge(props: { readonly label: string | null }) {
  if (props.label === null) return null;
  return (
    <Badge size="sm" variant="secondary" className="shrink-0">
      {props.label}
    </Badge>
  );
}

/** The hold's line right under its queue row: countdown, rule, Undo. */
export function SquireRowHoldLine(props: Parameters<typeof useSquireHoldUndo>[0]) {
  const hold = useSquireHoldUndo(props);
  return (
    <div className="flex min-h-7 items-center gap-2 pr-2 pb-1.5 pl-6 text-xs text-muted-foreground">
      <span className="min-w-0 truncate tabular-nums">{hold.text}</span>
      <SquireHoldRuleBadge label={hold.ruleLabel} />
      <span className="flex-1" />
      <Button size="xs" variant="outline" disabled={hold.undoDisabled} onClick={hold.undo}>
        Undo
      </Button>
    </div>
  );
}

/**
 * Reads the held card only for its rule (a hold carries no rule in the snapshot), and the
 * Squire's rules only when one started it; holds are few and short-lived.
 */
function useSquireHoldRuleLabel(
  environmentId: EnvironmentId,
  squireId: SquireId,
  hold: SquireHold,
  targetTitle: string | null,
): string | null {
  const projects = useProjects();
  const state = useSquireEnvironmentState(environmentId);
  const detail = useEnvironmentQuery(
    squireEnvironment.item({ environmentId, input: { squireId, cardId: hold.cardId } }),
  );
  const card = detail.data?.card ?? null;
  const rules = useEnvironmentQuery(
    card === null || card.ruleId === null
      ? null
      : squireEnvironment.rules({ environmentId, input: { squireId: card.squireId } }),
  );
  return squireHoldRuleLabel(card, rules.data?.rules ?? [], {
    squireName: (id) => state?.squires.find((entry) => entry.squire.id === id)?.squire.name ?? "",
    targetName: (rule) =>
      (rule.targetKind === "thread" && rule.targetId === card?.targetThreadId
        ? targetTitle
        : rule.targetKind === "project"
          ? projects.find(
              (project) => project.environmentId === environmentId && project.id === rule.targetId,
            )?.title
          : null) ?? rule.targetId,
  });
}
