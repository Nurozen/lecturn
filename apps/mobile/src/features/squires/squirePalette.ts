import type { SquirePalette } from "@lecturn/contracts";

export interface SquireTint {
  readonly ring: string;
  readonly strand: string;
  readonly thread: string;
  readonly trace: string;
}

// Mirrors apps/web/src/components/squire/squirePaletteTint.ts. Ring is the v5 emblem's dark
// `halo` on both themes; light surfaces swap strand, thread, and trace for the v5 light set,
// where the pale strands wash out.
const DARK: Readonly<Record<SquirePalette, SquireTint>> = {
  brass: { ring: "#f2a948", strand: "#e3cca8", thread: "#d9a34e", trace: "#fff4dc" },
  moonstone: { ring: "#93bdf0", strand: "#dfe8f0", thread: "#a6bdd2", trace: "#f5faff" },
  sage: { ring: "#9ed39b", strand: "#dde5cf", thread: "#a3b686", trace: "#f6fcee" },
  rose: { ring: "#ef98ae", strand: "#f2dcd7", thread: "#d0979e", trace: "#fff3f3" },
  gold: { ring: "#e8b23a", strand: "#f4dc9c", thread: "#e8b23a", trace: "#fff6d8" },
};

const LIGHT: Readonly<Record<SquirePalette, SquireTint>> = {
  brass: { ring: "#f2a948", strand: "#6f4f2b", thread: "#b27a25", trace: "#e27800" },
  moonstone: { ring: "#93bdf0", strand: "#34495e", thread: "#62809c", trace: "#3f86d0" },
  sage: { ring: "#9ed39b", strand: "#44523a", thread: "#718657", trace: "#5b9a3a" },
  rose: { ring: "#ef98ae", strand: "#683d45", thread: "#a9636d", trace: "#cf4f6c" },
  gold: { ring: "#e8b23a", strand: "#6b4e12", thread: "#b07f12", trace: "#c98a00" },
};

/** Gold belongs to the Lead (OQ22), whatever its stored palette. */
export function squireTint(
  palette: SquirePalette,
  isLead: boolean | undefined,
  appearance: "light" | "dark",
): SquireTint {
  const key = isLead ? "gold" : palette;
  return appearance === "light" ? LIGHT[key] : DARK[key];
}

/** CSS `grayscale(1)` (Rec. 709 luma), which the web mark uses for idle; RN has no filter. */
export function grayscaleHex(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  const luma = Math.round(
    0.2126 * ((value >> 16) & 0xff) + 0.7152 * ((value >> 8) & 0xff) + 0.0722 * (value & 0xff),
  );
  const channel = luma.toString(16).padStart(2, "0");
  return `#${channel}${channel}${channel}`;
}

export function grayscaleTint(tint: SquireTint): SquireTint {
  return {
    ring: grayscaleHex(tint.ring),
    strand: grayscaleHex(tint.strand),
    thread: grayscaleHex(tint.thread),
    trace: grayscaleHex(tint.trace),
  };
}
