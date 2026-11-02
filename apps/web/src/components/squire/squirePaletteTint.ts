import type { CompanionPalette } from "./companion/types";

// Ring is the v5 emblem's dark `halo`; strand, thread, and trace are its `light`, `gold`, and
// `comet` tones, swapped for the v5 light-surface set where pale strands wash out. Gold is
// the Lead's palette (OQ22).
export const SQUIRE_PALETTE_TINT: Readonly<Record<CompanionPalette, string>> = {
  brass:
    "[--squire-ring:#f2a948] [--squire-strand:#e3cca8] [--squire-thread:#d9a34e] [--squire-trace:#fff4dc] light:[--squire-strand:#6f4f2b] light:[--squire-thread:#b27a25] light:[--squire-trace:#e27800]",
  moonstone:
    "[--squire-ring:#93bdf0] [--squire-strand:#dfe8f0] [--squire-thread:#a6bdd2] [--squire-trace:#f5faff] light:[--squire-strand:#34495e] light:[--squire-thread:#62809c] light:[--squire-trace:#3f86d0]",
  sage: "[--squire-ring:#9ed39b] [--squire-strand:#dde5cf] [--squire-thread:#a3b686] [--squire-trace:#f6fcee] light:[--squire-strand:#44523a] light:[--squire-thread:#718657] light:[--squire-trace:#5b9a3a]",
  rose: "[--squire-ring:#ef98ae] [--squire-strand:#f2dcd7] [--squire-thread:#d0979e] [--squire-trace:#fff3f3] light:[--squire-strand:#683d45] light:[--squire-thread:#a9636d] light:[--squire-trace:#cf4f6c]",
  gold: "[--squire-ring:#e8b23a] [--squire-strand:#f4dc9c] [--squire-thread:#e8b23a] [--squire-trace:#fff6d8] light:[--squire-strand:#6b4e12] light:[--squire-thread:#b07f12] light:[--squire-trace:#c98a00]",
};
