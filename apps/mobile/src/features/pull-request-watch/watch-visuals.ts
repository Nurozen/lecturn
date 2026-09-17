/** Every reported check belongs to one segment; no observations are never success. */
export function checkSegments(checks: readonly { readonly status: string }[]) {
  const segments = { passed: 0, running: 0, attention: 0, failed: 0, other: 0 };
  for (const check of checks) {
    if (check.status === "success") segments.passed++;
    else if (check.status === "pending") segments.running++;
    else if (check.status === "action-required") segments.attention++;
    else if (check.status === "failure") segments.failed++;
    else segments.other++;
  }
  return segments;
}

export function cardIsVisible(
  layout: { readonly y: number; readonly height: number } | undefined,
  viewport: { readonly y: number; readonly height: number },
): boolean {
  return (
    !!layout &&
    viewport.height > 0 &&
    layout.y + layout.height > viewport.y &&
    layout.y < viewport.y + viewport.height
  );
}
