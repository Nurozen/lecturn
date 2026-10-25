import { UserIcon } from "lucide-react";

import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";

/**
 * Positioned off the bubble's leading edge: the user row is a right-aligned column, so a sibling
 * would stack above the bubble instead of beside it.
 */
export function EmbedUserAvatar() {
  if (useEmbedPresentation() === null) return null;
  return (
    <span
      aria-hidden
      data-thread-find-ignore
      data-embed-user-avatar
      className="pointer-events-none absolute end-[calc(100%+0.75rem)] top-1.5 flex size-8 items-center justify-center rounded-full bg-foreground/85 text-background"
    >
      <UserIcon className="size-4.5" />
    </span>
  );
}
