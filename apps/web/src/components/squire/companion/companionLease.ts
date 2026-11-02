// Only one companion animates at a time (spec P16.5). Overlays (hover card, setup preview,
// onboarding) outrank the panel; within a rank the most recent claimant wins. A companion
// that does not hold the lease pauses with reason `yielded` and keeps its last frame.

export type CompanionPlacement = "panel" | "overlay";

export interface CompanionLease {
  readonly holding: boolean;
  setPlacement(placement: CompanionPlacement): void;
  release(): void;
}

type Claim = {
  placement: CompanionPlacement;
  order: number;
  holding: boolean;
  readonly onChange: (holding: boolean) => void;
};

const claims = new Set<Claim>();
let nextOrder = 0;

function holderOf(): Claim | null {
  let best: Claim | null = null;
  for (const claim of claims) {
    if (
      best === null ||
      (claim.placement === "overlay" && best.placement === "panel") ||
      (claim.placement === best.placement && claim.order > best.order)
    ) {
      best = claim;
    }
  }
  return best;
}

function reassign() {
  const holder = holderOf();
  const changed: Claim[] = [];
  for (const claim of claims) {
    const holding = claim === holder;
    if (claim.holding !== holding) {
      claim.holding = holding;
      changed.push(claim);
    }
  }
  // Release the old holder before starting the new one so two loops never overlap.
  changed.sort((a, b) => Number(a.holding) - Number(b.holding));
  for (const claim of changed) claim.onChange(claim.holding);
}

export function acquireCompanionLease(
  placement: CompanionPlacement,
  onChange: (holding: boolean) => void,
): CompanionLease {
  const claim: Claim = { placement, order: nextOrder++, holding: false, onChange };
  claims.add(claim);
  reassign();
  return {
    get holding() {
      return claim.holding;
    },
    setPlacement(next) {
      if (!claims.has(claim) || claim.placement === next) return;
      claim.placement = next;
      claim.order = nextOrder++;
      reassign();
    },
    release() {
      if (!claims.delete(claim)) return;
      claim.holding = false;
      reassign();
    },
  };
}
