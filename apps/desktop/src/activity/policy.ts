import type { DesktopActivityAction, DesktopActivitySnapshot } from "@lecturn/contracts";

export function isPublishedActivityAction(
  snapshot: DesktopActivitySnapshot,
  action: DesktopActivityAction,
): boolean {
  const row = snapshot.rows.find((candidate) => candidate.id === action.rowId);
  return (
    row !== undefined &&
    row.environmentId === action.environmentId &&
    row.projectId === action.projectId &&
    row.threadId === action.threadId &&
    row.watchId === action.watchId &&
    row.watchRevision === action.watchRevision &&
    row.actions.some((candidate) => candidate.id === action.kind && candidate.disabled !== true) &&
    (action.kind !== "steer" || Boolean(action.text?.trim()))
  );
}

export function isTrustedActivitySender(input: {
  senderId: number;
  expectedId: number;
  isMainFrame: boolean;
  url: string;
  expectedUrl: string;
}): boolean {
  if (input.senderId !== input.expectedId || !input.isMainFrame) return false;
  try {
    const actual = new URL(input.url);
    const expected = new URL(input.expectedUrl);
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      (actual.protocol !== "data:" || input.url === input.expectedUrl)
    );
  } catch {
    return false;
  }
}
