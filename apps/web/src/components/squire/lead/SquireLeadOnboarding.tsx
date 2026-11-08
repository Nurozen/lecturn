import { useAtomValue } from "@effect/atom-react";
import {
  SQUIRE_LEAD_INTRO_START_LABEL,
  squireLeadIntro,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireCard, SquireCardId, SquireId } from "@lecturn/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { squireEnvironment } from "../../../state/squires";
import { useQuickSteer } from "../../pullRequest/useQuickSteer";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { useSquireItemsAct } from "../chat/squireApprovalsState";
import { openSquireSetup } from "../setup/squireSetupStore";
import { SquireCompanion, type SquireCompanionHandle } from "../SquireCompanion";
import { SquirePortrait, useSquireHomeShell, useSquireIndicator } from "../SquireHeader";
import { requestSquireGesture, useSquireGestureRequests } from "./squireGestureRequests";
import {
  SQUIRE_LEAD_MORE_PROPOSALS_TEXT,
  squireLeadOnboardingPhase,
  squireLeadProposalPayload,
  squireLeadGreeting,
  squireLeadGreets,
  squireLeadProposalRows,
  type SquireProposalPayload,
} from "./squireLead.logic";
import { SquireProposalSummary } from "./SquireProposalSummary";
import {
  squireLeadOnboardingRuns,
  useSquireLeadIntroSupported,
  useSquireLeadOnboardingRun,
  useSquireLeadStartOnboarding,
} from "./useSquireLeadOpen";

interface LeadProposal {
  readonly card: SquireCard;
  readonly payload: SquireProposalPayload;
}

// The Lead's decision rows are the sidebar's query too; only its own proposals load a detail.
const leadProposalsAtom = Atom.family((key: string) => {
  const [environmentId, leadId] = JSON.parse(key) as [EnvironmentId, SquireId];
  return Atom.make((get) => {
    const rows =
      Option.getOrNull(
        AsyncResult.value(
          get(squireEnvironment.decisionItems({ environmentId, squireId: leadId })),
        ),
      )?.items ?? [];
    const proposals: LeadProposal[] = [];
    for (const row of squireLeadProposalRows(rows, leadId)) {
      const detail = get(
        squireEnvironment.item({ environmentId, input: { squireId: leadId, cardId: row.id } }),
      );
      const card = Option.getOrNull(AsyncResult.value(detail))?.card ?? null;
      const payload = card === null ? null : squireLeadProposalPayload(card, leadId);
      if (card !== null && payload !== null) proposals.push({ card, payload });
    }
    return proposals;
  }).pipe(Atom.withLabel(`web-squire-lead-proposals:${key}`));
});

const leadProposalsKey = (environmentId: EnvironmentId, leadId: SquireId) =>
  JSON.stringify([environmentId, leadId]);

const GREETING_PORTRAIT_PX = 24;

const NO_PROPOSALS = Atom.make<ReadonlyArray<LeadProposal>>([]);

/** The cards the onboarding panel shows, so the Lead's queue can leave them out. */
export function useSquireLeadOnboardingCardIds(
  environmentId: EnvironmentId,
  leadId: SquireId | null,
): ReadonlySet<string> {
  const proposals = useAtomValue(
    leadId === null ? NO_PROPOSALS : leadProposalsAtom(leadProposalsKey(environmentId, leadId)),
  );
  return new Set(proposals.map((proposal) => proposal.card.id));
}

/**
 * Onboarding in the Lead's view: its fixed intro, then the full figure playing `greet` and the
 * proposal cards. Renders nothing once the Lead has no onboarding proposals open.
 */
export function SquireLeadOnboarding(props: {
  readonly environmentId: EnvironmentId;
  readonly lead: SquireSnapshotEntry;
  /**
   * False while the companion panel shows the Lead's figure, which greets on the view's first
   * open, so the figure never appears twice.
   */
  readonly showFigure?: boolean;
}) {
  const { environmentId, lead } = props;
  const leadId = lead.squire.id;
  const proposals = useAtomValue(leadProposalsAtom(leadProposalsKey(environmentId, leadId)));
  const run = useSquireLeadOnboardingRun(environmentId);
  const working = useSquireIndicator(environmentId, lead).state === "working";
  const homeShell = useSquireHomeShell(environmentId, lead);
  const introSupported = useSquireLeadIntroSupported(environmentId);
  // Re-runs when a run is queued, since the Lead may already be working by then.
  useEffect(() => {
    if (run === null) return;
    squireLeadOnboardingRuns.observe(environmentId, working);
  }, [environmentId, working, run]);
  const { canAct, run: act } = useSquireItemsAct(environmentId);
  // Cards the user just settled, hidden until the refetched rows drop them.
  const [settled, setSettled] = useState<ReadonlyArray<SquireCardId>>([]);
  const [busy, setBusy] = useState<ReadonlyArray<SquireCardId>>([]);
  const shown = proposals.filter((proposal) => !settled.includes(proposal.card.id));
  const phase = squireLeadOnboardingPhase({
    lead: lead.squire,
    proposalCount: shown.length,
    run,
    homeVisibleItemCount:
      lead.squire.homeThreadId === null ? 0 : (homeShell?.visibleItemCount ?? null),
    introSupported,
  });
  const shownKey = phase === "proposals" ? shown.map((proposal) => proposal.card.id).join() : "";
  // Greet when the cards first appear, on whichever figure is mounted. Child effects run
  // first, so the onboarding's own figure already listens.
  useEffect(() => {
    if (shownKey === "" || !squireLeadGreets.claim(leadId, shownKey.split(","))) return;
    requestSquireGesture(leadId, "greet");
  }, [leadId, shownKey]);
  if (phase === "hidden") return null;

  const settle = async (cardIds: ReadonlyArray<SquireCardId>, action: "accept" | "dismiss") => {
    setBusy((ids) => [...ids, ...cardIds]);
    const result = await act(cardIds, action);
    setBusy((ids) => ids.filter((id) => !cardIds.includes(id)));
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "The proposal could not be updated. Try again." });
      return;
    }
    const failed = result.value.results.filter((outcome) => outcome.error);
    setSettled((ids) => [
      ...ids,
      ...cardIds.filter((id) => !failed.some((outcome) => outcome.cardId === id)),
    ]);
    const [first] = failed;
    if (first?.error) toastManager.add({ type: "error", title: first.error.message });
  };

  return (
    <section
      aria-label={`${lead.squire.name} onboarding`}
      className="mx-4 mb-3 flex flex-col gap-4 rounded-lg border border-border bg-card px-4 py-4 @2xl/squire:flex-row"
    >
      {props.showFigure !== false ? <LeadFigure lead={lead} looking={phase === "looking"} /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {/* The Lead says hello in its own voice; a still figure cannot show the wave. */}
        <div className="flex items-start gap-2">
          <SquirePortrait
            environmentId={environmentId}
            entry={lead}
            size={GREETING_PORTRAIT_PX}
            label={lead.squire.name}
          />
          <p className="min-w-0 pt-0.5 text-sm text-foreground">
            {squireLeadGreeting(lead.squire.name, phase, shown.length)}
          </p>
        </div>
        {phase === "intro" ? (
          <SquireLeadIntro environmentId={environmentId} />
        ) : phase === "looking" ? null : (
          <>
            <p className="text-xs text-muted-foreground">
              Each starts recommend-only. Accept to create it, or edit it first.
            </p>
            {/* Sized by the cards' own width, not the page's, which includes the companion panel. */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
              {shown.map((proposal) => (
                <ProposalCard
                  key={proposal.card.id}
                  environmentId={environmentId}
                  proposal={proposal}
                  canAct={canAct}
                  busy={busy.includes(proposal.card.id)}
                  onAccept={() => void settle([proposal.card.id], "accept")}
                  onSkip={() => void settle([proposal.card.id], "dismiss")}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {canAct && shown.length > 1 ? (
                <Button
                  size="xs"
                  disabled={busy.length > 0}
                  onClick={() =>
                    void settle(
                      shown.map((proposal) => proposal.card.id),
                      "accept",
                    )
                  }
                >
                  Accept all
                </Button>
              ) : null}
              <SquireLeadAskMore environmentId={environmentId} lead={lead} />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** What Squires are, in the Lead's voice, before any paid turn; the conversation below takes questions. */
function SquireLeadIntro(props: { readonly environmentId: EnvironmentId }) {
  const { allowed, start } = useSquireLeadStartOnboarding(props.environmentId);
  const [starting, setStarting] = useState(false);
  const lookOver = async () => {
    setStarting(true);
    const started = await start();
    setStarting(false);
    if (!started) {
      toastManager.add({ type: "error", title: "The Lead could not start. Try again." });
    }
  };
  return (
    <>
      {squireLeadIntro("desktop").map((paragraph) => (
        <p key={paragraph} className="text-sm text-foreground/85">
          {paragraph}
        </p>
      ))}
      {allowed ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" disabled={starting} onClick={() => void lookOver()}>
            {SQUIRE_LEAD_INTRO_START_LABEL}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function LeadFigure(props: { readonly lead: SquireSnapshotEntry; readonly looking: boolean }) {
  const { squire } = props.lead;
  const companion = useRef<SquireCompanionHandle>(null);
  // Greets when the proposals appear (the onboarding requests it), not on mount.
  useSquireGestureRequests(squire.id, companion);
  return (
    <div className="flex w-40 shrink-0 flex-col items-center gap-1 self-center @2xl/squire:self-start">
      <SquireCompanion
        ref={companion}
        companion={squire.companion}
        state={props.looking ? "thinking" : "attentive"}
        placement="overlay"
        crest
        label={squire.name}
        className="w-full"
      />
      <span className="text-sm font-medium text-foreground">{squire.name}</span>
    </div>
  );
}

function ProposalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly proposal: LeadProposal;
  readonly canAct: boolean;
  readonly busy: boolean;
  readonly onAccept: () => void;
  readonly onSkip: () => void;
}) {
  const { environmentId, proposal } = props;
  const { card, payload } = proposal;
  return (
    <article
      aria-label={payload.name}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2.5"
    >
      <SquireProposalSummary environmentId={environmentId} proposal={payload} />
      {card.why.trim() === "" ? null : (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-muted-foreground">Why</span>
          <p className="text-xs text-foreground/85">{card.why}</p>
        </div>
      )}
      {props.canAct ? (
        <div className="mt-auto flex items-center gap-1.5 pt-1">
          <Button size="xs" disabled={props.busy} onClick={props.onAccept}>
            Accept
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={props.busy}
            onClick={() =>
              openSquireSetup({
                kind: "proposal",
                environmentId,
                cardId: card.id,
                proposal: payload,
              })
            }
          >
            Edit
          </Button>
          <Button size="xs" variant="ghost" disabled={props.busy} onClick={props.onSkip}>
            Skip
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/**
 * "Ask for more proposals": a user message to the Lead's home thread, sent the way the
 * notch quick steer sends one, so the composer's draft is left alone.
 */
export function SquireLeadAskMore(props: {
  readonly environmentId: EnvironmentId;
  readonly lead: SquireSnapshotEntry;
}) {
  const send = useQuickSteer();
  const [sending, setSending] = useState(false);
  const threadId = props.lead.squire.homeThreadId;
  if (threadId === null) return null;
  const ask = async () => {
    setSending(true);
    const failure = await send(props.environmentId, threadId, SQUIRE_LEAD_MORE_PROPOSALS_TEXT).then(
      () => null,
      (error: unknown) => error,
    );
    setSending(false);
    toastManager.add(
      failure === null
        ? { type: "success", title: `Asked ${props.lead.squire.name} for more` }
        : {
            type: "error",
            title: failure instanceof Error ? failure.message : "The request could not be sent.",
          },
    );
  };
  return (
    <Button size="xs" variant="ghost" disabled={sending} onClick={() => void ask()}>
      Ask for more proposals
    </Button>
  );
}
