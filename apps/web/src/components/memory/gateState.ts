import type {
  ContributionCard,
  ContributionPlan,
  MemoryCardVerdict,
  MemoryVerdict,
} from "@lecturn/contracts";
import { findSecret } from "./secretPatterns";

/* Pure Contribution Gate state. The component maps keys to actions:
   A accept, S skip, E edit (opens a draft), M merge, D distinct, J/K move,
   U undo. Review cards need a verdict before landing; auto cards land on
   their own unless pulled into review; silent cards never show. */

export interface GateVerdict {
  readonly verdict: MemoryVerdict;
  /** Replacement summary, set only for `edit`. */
  readonly summary?: string;
}

interface UndoEntry {
  readonly nodeId: string;
  readonly previous: GateVerdict | null;
}

export interface GateState {
  readonly planId: string;
  /** Review tier in plan order, then any auto cards pulled into review. */
  readonly review: ReadonlyArray<ContributionCard>;
  /** Auto tier minus pulled cards. */
  readonly auto: ReadonlyArray<ContributionCard>;
  readonly silent: ReadonlyArray<ContributionCard>;
  readonly pulled: ReadonlySet<string>;
  readonly cursor: number;
  readonly verdicts: ReadonlyMap<string, GateVerdict>;
  readonly undo: ReadonlyArray<UndoEntry>;
  /** Summary being edited for the card at `cursor`, or null. */
  readonly draft: string | null;
  /** True once the last undecided card gets a verdict; shows the round summary. */
  readonly complete: boolean;
}

export type GateAction =
  | { readonly type: "verdict"; readonly verdict: Exclude<MemoryVerdict, "edit"> }
  | { readonly type: "edit" }
  | { readonly type: "draft"; readonly text: string }
  | { readonly type: "confirmEdit" }
  | { readonly type: "cancelEdit" }
  | { readonly type: "move"; readonly delta: 1 | -1 }
  | { readonly type: "jump"; readonly index: number }
  | { readonly type: "undo" }
  | { readonly type: "pull"; readonly nodeId: string }
  | { readonly type: "unpull"; readonly nodeId: string };

export const SUMMARY_MAX_LENGTH = 400;

export const isSecretSuspect = (card: ContributionCard) =>
  card.flags.some((flag) => flag.kind === "secret-suspect");

/** The verdict Enter confirms on an undecided card. Secret suspects default to skip. */
export const suggestedVerdict = (card: ContributionCard): MemoryVerdict | null =>
  isSecretSuspect(card) ? "skip" : null;

/** Edit only rewrites the summary, so a secret in the body can never land. */
const SECRET_IN_BODY = "Secret is in the body; skip this node.";

/** True when the card's den body (context) matches a secret pattern. */
export const hasSecretInBody = (card: ContributionCard) => findSecret(card.den.context) !== null;

/** Why `verdict` is not allowed on `card`, or null when it is. */
export function verdictBlock(card: ContributionCard, verdict: MemoryVerdict): string | null {
  if ((verdict === "merge" || verdict === "distinct") && card.target === null)
    return "Needs a warren target. This card is a new node.";
  if (verdict !== "skip" && hasSecretInBody(card)) return SECRET_IN_BODY;
  // Accept, merge and keep-both all land the flagged summary as is.
  if (verdict !== "skip" && verdict !== "edit" && isSecretSuspect(card))
    return "Looks like a secret. Edit it out with E, or skip to keep it in the den.";
  return null;
}

/** Why the edit draft cannot be saved, or null when it can. */
export function draftBlock(card: ContributionCard, draft: string): string | null {
  const text = draft.trim();
  if (text.length === 0) return "A summary cannot be empty.";
  if (text.length > SUMMARY_MAX_LENGTH)
    return `Keep it under ${SUMMARY_MAX_LENGTH} characters (${text.length}).`;
  if (isSecretSuspect(card) && text === card.den.summary.trim())
    return "Still the flagged text. Remove the secret before accepting.";
  const leaked = findSecret(text);
  if (leaked) return `Still looks like it contains ${leaked}. Remove it before accepting.`;
  if (hasSecretInBody(card)) return SECRET_IN_BODY;
  return null;
}

export function createGateState(plan: ContributionPlan): GateState {
  const review = plan.cards.filter((card) => card.tier === "review");
  return {
    planId: plan.planId,
    review,
    auto: plan.cards.filter((card) => card.tier === "auto"),
    silent: plan.cards.filter((card) => card.tier === "silent"),
    pulled: new Set(),
    cursor: 0,
    verdicts: new Map(),
    undo: [],
    draft: null,
    complete: review.length === 0,
  };
}

export const currentCard = (state: GateState): ContributionCard | null =>
  state.review[state.cursor] ?? null;

export const undecidedCount = (state: GateState) =>
  state.review.reduce((n, card) => (state.verdicts.has(card.nodeId) ? n : n + 1), 0);

/** Land is enabled once every review card has a verdict. */
export const canLand = (state: GateState) => undecidedCount(state) === 0;

/** Verdicts to send with land. Auto and silent cards land by tier on the server. */
export const landVerdicts = (state: GateState): MemoryCardVerdict[] =>
  state.review.flatMap((card) => {
    const decided = state.verdicts.get(card.nodeId);
    if (!decided) return [];
    return decided.verdict === "edit" && decided.summary !== undefined
      ? [{ nodeId: card.nodeId, verdict: "edit", summary: decided.summary }]
      : [{ nodeId: card.nodeId, verdict: decided.verdict }];
  });

/** Nodes that would reach the warren: auto cards plus every non-skip review verdict. */
export const landNodeCount = (state: GateState) =>
  state.auto.length +
  state.review.reduce((n, card) => {
    const decided = state.verdicts.get(card.nodeId);
    return decided && decided.verdict !== "skip" ? n + 1 : n;
  }, 0);

export const tierCounts = (state: GateState) => ({
  silent: state.silent.length,
  auto: state.auto.length,
  review: state.review.length,
});

function nextUndecided(
  review: ReadonlyArray<ContributionCard>,
  verdicts: ReadonlyMap<string, GateVerdict>,
  from: number,
): number {
  for (let step = 1; step <= review.length; step++) {
    const index = (from + step) % review.length;
    if (!verdicts.has(review[index]!.nodeId)) return index;
  }
  return -1;
}

function commit(state: GateState, card: ContributionCard, decided: GateVerdict): GateState {
  const verdicts = new Map(state.verdicts).set(card.nodeId, decided);
  const next = nextUndecided(state.review, verdicts, state.cursor);
  return {
    ...state,
    verdicts,
    undo: [
      ...state.undo,
      { nodeId: card.nodeId, previous: state.verdicts.get(card.nodeId) ?? null },
    ],
    draft: null,
    cursor: next < 0 ? state.cursor : next,
    complete: next < 0,
  };
}

const clampCursor = (state: GateState, index: number) =>
  Math.max(0, Math.min(state.review.length - 1, index));

export function gateReducer(state: GateState, action: GateAction): GateState {
  const card = currentCard(state);
  switch (action.type) {
    case "verdict": {
      if (!card || state.draft !== null || verdictBlock(card, action.verdict)) return state;
      return commit(state, card, { verdict: action.verdict });
    }
    case "edit": {
      if (!card || state.draft !== null) return state;
      const decided = state.verdicts.get(card.nodeId);
      return { ...state, draft: decided?.summary ?? card.den.summary, complete: false };
    }
    case "draft":
      return state.draft === null ? state : { ...state, draft: action.text };
    case "confirmEdit": {
      if (!card || state.draft === null || draftBlock(card, state.draft)) return state;
      return commit(state, card, { verdict: "edit", summary: state.draft.trim() });
    }
    case "cancelEdit":
      return state.draft === null ? state : { ...state, draft: null };
    case "move": {
      if (state.review.length === 0) return state;
      const cursor = clampCursor(state, state.cursor + action.delta);
      if (cursor === state.cursor && !state.complete) return state;
      return { ...state, cursor, draft: null, complete: false };
    }
    case "jump": {
      if (action.index < 0 || action.index >= state.review.length) return state;
      return { ...state, cursor: action.index, draft: null, complete: false };
    }
    case "undo": {
      const last = state.undo.at(-1);
      if (!last) return state;
      const verdicts = new Map(state.verdicts);
      if (last.previous) verdicts.set(last.nodeId, last.previous);
      else verdicts.delete(last.nodeId);
      const index = state.review.findIndex((c) => c.nodeId === last.nodeId);
      return {
        ...state,
        verdicts,
        undo: state.undo.slice(0, -1),
        cursor: index < 0 ? state.cursor : index,
        draft: null,
        complete: false,
      };
    }
    case "pull": {
      const pulledCard = state.auto.find((c) => c.nodeId === action.nodeId);
      if (!pulledCard) return state;
      return {
        ...state,
        auto: state.auto.filter((c) => c !== pulledCard),
        review: [...state.review, pulledCard],
        pulled: new Set(state.pulled).add(pulledCard.nodeId),
        cursor: state.review.length,
        draft: null,
        complete: false,
      };
    }
    case "unpull": {
      if (!state.pulled.has(action.nodeId)) return state;
      const pulledCard = state.review.find((c) => c.nodeId === action.nodeId)!;
      const review = state.review.filter((c) => c !== pulledCard);
      const pulled = new Set(state.pulled);
      pulled.delete(action.nodeId);
      const verdicts = new Map(state.verdicts);
      verdicts.delete(action.nodeId);
      const next: GateState = {
        ...state,
        review,
        auto: [pulledCard, ...state.auto],
        pulled,
        verdicts,
        undo: state.undo.filter((entry) => entry.nodeId !== action.nodeId),
        draft: null,
        cursor: Math.max(0, Math.min(review.length - 1, state.cursor)),
      };
      return { ...next, complete: undecidedCount(next) === 0 };
    }
  }
}

const sameCard = (a: ContributionCard, b: ContributionCard) =>
  a.op === b.op && a.den.summary === b.den.summary && a.target?.id === b.target?.id;

/**
 * Rebuild the Gate on a fresh plan after a stale-plan land. Verdicts carry
 * over for cards whose op, summary and target did not change and whose verdict
 * is still allowed; the rest are re-queued. Pulled cards stay pulled when
 * they are still in the auto tier.
 */
export function rebaseGateState(
  state: GateState,
  plan: ContributionPlan,
): { readonly state: GateState; readonly requeued: number } {
  const base = createGateState(plan);
  const previous = new Map(state.review.map((card) => [card.nodeId, card]));
  const pullable = base.auto.filter((card) => state.pulled.has(card.nodeId));
  const review = [...base.review, ...pullable];
  const verdicts = new Map<string, GateVerdict>();
  for (const card of review) {
    const before = previous.get(card.nodeId);
    const decided = state.verdicts.get(card.nodeId);
    if (before && decided && sameCard(before, card) && !verdictBlock(card, decided.verdict))
      verdicts.set(card.nodeId, decided);
  }
  const requeued = review.filter((card) => !verdicts.has(card.nodeId)).length;
  const firstOpen = review.findIndex((card) => !verdicts.has(card.nodeId));
  return {
    state: {
      ...base,
      review,
      auto: base.auto.filter((card) => !state.pulled.has(card.nodeId)),
      pulled: new Set(pullable.map((card) => card.nodeId)),
      verdicts,
      cursor: Math.max(0, firstOpen),
      complete: firstOpen < 0,
    },
    requeued,
  };
}
