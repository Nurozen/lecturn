import type { EnvironmentId, SquireCardId } from "@lecturn/contracts";

/**
 * One `squire.items.markOpened` per card per session. Opening a card cancels its phone
 * escalation, which only the first open needs; a card some surface already opened needs none.
 * A failed send releases the card so the next open retries.
 */
export function createSquireOpenedTracker() {
  const sent = new Set<string>();
  const key = (environmentId: EnvironmentId, cardId: SquireCardId) =>
    JSON.stringify([environmentId, cardId]);
  return {
    /** True when this open should be sent, and records it as sent. */
    take(
      environmentId: EnvironmentId,
      cardId: SquireCardId,
      openedAt: string | null | undefined,
    ): boolean {
      const id = key(environmentId, cardId);
      if (sent.has(id)) return false;
      sent.add(id);
      return openedAt == null;
    },
    release(environmentId: EnvironmentId, cardId: SquireCardId): void {
      sent.delete(key(environmentId, cardId));
    },
  };
}

export type SquireOpenedTracker = ReturnType<typeof createSquireOpenedTracker>;

/** The page-load session: a reload is a new session. */
export const squireOpenedThisSession = createSquireOpenedTracker();
