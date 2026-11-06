/**
 * The inactivity window's clock. User Squire actions stamp the Lead's
 * `user_active_at`; SquireTriggers.checkInactivity reads it.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SquireRepository from "./SquireRepository.ts";

/** The window is days long, so finer stamps would only add writes. */
const USER_ACTIVITY_THROTTLE_MS = 10 * 60 * 1000;

/**
 * Call after a user Squire mutation commits, never from server-internal
 * paths. Never fails: the user's action already happened.
 */
export const touchUserActivity = Effect.fn("squireUserActivity.touchUserActivity")(
  function* (repository: SquireRepository.SquireRepository["Service"], now: string) {
    const lead = yield* repository.getLead;
    if (Option.isNone(lead)) return;
    const staleBefore = DateTime.formatIso(
      DateTime.subtractDuration(DateTime.makeUnsafe(now), USER_ACTIVITY_THROTTLE_MS),
    );
    const last = lead.value.user_active_at;
    if (last !== null && last > staleBefore) return;
    yield* repository.touchUserActiveAt({ id: lead.value.id, at: now, staleBefore });
  },
  Effect.catchCause((cause) => Effect.logWarning("Could not record Squire activity", { cause })),
);
