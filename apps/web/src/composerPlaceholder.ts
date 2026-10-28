export const DISCONNECTED_COMPOSER_PLACEHOLDER =
  "Ask for changes, send follow-ups, or attach images";

/**
 * The composer's prompt while nothing asks the user for anything. A thread with no provider
 * session yet (a copied or imported one) reads as "disconnected" here, though it is as idle as any
 * other, so an embed host's placeholder replaces that prompt too.
 */
export function idleComposerPlaceholder(input: {
  readonly hostPlaceholder: string | null;
  readonly hasSession: boolean;
  readonly resting: boolean;
  readonly canAttach: boolean;
}): string {
  if (input.hostPlaceholder !== null) return input.hostPlaceholder;
  if (!input.hasSession) return DISCONNECTED_COMPOSER_PLACEHOLDER;
  if (!input.resting) return "Ask anything, @tag files/folders, $use skills, or / for commands";
  return input.canAttach
    ? "Ask for changes, send follow-ups, or attach files"
    : "Ask for changes or send a follow-up";
}
