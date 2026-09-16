/** Geometry shared by the base stroke and travelling sheen, including rounded corners. */
export function threadBorderGeometry(
  width: number,
  height: number,
  radius: number,
  stroke: number,
) {
  if (
    ![width, height, radius, stroke].every(Number.isFinite) ||
    width <= stroke ||
    height <= stroke
  ) {
    return null;
  }
  const inset = stroke / 2;
  const w = width - stroke;
  const h = height - stroke;
  const r = Math.max(0, Math.min(radius - inset, w / 2, h / 2));
  const right = width - inset;
  const bottom = height - inset;
  return {
    path: `M ${inset + r} ${inset} H ${right - r} A ${r} ${r} 0 0 1 ${right} ${inset + r} V ${bottom - r} A ${r} ${r} 0 0 1 ${right - r} ${bottom} H ${inset + r} A ${r} ${r} 0 0 1 ${inset} ${bottom - r} V ${inset + r} A ${r} ${r} 0 0 1 ${inset + r} ${inset} Z`,
    perimeter: 2 * (w + h - 4 * r) + 2 * Math.PI * r,
  };
}

// Dark surfaces retain gold; cream surfaces need the deeper copper body under the glint.
export function threadBorderPalette(light: boolean, settled: boolean) {
  if (settled) {
    return light
      ? { base: "#ad3c2f", trail: "#c35938", metal: "#e67c47", tip: "#ffd097" }
      : { base: "#e64d3d", trail: "#ed624f", metal: "#ff866f", tip: "#ffd097" };
  }
  return light
    ? { base: "#82472c", trail: "#bc7642", metal: "#e5a06d", tip: "#ffe1b1" }
    : { base: "#b68a43", trail: "#dca64e", metal: "#ffe1a0", tip: "#ffeac1" };
}

export const THREAD_BORDER_CYCLE_MS = 4000;
export const THREAD_BORDER_STEPS = 48;

/** Match the desktop's bounded updates even on 120Hz displays. */
export function threadBorderPhase(elapsed: number) {
  "worklet";
  return (
    Math.floor(
      (elapsed % THREAD_BORDER_CYCLE_MS) / (THREAD_BORDER_CYCLE_MS / THREAD_BORDER_STEPS),
    ) / THREAD_BORDER_STEPS
  );
}
