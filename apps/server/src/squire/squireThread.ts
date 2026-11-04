import type { SquireThreadMarker } from "@lecturn/contracts";

/**
 * A Squire home thread or probe. Every server site that lists, mines,
 * settles, summarizes, or notifies about user threads skips these.
 */
export const isSquireThread = (thread: {
  readonly squire?: SquireThreadMarker | undefined;
}): boolean => thread.squire !== undefined;
