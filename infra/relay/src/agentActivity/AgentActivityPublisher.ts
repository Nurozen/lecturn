import { makeAggregateState } from "./AgentActivityAggregate.ts";
export {
  makeAggregateState,
  TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS,
} from "./AgentActivityAggregate.ts";
import type {
  RelayAgentActivityState,
  RelayDeliveryResult,
  RelayPublishResponse,
} from "@lecturn/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { isTerminalPhase } from "./agentActivityPayloads.ts";

export { isExpiredAgentActivityState } from "./agentActivityPayloads.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import { TeamRuntime } from "../teams/TeamRuntime.ts";
import { ManagedAccessUnavailable } from "../billing/ManagedAccess.ts";

export type AgentActivityPublishError =
  | AgentActivityRows.AgentActivityRowUpsertPersistenceError
  | AgentActivityRows.AgentActivityRowDeletePersistenceError
  | AgentActivityRows.AgentActivityRowListPersistenceError
  | EnvironmentLinks.EnvironmentLinkUserListPersistenceError
  | LiveActivities.LiveActivityTargetListPersistenceError
  | ApnsDeliveries.ApnsDeliveryError
  | ManagedAccessUnavailable;

export class AgentActivityPublisher extends Context.Service<
  AgentActivityPublisher,
  {
    readonly publish: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly threadId: string;
      readonly state: RelayAgentActivityState | null;
      // True while the user is at a Lecturn client: devices update silently
      // and the ring stays owed. Older environments omit it.
      readonly userPresent?: boolean;
    }) => Effect.Effect<RelayPublishResponse, AgentActivityPublishError>;
    readonly replayForLiveActivityRegistration: (input: {
      readonly userId: string;
      readonly deviceId: string;
    }) => Effect.Effect<RelayDeliveryResult | null, AgentActivityPublishError>;
  }
>()("lecturn-relay/agentActivity/AgentActivityPublisher") {}

export const make = Effect.gen(function* () {
  const rows = yield* AgentActivityRows.AgentActivityRows;
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const liveActivities = yield* LiveActivities.LiveActivities;
  const apnsDeliveries = yield* ApnsDeliveries.ApnsDeliveries;
  const teams = yield* Effect.serviceOption(TeamRuntime);

  const publishForDeliveryUser = Effect.fn(
    "relay.agent_activity_publisher.publish_for_delivery_user",
  )(function* (input: {
    readonly deliveryUser: EnvironmentLinks.AgentAwarenessDeliveryUserRecord;
    readonly state: RelayAgentActivityState | null;
    readonly userPresent: boolean;
    readonly publishingEnvironmentId: string;
    readonly nowMs: number;
  }) {
    yield* Effect.annotateCurrentSpan({ "user.id": input.deliveryUser.userId });
    const activeStates = yield* rows.listForUser({ userId: input.deliveryUser.userId });
    const liveActivityAggregate = input.deliveryUser.liveActivitiesEnabled
      ? makeAggregateState({
          activeStates,
          terminalState: input.state && isTerminalPhase(input.state) ? input.state : null,
          nowMs: input.nowMs,
        })
      : null;
    const notificationOnlyAggregate =
      input.deliveryUser.notificationsEnabled &&
      !input.deliveryUser.liveActivitiesEnabled &&
      input.state !== null
        ? makeAggregateState({
            activeStates: isTerminalPhase(input.state) ? [] : [input.state],
            terminalState: isTerminalPhase(input.state) ? input.state : null,
            nowMs: input.nowMs,
          })
        : null;
    const targets = yield* liveActivities.listTargets({ userId: input.deliveryUser.userId });
    const deliveriesByTarget = yield* Effect.forEach(
      targets,
      (target) =>
        Effect.all(
          [
            apnsDeliveries.sendForTarget({
              target,
              aggregate: liveActivityAggregate,
              nowMs: input.nowMs,
              userPresent: input.userPresent,
              publishingEnvironmentId: input.publishingEnvironmentId,
            }),
            notificationOnlyAggregate === null
              ? Effect.succeed(null)
              : apnsDeliveries.sendPushNotificationForTarget({
                  target,
                  aggregate: notificationOnlyAggregate,
                  userPresent: input.userPresent,
                  publishingEnvironmentId: input.publishingEnvironmentId,
                }),
          ],
          { concurrency: 2 },
        ),
      { concurrency: 4 },
    );
    return deliveriesByTarget.flat();
  });

  return AgentActivityPublisher.of({
    replayForLiveActivityRegistration: Effect.fn(
      "relay.agent_activity_publisher.replay_for_live_activity_registration",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
        "user.id": input.userId,
        "relay.operation": "replayForLiveActivityRegistration",
      });
      const { activeStates, targets } = yield* Effect.all(
        {
          activeStates: rows.listForUser({ userId: input.userId }),
          targets: liveActivities.listTargets({ userId: input.userId }),
        },
        { concurrency: 2 },
      );
      const target = targets.find((row) => row.device_id === input.deviceId) ?? null;
      if (target === null) {
        return null;
      }
      const now = yield* DateTime.now;
      const aggregate = makeAggregateState({
        activeStates,
        terminalState: null,
        nowMs: now.epochMilliseconds,
      });
      return yield* apnsDeliveries.sendForTarget({
        target,
        aggregate,
        nowMs: now.epochMilliseconds,
        publishingEnvironmentId: null,
      });
    }),
    publish: Effect.fn("relay.agent_activity_publisher.publish")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.thread_id": input.threadId,
        "relay.agent_activity.phase": input.state?.phase ?? "deleted",
      });
      // Resolve recipients using the authenticated environment key before retaining any titles.
      const deliveryUsers = yield* links.listDeliveryUsersForEnvironment({
        environmentId: input.environmentId,
        environmentPublicKey: input.environmentPublicKey,
      });
      if (input.state && Option.isSome(teams)) {
        const owners = yield* links.listUsersForEnvironment({
          environmentId: input.environmentId,
          environmentPublicKey: input.environmentPublicKey,
          includeAllLinkedUsers: true,
        });
        for (const owner of owners) {
          const policy = yield* teams.value.policy(owner, input.environmentId).pipe(
            Effect.mapError(
              () =>
                new ManagedAccessUnavailable({
                  message: "Company activity publishing policy is temporarily unavailable.",
                }),
            ),
          );
          if (policy && (!policy.hasAccess || !policy.publishAgentActivity))
            return { ok: true, deliveries: [] };
        }
      }
      if (input.state) {
        // Terminal states are persisted too (pruned by the cron after they
        // age out) so a thread that finishes while other agents are active
        // stays visible as Done/Failed in subsequent aggregates instead of
        // silently vanishing from the Live Activity.
        yield* rows.upsert({
          environmentPublicKey: input.environmentPublicKey,
          state: input.state,
        });
      } else {
        yield* rows.remove({
          environmentId: input.environmentId,
          environmentPublicKey: input.environmentPublicKey,
          threadId: input.threadId,
        });
      }

      const now = yield* DateTime.now;
      const deliveriesByUser = yield* Effect.forEach(
        deliveryUsers,
        (deliveryUser) =>
          publishForDeliveryUser({
            deliveryUser,
            state: input.state,
            userPresent: input.userPresent === true,
            publishingEnvironmentId: input.environmentId,
            nowMs: now.epochMilliseconds,
          }),
        { concurrency: 4 },
      );
      const deliveries = deliveriesByUser.flat();
      return {
        ok: true,
        deliveries: deliveries.filter(
          (delivery): delivery is RelayDeliveryResult => delivery !== null,
        ),
      };
    }),
  });
});

export const layer = Layer.effect(AgentActivityPublisher, make);
