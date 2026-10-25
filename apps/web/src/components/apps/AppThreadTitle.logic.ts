interface TimelineRowHead {
  readonly id: string;
  readonly kind: string;
  readonly message?: { readonly role: string };
}

/**
 * The row an app thread's title sits beside, as the app mockups set the title level with the
 * opening message. Only the thread's own opening message qualifies: with earlier history still
 * to load (or cut by an import), the first loaded row is mid-thread and the title stays above it.
 */
export function appThreadTitleRowId(input: {
  readonly rows: ReadonlyArray<TimelineRowHead>;
  readonly historyControls?:
    | { readonly hasMoreHistory: boolean; readonly error: string | null }
    | undefined;
  readonly importHistoryTruncated: boolean;
}): string | null {
  if (input.importHistoryTruncated) return null;
  if (input.historyControls?.hasMoreHistory || input.historyControls?.error) return null;
  const first = input.rows[0];
  return first?.kind === "message" && first.message?.role === "user" ? first.id : null;
}
