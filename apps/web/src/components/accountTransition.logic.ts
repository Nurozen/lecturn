export const ACCOUNT_KNOCK_MS = 320;
export const ACCOUNT_WAVE_MS = 1500;
export const ACCOUNT_TRANSITION_MS = ACCOUNT_KNOCK_MS + ACCOUNT_WAVE_MS;

/** A continuous S-shaped front: the lower glass follows the selected card's impact. */
export function accountWavePath(width: number, height: number, originY: number, elapsed: number) {
  const progress = Math.max(0, Math.min(1, (elapsed - ACCOUNT_KNOCK_MS) / ACCOUNT_WAVE_MS));
  const eased = progress * progress * (3 - 2 * progress);
  const bend = Math.sin(progress * Math.PI) * Math.min(120, width * 0.14);
  const x = eased * (width + 140) - 1;
  const startY = Math.max(48, Math.min(height - 48, originY));
  const direction = startY < height / 2 ? -1 : 1;
  const y = startY + direction * eased * height * 0.65;
  const spread = Math.min(150, height * 0.2);
  const edge = `M ${x} 0 L ${x} ${y - spread} C ${x} ${y - spread * 0.25}, ${x + bend} ${y - spread * 0.45}, ${x + bend} ${y + spread * 0.25} L ${x + bend} ${height}`;
  return {
    edge,
    wash: `${edge} L ${width + 150} ${height} L ${width + 150} 0 Z`,
    progress,
    bendY: y,
  };
}

export function shouldAnimateAccountSelection(
  multiAccount: boolean,
  current: { project?: string | undefined; account?: string | undefined },
  next: { project?: string | undefined; account?: string | undefined },
): boolean {
  if (multiAccount) return (current.account ?? "") !== (next.account ?? "");
  return Boolean(current.project && next.project && current.project !== next.project);
}
