import type {
  EnvironmentId,
  Squire,
  SquireCard,
  SquireCardPayload,
  SquireCardRow,
  SquireId,
} from "@lecturn/contracts";
import { UnknownUnionMember } from "@lecturn/contracts";
import { squireLeadHello, squireLeadShowsIntro } from "@lecturn/client-runtime/state/squire";

// Shared with the mobile app; re-exported so the Lead view's callers keep one import.
export {
  squireProposalCardText,
  squireProposalPaletteLabel,
  squireProposalScopeLabels,
} from "@lecturn/client-runtime/state/squire";

export type SquireProposalPayload = Extract<
  SquireCardPayload,
  { readonly type: "squire-proposal" }
>;

/** The request the Lead view's "Ask for more proposals" sends to the Lead. */
export const SQUIRE_LEAD_MORE_PROPOSALS_TEXT =
  "Propose more Squires for projects you have not covered yet.";

/**
 * Rows that may be onboarding proposals: open proposals the Lead raised itself. A thread
 * proposal the Lead raises is owned by the Squire that will track it, and a room proposal is
 * told apart only by its payload, so the card detail decides (`squireLeadProposalPayload`).
 */
export function squireLeadProposalRows<
  Row extends Pick<SquireCardRow, "kind" | "status" | "squireId">,
>(rows: ReadonlyArray<Row>, leadId: SquireId): ReadonlyArray<Row> {
  return rows.filter(
    (row) => row.kind === "proposal" && row.status === "open" && row.squireId === leadId,
  );
}

/** The Lead's queue without the proposals its onboarding panel already shows as cards. */
export function squireRowsOutsideOnboarding<Row extends Pick<SquireCardRow, "id">>(
  rows: ReadonlyArray<Row>,
  onboardingIds: ReadonlySet<string>,
): ReadonlyArray<Row> {
  return onboardingIds.size === 0 ? rows : rows.filter((row) => !onboardingIds.has(row.id));
}

/**
 * The Lead greets when its proposal cards first appear, once per onboarding. An
 * onboarding is known by its first proposal set: a set sharing a card with one already greeted
 * is the same onboarding after an accept or skip, while a set with no card in common (more
 * proposals after the first were all settled) is a new one. Per page session, like gestures.
 */
export function createSquireLeadGreets() {
  const greeted = new Map<SquireId, Set<string>>();
  return {
    /** True the first time a proposal set of this onboarding shows; it should greet then. */
    claim(leadId: SquireId, cardIds: ReadonlyArray<string>): boolean {
      if (cardIds.length === 0) return false;
      const seen = greeted.get(leadId) ?? new Set<string>();
      const sameOnboarding = cardIds.some((id) => seen.has(id));
      for (const id of cardIds) seen.add(id);
      greeted.set(leadId, seen);
      return !sameOnboarding;
    },
  };
}

export const squireLeadGreets = createSquireLeadGreets();

/** The Squire a card proposes, when it is an open Squire proposal the Lead raised. */
export function squireLeadProposalPayload(
  card: Pick<SquireCard, "kind" | "status" | "squireId" | "payload">,
  leadId: SquireId,
): SquireProposalPayload | null {
  if (squireLeadProposalRows([card], leadId).length === 0) return null;
  const { payload } = card;
  return !(payload instanceof UnknownUnionMember) && payload.type === "squire-proposal"
    ? payload
    : null;
}

export interface SquireLeadOnboardingRun {
  /** The Lead's turn was seen working since the onboarding was queued. */
  readonly sawWorking: boolean;
}

/**
 * One onboarding per environment per page load: queued by `squire.lead.open`, and over once
 * the Lead was seen working and stopped, so a Lead that proposed nothing leaves no spinner.
 */
export function createSquireLeadOnboardingRuns() {
  const runs = new Map<EnvironmentId, SquireLeadOnboardingRun>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: (environmentId: EnvironmentId) => runs.get(environmentId) ?? null,
    queued(environmentId: EnvironmentId) {
      runs.set(environmentId, { sawWorking: false });
      emit();
    },
    /** The Lead's current indicator state, while a run is tracked. */
    observe(environmentId: EnvironmentId, working: boolean) {
      const run = runs.get(environmentId);
      if (run === undefined) return;
      if (working && !run.sawWorking) runs.set(environmentId, { sawWorking: true });
      else if (!working && run.sawWorking) runs.delete(environmentId);
      else return;
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type SquireLeadOnboardingPhase = "proposals" | "looking" | "intro" | "hidden";

/**
 * Proposal cards while the Lead has open Squire proposals; "looking" while a look-over this page
 * queued has yet to end; the fixed intro before any look-over while the home thread is empty;
 * otherwise nothing. A Lead that cannot run (no provider, paused) shows none of them.
 */
export function squireLeadOnboardingPhase(input: {
  readonly lead: Pick<Squire, "onboardedAt" | "lifecycle" | "status">;
  readonly proposalCount: number;
  readonly run: SquireLeadOnboardingRun | null;
  /** Null until the home thread loads. */
  readonly homeVisibleItemCount: number | null;
}): SquireLeadOnboardingPhase {
  if (input.proposalCount > 0) return "proposals";
  if (input.lead.lifecycle !== "ready" || input.lead.status !== "active") return "hidden";
  if (input.run !== null) return "looking";
  if (squireLeadShowsIntro(input)) return "intro";
  return "hidden";
}

/**
 * The line the Lead says at the top of its onboarding panel, in its own
 * voice and under its own name when the user renamed it.
 */
export function squireLeadGreeting(
  name: string,
  phase: Exclude<SquireLeadOnboardingPhase, "hidden">,
  proposalCount: number,
): string {
  const who = squireLeadHello(name);
  if (phase === "intro") return `${who} Here's what Squires can do for you.`;
  if (phase === "looking") return `${who} I'm looking at your projects…`;
  const suggestion = proposalCount === 1 ? "this Squire" : "these Squires";
  return `${who} I looked at your projects and suggest ${suggestion}.`;
}

/**
 * What a proposal card's portrait draws: the proposed companion as one still bust (hood,
 * palette, and held equipment, or the emblem's frame), never its own motion level. Face crops
 * of one rig read alike at card size, and a live figure per card would contend for the
 * single animation lease; a still companion neither animates nor claims it.
 */
export function squireProposalPortrait(
  companion: SquireProposalPayload["companion"],
): SquireProposalPayload["companion"] {
  return { ...companion, motion: "still" };
}

type SquireCountEntry = {
  readonly squire: Pick<Squire, "name">;
  readonly openDecisionCount: number;
};

/**
 * The Lead's sidebar badge counts only what the Lead raised, while its header counts the
 * whole team, so the badge says where its items and the rest come from: "1 raised by Lead · 2
 * by your Squires", naming the Squire when only one has items.
 */
export function squireLeadBadgeTooltip(block: {
  readonly lead: SquireCountEntry | null;
  readonly squires: ReadonlyArray<SquireCountEntry>;
}): string | null {
  const own = block.lead?.openDecisionCount ?? 0;
  const raisers = block.squires.filter((entry) => entry.openDecisionCount > 0);
  const others = raisers.reduce((sum, entry) => sum + entry.openDecisionCount, 0);
  const othersName = (raisers.length === 1 ? raisers[0]?.squire.name : null) ?? "your Squires";
  const parts = [
    ...(own > 0 && block.lead !== null ? [`${own} raised by ${block.lead.squire.name}`] : []),
    ...(others > 0 ? [`${others} ${own > 0 ? "by" : "raised by"} ${othersName}`] : []),
  ];
  return parts.length === 0 ? null : parts.join(" · ");
}
