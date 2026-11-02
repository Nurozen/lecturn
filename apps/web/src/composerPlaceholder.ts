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

/**
 * Lecturn: a Squire's home thread prompts with what it is for (D63). Null is any other thread,
 * or a Squire the snapshot does not list yet.
 */
export function squireComposerPlaceholder(
  squire: { readonly name: string; readonly role: "lead" | "squire" } | null,
): string | null {
  if (squire === null) return null;
  return squire.role === "lead"
    ? "Ask the Lead to route a task or check on your Squires…"
    : `Ask ${squire.name} about anything it watches…`;
}
