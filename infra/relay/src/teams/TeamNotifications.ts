import type { RelayAgentActivityAggregateState } from "@lecturn/contracts/relay";
import { Effect } from "effect";
import type { ManagedAccess } from "../billing/ManagedAccess.ts";

/** Recheck concrete environments both before enqueue and at signed-job delivery. */
export const filterPermittedActivity = (
  access: ManagedAccess["Service"],
  userId: string,
  aggregate: RelayAgentActivityAggregateState | null,
  originCreatedAtSeconds?: number,
) =>
  Effect.gen(function* () {
    if (aggregate === null) return null;
    const checks = yield* Effect.forEach(
      aggregate.activities,
      (row) =>
        access.check(userId, "liveActivities", originCreatedAtSeconds, row.environmentId).pipe(
          Effect.as(true),
          Effect.catchTag("ManagedAccessRequired", () => Effect.succeed(false)),
        ),
      { concurrency: 4 },
    );
    const activities = aggregate.activities.filter((_, index) => checks[index]);
    if (activities.length === aggregate.activities.length) return aggregate;
    if (!activities.length) return null;
    const activeCount = activities.filter(
      (row) => row.phase !== "completed" && row.phase !== "failed",
    ).length;
    return {
      ...aggregate,
      activities,
      activeCount,
      subtitle: activeCount > 0 ? "Agent work in progress" : "Agent work completed",
      updatedAt: activities.reduce(
        (latest, row) => (row.updatedAt > latest ? row.updatedAt : latest),
        activities[0]!.updatedAt,
      ),
    };
  });
