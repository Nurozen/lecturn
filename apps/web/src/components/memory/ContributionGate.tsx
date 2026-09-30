import type {
  ContributionPlan,
  EnvironmentId,
  MemoryReceipt,
  MemoryVerdict,
  ProjectId,
} from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import { Undo2Icon } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup } from "~/components/ui/dialog";
import { GoldThreadSpinner } from "~/components/ui/gold-thread-spinner";
import { cn } from "~/lib/utils";
import { memoryDemoEnvironment, useMemoryDen, useMemoryGraph } from "../../state/memoryDemo";
import { useAtomCommand } from "../../state/use-atom-command";
import { GateCard } from "./gate/GateCard";
import { GateHeader } from "./gate/GateHeader";
import { GateReceipt } from "./gate/GateReceipt";
import { GateRoundSummary } from "./gate/GateRoundSummary";
import { GateSide } from "./gate/GateSide";
import {
  KeyCap,
  plural,
  prefersReducedMotion,
  VERDICT_LABEL,
  VERDICT_TONE,
} from "./gate/gateVisuals";
import {
  canLand,
  createGateState,
  currentCard,
  draftBlock,
  gateReducer,
  landNodeCount,
  landVerdicts,
  rebaseGateState,
  suggestedVerdict,
  tierCounts,
  undecidedCount,
  verdictBlock,
  type GateAction,
  type GateState,
} from "./gateState";

export interface ContributionGateProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Called with the receipt after a land, or null when dismissed without landing. */
  readonly onClose: (receipt: MemoryReceipt | null) => void;
}

type Phase =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly code: string | null; readonly message: string }
  | { readonly kind: "review" }
  | { readonly kind: "receipt"; readonly receipt: MemoryReceipt };

type Busy = "landing" | "reverting" | "replanning" | null;

interface DemoFailure {
  readonly code: string | null;
  readonly message: string;
}

function describeFailure(cause: Cause.Cause<unknown>): DemoFailure {
  const error = Cause.squash(cause);
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "MemoryDemoError" && "code" in error && "message" in error)
      return { code: String(error.code), message: String(error.message) };
  }
  return {
    code: null,
    message: error instanceof Error && error.message.trim() ? error.message : "The request failed.",
  };
}

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  disabled: {
    title: "Memory is not running here",
    body: "This environment has the memory store turned off, or it has not started yet.",
  },
  "not-found": {
    title: "Nothing to contribute",
    body: "This project has no den yet. Agents create one the first time they write a memory.",
  },
};

// Exit direction per verdict: landing verdicts leave right, skip leaves left,
// merge folds into the target, keep-both lifts away.
const EXIT_TRANSFORM: Record<MemoryVerdict, string> = {
  accept: "translateX(56px) rotate(1.4deg)",
  edit: "translateX(56px) rotate(1.4deg)",
  skip: "translateX(-56px) rotate(-1.4deg)",
  merge: "translateX(28px) scale(0.94)",
  distinct: "translateY(-24px)",
};
const CARD_MS = 150;
const CARD_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** Review dialog that plans, judges and lands a project's den. Keys: A S E M D
    verdicts, J K move, U undo, Enter lands or takes a suggestion, Esc is Later. */
export function ContributionGate({ environmentId, projectId, onClose }: ContributionGateProps) {
  const planCommand = useAtomCommand(memoryDemoEnvironment.plan, { reportFailure: false });
  const landCommand = useAtomCommand(memoryDemoEnvironment.land, { reportFailure: false });
  const revertCommand = useAtomCommand(memoryDemoEnvironment.revert, { reportFailure: false });
  const den = useMemoryDen(environmentId, projectId);
  // Cards carry territory ids; show the labels the Map shows, falling back to the id.
  const graph = useMemoryGraph(environmentId);
  const territoryLabels = useMemo(
    () => new Map(graph.data?.territories.map((t) => [t.id, t.label]) ?? []),
    [graph.data],
  );
  const territoryLabel = useCallback(
    (territoryId: string) => territoryLabels.get(territoryId) ?? territoryId,
    [territoryLabels],
  );
  const headlineId = useId();

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [gate, setGateState] = useState<GateState | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Keys can arrive faster than renders; reads go through the ref, writes keep both in sync.
  const gateRef = useRef<GateState | null>(null);
  const setGate = useCallback((next: GateState | null) => {
    gateRef.current = next;
    setGateState(next);
  }, []);
  const busyRef = useRef<Busy>(null);
  useLayoutEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const stageItemRef = useRef<HTMLDivElement | null>(null);
  const ghostLayerRef = useRef<HTMLDivElement>(null);
  // Initial focus lands on the stage, not the close button, so Enter never dismisses by accident.
  const stageRef = useRef<HTMLDivElement>(null);
  const enterFromRef = useRef<string>("translateY(10px) scale(0.985)");

  const requestPlan = useCallback(async () => {
    const result = await planCommand({ environmentId, input: { projectId } });
    return result._tag === "Success"
      ? ({ ok: true, plan: result.value } as const)
      : ({ ok: false, failure: describeFailure(result.cause) } as const);
  }, [environmentId, planCommand, projectId]);

  const openPlan = useCallback(
    (plan: ContributionPlan) => {
      setGate(createGateState(plan));
      setPhase({ kind: "review" });
    },
    [setGate],
  );

  const loadPlan = useCallback(async () => {
    setPhase({ kind: "loading" });
    const result = await requestPlan();
    if (result.ok) openPlan(result.plan);
    else setPhase({ kind: "error", ...result.failure });
  }, [openPlan, requestPlan]);

  useEffect(() => {
    let cancelled = false;
    void requestPlan().then((result) => {
      if (cancelled) return;
      if (result.ok) openPlan(result.plan);
      else setPhase({ kind: "error", ...result.failure });
    });
    return () => {
      cancelled = true;
    };
  }, [openPlan, requestPlan]);

  const dispatch = useCallback(
    (action: GateAction, enterFrom?: string) => {
      const current = gateRef.current;
      if (!current) return;
      const next = gateReducer(current, action);
      if (next === current) return;
      if (enterFrom) enterFromRef.current = enterFrom;
      setNotice(null);
      setGate(next);
    },
    [setGate],
  );

  // The stage item remounts per card (keyed), so mounting is the enter cue.
  const enterStage = useCallback((element: HTMLDivElement | null) => {
    stageItemRef.current = element;
    if (!element || prefersReducedMotion()) return;
    element.animate(
      [
        { transform: enterFromRef.current, opacity: 0 },
        { transform: "none", opacity: 1 },
      ],
      { duration: CARD_MS, easing: CARD_EASING },
    );
    enterFromRef.current = "translateY(10px) scale(0.985)";
  }, []);

  const playExit = useCallback((verdict: MemoryVerdict) => {
    const source = stageItemRef.current;
    const layer = ghostLayerRef.current;
    if (!source || !layer || prefersReducedMotion()) return;
    const ghost = source.cloneNode(true) as HTMLElement;
    for (const node of ghost.querySelectorAll("[id]")) node.removeAttribute("id");
    ghost.querySelector(`[data-verdict="${verdict}"]`)?.setAttribute("data-pressed", "");
    ghost.inert = true;
    layer.replaceChildren(ghost);
    ghost
      .animate(
        [
          { transform: "none", opacity: 1 },
          { transform: EXIT_TRANSFORM[verdict], opacity: 0 },
        ],
        {
          duration: CARD_MS,
          easing: CARD_EASING,
          fill: "forwards",
        },
      )
      .addEventListener("finish", () => ghost.remove());
  }, []);

  const decide = useCallback(
    (verdict: MemoryVerdict) => {
      const current = gateRef.current;
      const card = current && currentCard(current);
      if (!current || !card || current.draft !== null || busyRef.current) return;
      if (verdict === "edit") {
        dispatch({ type: "edit" });
        return;
      }
      const blocked = verdictBlock(card, verdict);
      if (blocked) {
        setNotice(blocked);
        return;
      }
      playExit(verdict);
      dispatch({ type: "verdict", verdict }, "translateY(10px) scale(0.985)");
    },
    [dispatch, playExit],
  );

  const confirmEdit = useCallback(() => {
    const current = gateRef.current;
    const card = current && currentCard(current);
    if (!current || !card || current.draft === null || draftBlock(card, current.draft)) return;
    playExit("edit");
    dispatch({ type: "confirmEdit" }, "translateY(10px) scale(0.985)");
  }, [dispatch, playExit]);

  const landState = useCallback(
    async (state: GateState) => {
      if (!canLand(state) || busyRef.current) return;
      setBusy("landing");
      busyRef.current = "landing";
      setActionError(null);
      const result = await landCommand({
        environmentId,
        input: { projectId, planId: state.planId, verdicts: landVerdicts(state) },
      });
      if (result._tag === "Success") {
        setNote(null);
        setPhase({ kind: "receipt", receipt: result.value });
        setBusy(null);
        return;
      }
      const failure = describeFailure(result.cause);
      if (failure.code === "stale-plan") {
        setBusy("replanning");
        const replanned = await requestPlan();
        if (replanned.ok) {
          const rebased = rebaseGateState(gateRef.current ?? state, replanned.plan);
          setGate(rebased.state);
          setPhase({ kind: "review" });
          setNote(
            `Plan changed, ${rebased.requeued} ${plural(rebased.requeued, "card")} re-queued`,
          );
        } else setActionError(replanned.failure.message);
      } else setActionError(failure.message);
      setBusy(null);
    },
    [environmentId, landCommand, projectId, requestPlan, setGate],
  );

  const land = useCallback(() => {
    const current = gateRef.current;
    if (current) void landState(current);
  }, [landState]);

  const revert = useCallback(async () => {
    if (phase.kind !== "receipt" || busyRef.current) return;
    setBusy("reverting");
    setActionError(null);
    const result = await revertCommand({
      environmentId,
      input: { receiptId: phase.receipt.id },
    });
    if (result._tag === "Success") setPhase({ kind: "receipt", receipt: result.value });
    else setActionError(describeFailure(result.cause).message);
    setBusy(null);
  }, [environmentId, phase, revertCommand]);

  // After a revert the den holds the nodes again: re-plan, keep the verdicts
  // that still apply, and land straight away when nothing needs a new decision.
  const landAgain = useCallback(async () => {
    const previous = gateRef.current;
    if (!previous || busyRef.current) return;
    setBusy("replanning");
    busyRef.current = "replanning";
    setActionError(null);
    const replanned = await requestPlan();
    busyRef.current = null;
    setBusy(null);
    if (!replanned.ok) {
      setActionError(replanned.failure.message);
      return;
    }
    const rebased = rebaseGateState(previous, replanned.plan);
    setGate(rebased.state);
    if (canLand(rebased.state)) {
      void landState(rebased.state);
      return;
    }
    setPhase({ kind: "review" });
    setNote(`Plan changed, ${rebased.requeued} ${plural(rebased.requeued, "card")} re-queued`);
  }, [landState, requestPlan, setGate]);

  const receipt = phase.kind === "receipt" ? phase.receipt : null;
  const later = useCallback(() => onClose(null), [onClose]);
  const done = useCallback(() => onClose(receipt), [onClose, receipt]);
  const dismiss = receipt ? done : later;

  // Window capture so Gate keys win over app shortcuts while the dialog is open.
  const keyHandlerRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const handleKey = (event: KeyboardEvent): boolean => {
    const target = event.target instanceof Element ? event.target : null;
    const current = gateRef.current;
    const inField = target?.closest("input, textarea, select, [contenteditable='true']");
    if (inField) {
      if (!target?.closest("[data-gate-draft]")) return false;
      if (event.key === "Escape") {
        dispatch({ type: "cancelEdit" });
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        confirmEdit();
        return true;
      }
      return false;
    }
    const onButton = target?.closest("button, a, [role='button']") !== null && target !== null;
    if (phase.kind === "receipt") {
      if (event.key === "Escape" || (event.key === "Enter" && !onButton)) {
        done();
        return true;
      }
      return false;
    }
    if (phase.kind !== "review" || !current) {
      if (event.key === "Escape") {
        later();
        return true;
      }
      return false;
    }
    if (current.draft !== null) {
      if (event.key === "Escape") {
        dispatch({ type: "cancelEdit" });
        return true;
      }
      return false;
    }
    if (busyRef.current) return event.key.length === 1 || event.key === "Enter";
    switch (event.key.length === 1 ? event.key.toLowerCase() : event.key) {
      case "a":
        decide("accept");
        return true;
      case "s":
        decide("skip");
        return true;
      case "e":
        decide("edit");
        return true;
      case "m":
        decide("merge");
        return true;
      case "d":
        decide("distinct");
        return true;
      case "j":
        dispatch({ type: "move", delta: 1 }, "translateY(10px)");
        return true;
      case "k":
        dispatch({ type: "move", delta: -1 }, "translateY(-10px)");
        return true;
      case "u":
        dispatch({ type: "undo" }, "translateX(-40px) rotate(-1deg)");
        return true;
      case "Enter": {
        if (onButton) return false;
        if (canLand(current)) {
          land();
          return true;
        }
        const card = currentCard(current);
        const suggestion = card && !current.verdicts.has(card.nodeId) && suggestedVerdict(card);
        if (suggestion) {
          decide(suggestion);
          return true;
        }
        return false;
      }
      case "Escape":
        later();
        return true;
      default:
        return false;
    }
  };
  useLayoutEffect(() => {
    keyHandlerRef.current = handleKey;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!keyHandlerRef.current(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const card = gate && !gate.complete ? currentCard(gate) : null;
  const stageKey = phase.kind !== "review" || !gate ? phase.kind : (card?.nodeId ?? "summary");

  const undecided = gate ? undecidedCount(gate) : 0;
  const landCount = gate ? landNodeCount(gate) : 0;
  const counts = gate ? tierCounts(gate) : null;
  const headline =
    phase.kind === "loading"
      ? "Planning the contribution"
      : phase.kind === "error"
        ? (ERROR_COPY[phase.code ?? ""]?.title ?? "The Gate could not open")
        : phase.kind === "receipt"
          ? phase.receipt.reverted
            ? "Reverted. Nothing from this den is in the warren."
            : `Landed ${phase.receipt.id}. One click reverts it.`
          : undecided > 0
            ? `${undecided} ${plural(undecided, "card")} ${undecided === 1 ? "needs" : "need"} you, ${counts?.auto ?? 0} ${counts?.auto === 1 ? "lands" : "land"} on ${counts?.auto === 1 ? "its" : "their"} own`
            : `All cards decided. ${landCount} ${plural(landCount, "node")} ready to land`;
  const destinations = gate
    ? [...new Set([...gate.review, ...gate.auto].map((c) => territoryLabel(c.territoryId)))]
    : [];

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogPopup
        showCloseButton={false}
        bottomStickOnMobile={false}
        aria-labelledby={headlineId}
        initialFocus={stageRef}
        className="h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] max-w-[1320px] overflow-hidden p-0"
      >
        <GateHeader
          denName={den.data?.name ?? String(projectId)}
          destinations={destinations}
          headline={headline}
          headlineId={headlineId}
          counts={phase.kind === "error" || phase.kind === "loading" ? null : counts}
          onClose={dismiss}
          closeLabel={receipt ? "Done" : "Close. Same as Later: nothing lands."}
        />

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_292px] max-lg:grid-cols-1">
          <div
            ref={stageRef}
            tabIndex={-1}
            className="flex min-h-0 min-w-0 flex-col items-center overflow-y-auto px-6 py-4 outline-none"
          >
            <div className="my-auto flex w-full max-w-[880px] flex-col items-center">
              {phase.kind === "review" && gate && card ? (
                <ProgressDots
                  gate={gate}
                  onJump={(index) =>
                    dispatch(
                      { type: "jump", index },
                      index < gate.cursor ? "translateY(-10px)" : "translateY(10px)",
                    )
                  }
                />
              ) : null}
              <div className="relative w-full">
                <div key={stageKey} ref={enterStage} className="flex w-full justify-center">
                  {phase.kind === "loading" ? (
                    <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground text-sm">
                      <GoldThreadSpinner />
                      Reading the den and matching it against the warren
                    </div>
                  ) : phase.kind === "error" ? (
                    <div className="flex max-w-md flex-col items-center gap-3 py-16 text-center">
                      <p className="text-muted-foreground text-sm">
                        {ERROR_COPY[phase.code ?? ""]?.body ?? phase.message}
                      </p>
                      <div className="flex gap-2">
                        <Button variant="outline" onClick={later}>
                          Close
                        </Button>
                        <Button onClick={() => void loadPlan()}>Try again</Button>
                      </div>
                    </div>
                  ) : phase.kind === "receipt" ? (
                    <GateReceipt
                      territoryLabel={territoryLabel}
                      receipt={phase.receipt}
                      busy={busy !== null}
                      error={actionError}
                      onRevert={() => void revert()}
                      onLandAgain={() => void landAgain()}
                    />
                  ) : gate && card ? (
                    <GateCard
                      territoryLabel={territoryLabel}
                      card={card}
                      decided={gate.verdicts.get(card.nodeId)}
                      draft={gate.draft}
                      suggested={suggestedVerdict(card)}
                      pulled={gate.pulled.has(card.nodeId)}
                      onVerdict={decide}
                      onDraftChange={(text) => dispatch({ type: "draft", text })}
                      onConfirmEdit={confirmEdit}
                      onCancelEdit={() => dispatch({ type: "cancelEdit" })}
                      onUnpull={() => dispatch({ type: "unpull", nodeId: card.nodeId })}
                    />
                  ) : gate ? (
                    <GateRoundSummary
                      review={gate.review}
                      verdicts={gate.verdicts}
                      landCount={landCount}
                      canUndo={gate.undo.length > 0}
                      landing={busy !== null}
                      onJump={(index) => dispatch({ type: "jump", index }, "translateY(-10px)")}
                      onUndo={() => dispatch({ type: "undo" }, "translateX(-40px) rotate(-1deg)")}
                      onLand={land}
                    />
                  ) : null}
                </div>
                <div
                  ref={ghostLayerRef}
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center"
                />
              </div>
            </div>
          </div>
          {gate && phase.kind !== "loading" && phase.kind !== "error" ? (
            <GateSide
              review={gate.review}
              auto={gate.auto}
              silentCount={gate.silent.length}
              verdicts={gate.verdicts}
              cursor={phase.kind === "review" && card ? gate.cursor : null}
              interactive={phase.kind === "review" && busy === null}
              onJump={(index) =>
                dispatch(
                  { type: "jump", index },
                  index < gate.cursor ? "translateY(-10px)" : "translateY(10px)",
                )
              }
              onPull={(nodeId) => dispatch({ type: "pull", nodeId })}
            />
          ) : (
            <div className="border-l max-lg:hidden" />
          )}
        </div>

        <GateFooter
          phase={phase.kind}
          gate={gate}
          busy={busy}
          note={note}
          notice={notice}
          actionError={phase.kind === "review" ? actionError : null}
          undecided={undecided}
          landCount={landCount}
          onLater={later}
          onUndo={() => dispatch({ type: "undo" }, "translateX(-40px) rotate(-1deg)")}
          onLand={land}
          onDone={done}
        />
      </DialogPopup>
    </Dialog>
  );
}

function ProgressDots({ gate, onJump }: { gate: GateState; onJump: (index: number) => void }) {
  return (
    <div className="mb-3 flex flex-none flex-wrap items-center justify-center gap-1.5">
      {gate.review.map((card, index) => {
        const decided = gate.verdicts.get(card.nodeId);
        const current = index === gate.cursor;
        return (
          <button
            key={card.nodeId}
            type="button"
            aria-current={current ? "step" : undefined}
            aria-label={`Card ${index + 1}${decided ? `, ${VERDICT_LABEL[decided.verdict]}` : ""}`}
            onClick={() => onJump(index)}
            className={cn(
              "h-2 rounded-full outline-none transition-[width,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              current ? "w-8.5 shadow-[inset_0_0_0_1.5px_var(--color-foreground)]" : "w-5.5",
              decided ? VERDICT_TONE[decided.verdict] : "bg-muted-foreground/22",
            )}
          />
        );
      })}
      <span className="ml-2 text-muted-foreground text-xs tabular-nums">
        card {gate.cursor + 1} of {gate.review.length}
      </span>
    </div>
  );
}

function GateFooter({
  phase,
  gate,
  busy,
  note,
  notice,
  actionError,
  undecided,
  landCount,
  onLater,
  onUndo,
  onLand,
  onDone,
}: {
  phase: Phase["kind"];
  gate: GateState | null;
  busy: Busy;
  note: string | null;
  notice: string | null;
  actionError: string | null;
  undecided: number;
  landCount: number;
  onLater: () => void;
  onUndo: () => void;
  onLand: () => void;
  onDone: () => void;
}) {
  const primaryKey = (
    <KeyCap className="border-primary-foreground/40 bg-primary-foreground/15 text-primary-foreground">
      ⏎
    </KeyCap>
  );
  if (phase === "receipt")
    return (
      <footer className="flex items-center gap-2.5 border-t bg-muted/60 px-6 py-3">
        <span className="text-muted-foreground text-xs">
          Revert stays available from here until you close the Gate.
        </span>
        <span className="grow" />
        <Button onClick={onDone}>Done {primaryKey}</Button>
      </footer>
    );
  const ready = gate !== null && canLand(gate) && phase === "review";
  const status =
    busy === "landing"
      ? "Landing"
      : busy === "replanning"
        ? "The den changed. Re-planning"
        : (actionError ?? notice ?? note);
  const statusTone =
    actionError || notice ? "text-destructive-foreground" : "text-muted-foreground";
  return (
    <footer className="flex items-center gap-2.5 border-t bg-muted/60 px-6 py-3">
      <Button variant="outline" onClick={onLater}>
        Later
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!gate || gate.undo.length === 0 || busy !== null || phase !== "review"}
        onClick={onUndo}
      >
        <Undo2Icon />
        Undo last verdict <KeyCap>U</KeyCap>
      </Button>
      <span className="grow" />
      <span role="status" className={cn("truncate text-xs", statusTone)}>
        {status ??
          (phase === "review" && undecided > 0
            ? `${undecided} ${plural(undecided, "card")} left before anything lands.`
            : null)}
      </span>
      <Button disabled={!ready || busy !== null} onClick={onLand}>
        {busy === "landing" ? "Landing" : `Land ${landCount} ${plural(landCount, "node")}`}
        {ready && busy === null ? primaryKey : null}
      </Button>
    </footer>
  );
}
