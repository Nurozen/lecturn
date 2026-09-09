import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { TestClock } from "effect/testing";
import type { BillingAccount } from "../billing/BillingStore.ts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  makeApnsDeliveryJobPayload,
  signApnsDeliveryJob,
  type SignedApnsDeliveryJob,
} from "./apnsDeliveryJobs.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import * as ApnsClient from "./ApnsClient.ts";
import {
  ManagedAccess,
  make as makeManagedAccess,
  ManagedAccessRequired,
  ManagedAccessUnavailable,
  layerDisabled,
} from "../billing/ManagedAccess.ts";
import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("not-a-private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-signing-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});

const apnsSigningKeyPair = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const signingConfig = RelayConfiguration.RelayConfiguration.of({
  ...config,
  apns: {
    ...config.apns,
    privateKey: Redacted.make(apnsSigningKeyPair.privateKey),
  },
});

const state: RelayAgentActivityState = {
  environmentId: "env" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/",
};

const aggregate: RelayAgentActivityAggregateState = {
  title: "Lecturn",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: state.updatedAt,
  activities: [
    {
      environmentId: state.environmentId,
      threadId: state.threadId,
      projectTitle: state.projectTitle,
      threadTitle: state.threadTitle,
      modelTitle: state.modelTitle,
      phase: state.phase,
      status: "Working",
      updatedAt: state.updatedAt,
      deepLink: state.deepLink,
    },
  ],
};

const enabledPreferences = JSON.stringify({
  liveActivitiesEnabled: true,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

const disabledPreferences = JSON.stringify({
  liveActivitiesEnabled: false,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

const notificationsDisabledPreferences = JSON.stringify({
  liveActivitiesEnabled: false,
  notificationsEnabled: false,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

const target: LiveActivities.TargetRow = {
  user_id: "dev:julius",
  device_id: "device-1",
  platform: "ios",
  ios_major_version: 18,
  app_version: "1.0.0",
  bundle_id: null,
  aps_environment: null,
  push_token: null,
  push_to_start_token: "start-token",
  preferences_json: enabledPreferences,
  activity_push_token: "activity-token",
  remote_start_queued_at: null,
  remote_started_at: "1970-01-01T00:00:00.000Z",
  ended_at: null,
  last_aggregate_json: null,
  last_live_activity_delivery_at: null,
};

function makeLayer(input: {
  readonly managedAccess?: ManagedAccess["Service"];
  readonly failCompletion?: boolean;
  readonly attempts: Array<DeliveryAttempts.DeliveryAttemptInput>;
  readonly sourceJobClaims?: ReadonlyMap<string, DeliveryAttempts.DeliverySourceJobClaimResult>;
  readonly queuedJobs?: Array<SignedApnsDeliveryJob>;
  readonly queuedStarts?: Array<
    Parameters<LiveActivities.LiveActivities["Service"]["markStartQueued"]>[0]
  >;
  readonly clearedStarts?: Array<
    Parameters<LiveActivities.LiveActivities["Service"]["clearStartQueued"]>[0]
  >;
  readonly markedDeliveries?: Array<
    Parameters<LiveActivities.LiveActivities["Service"]["markDelivery"]>[0]
  >;
  readonly invalidatedTokens?: Array<
    Parameters<LiveActivities.LiveActivities["Service"]["invalidateDeliveryToken"]>[0]
  >;
  readonly currentTargets?: ReadonlyArray<LiveActivities.TargetRow>;
  readonly config?: RelayConfiguration.RelayConfiguration["Service"];
  // Live agent-activity rows returned by delivery-time state rechecks.
  // Defaults to the fixture row so queued updates match unless a test is
  // explicitly exercising stale-state behavior.
  readonly activityStates?: ReadonlyArray<RelayAgentActivityState>;
  // Current per-thread rows used to reject queued updates/notifications that
  // have been superseded before APNs delivery.
  readonly currentActivityStates?: ReadonlyArray<RelayAgentActivityState>;
  readonly execute?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
}) {
  const completedJobs = new Set<string>();
  return ApnsDeliveries.layer.pipe(
    Layer.provide(ApnsClient.layer),
    Layer.provide(ApnsProviderTokens.layer),
    Layer.provide(ApnsDeliveryQueue.layer.pipe(Layer.provide(NodeCryptoLayer.layer))),
    Layer.provide(
      Layer.mergeAll(
        input.managedAccess ? Layer.succeed(ManagedAccess, input.managedAccess) : layerDisabled,
        Layer.succeed(AgentActivityRows.AgentActivityRows, {
          upsert: () => Effect.void,
          remove: () => Effect.void,
          pruneTerminal: () => Effect.void,
          listForUser: () =>
            input.activityStates !== undefined
              ? Effect.succeed([...input.activityStates])
              : Effect.succeed([state]),
          getForUserThread: ({ environmentId, threadId }) =>
            Effect.succeed(
              (input.currentActivityStates ?? input.activityStates ?? [state]).find(
                (current) =>
                  current.environmentId === environmentId && current.threadId === threadId,
              ) ?? null,
            ),
        } satisfies AgentActivityRows.AgentActivityRows["Service"]),
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
          send: (body) =>
            Effect.sync(() => {
              input.queuedJobs?.push(body);
            }),
        }),
        Layer.succeed(DeliveryAttempts.DeliveryAttempts, {
          record: (attempt) =>
            Effect.sync(() => {
              input.attempts.push(attempt);
            }),
          claimSourceJob: (attempt) =>
            Effect.sync(() => {
              if (completedJobs.has(attempt.sourceJobId)) return "completed";
              const claim = input.sourceJobClaims?.get(attempt.sourceJobId);
              if (claim) {
                return claim;
              }
              input.attempts.push(attempt);
              return "claimed";
            }),
          completeSourceJob: (completion) =>
            input.failCompletion
              ? Effect.fail(
                  new DeliveryAttempts.DeliveryAttemptRecordPersistenceError({
                    operation: "complete-source-job",
                    sourceJobId: completion.sourceJobId,
                    userId: null,
                    environmentId: null,
                    threadId: null,
                    deviceId: null,
                    kind: null,
                    cause: new Error("Database unavailable"),
                  }),
                )
              : Effect.sync(() => {
                  completedJobs.add(completion.sourceJobId);
                  const attempt = input.attempts.find(
                    (row) => row.sourceJobId === completion.sourceJobId,
                  );
                  if (attempt) {
                    Object.assign(attempt, completion);
                  }
                }),
        }),
        Layer.succeed(LiveActivities.LiveActivities, {
          register: () => Effect.void,
          listTargets: () => Effect.succeed(input.currentTargets ?? [target]),
          markStartQueued: (queued) =>
            Effect.sync(() => {
              input.queuedStarts?.push(queued);
            }),
          clearStartQueued: (cleared) =>
            Effect.sync(() => {
              input.clearedStarts?.push(cleared);
            }),
          markDelivery: (delivery) =>
            Effect.sync(() => {
              input.markedDeliveries?.push(delivery);
            }),
          invalidateDeliveryToken: (invalidated) =>
            Effect.sync(() => {
              input.invalidatedTokens?.push(invalidated);
            }),
        }),
        RelayConfiguration.layer(input.config ?? config),
        input.execute
          ? Layer.succeed(HttpClient.HttpClient, HttpClient.make(input.execute))
          : FetchHttpClient.layer,
      ),
    ),
  );
}

describe("ApnsDeliveries", () => {
  it.effect("never starts an activity remotely when no update token is registered", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const queuedStarts: Array<
      Parameters<LiveActivities.LiveActivities["Service"]["markStartQueued"]>[0]
    > = [];

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          activity_push_token: null,
          remote_started_at: null,
          ended_at: "1970-01-01T00:00:05.000Z",
        },
        aggregate,
        nowMs: 10_000,
      });

      // Activities are armed by the app in the foreground; the relay never
      // uses the push-to-start token, so the only fallback is the push
      // notification channel (none here: the aggregate is not an attention
      // phase).
      expect(result).toBeNull();
      expect(queuedJobs).toEqual([]);
      expect(queuedStarts).toEqual([]);
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs, queuedStarts })));
  });

  it.effect("ends the armed card when nothing remains to show", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      // Within the freshly-armed grace window an empty aggregate delivers
      // nothing: the environment's first publish may still be in flight.
      const graced = yield* deliveries.sendForTarget({
        target,
        aggregate: null,
        nowMs: 5_000,
      });
      expect(graced).toBeNull();

      const result = yield* deliveries.sendForTarget({
        target,
        aggregate: null,
        nowMs: 5_000 + 3 * 60 * 1_000,
      });

      // An armed card always shows content (live or recently finished work);
      // once the aggregate is empty the card ends rather than rendering an
      // empty state. The app re-arms on the next open with content.
      expect(result?.kind).toBe("live_activity_end");
      expect(result?.ok).toBe(true);
      expect(queuedJobs).toMatchObject([
        {
          payload: {
            kind: "live_activity_end",
            target: {
              token: "activity-token",
            },
          },
        },
      ]);
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect("does not queue a remote start when Live Activities are disabled", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          activity_push_token: null,
          remote_started_at: null,
          ended_at: null,
          preferences_json: disabledPreferences,
        },
        aggregate,
        nowMs: 5_000,
      });

      expect(result).toBeNull();
      expect(queuedJobs).toEqual([]);
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect("does not queue a duplicate remote start while a start is already queued", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          activity_push_token: null,
          remote_start_queued_at: "1970-01-01T00:00:03.000Z",
          remote_started_at: null,
          ended_at: null,
        },
        aggregate,
        nowMs: 5_000,
      });

      expect(result).toBeNull();
      expect(queuedJobs).toEqual([]);
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect("queues bounded Live Activity aggregate payloads", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const longTitle = "x".repeat(300);
    const inputAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      title: longTitle,
      subtitle: longTitle,
      activities: [0, 1, 2, 3, 4, 5].map((index) =>
        Object.assign({}, aggregate.activities[0]!, {
          projectTitle: longTitle,
          threadTitle: longTitle,
          modelTitle: longTitle,
          status: longTitle,
          threadId: `thread-${index}` as RelayAgentActivityState["threadId"],
          deepLink: "https://example.test/not-an-app-link",
        }),
      ),
    };

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.sendForTarget({
        target,
        aggregate: inputAggregate,
        nowMs: 10_000,
      });

      const payloadAggregate = queuedJobs[0]?.payload.aggregate;
      expect(payloadAggregate?.title.length).toBeLessThanOrEqual(120);
      expect(payloadAggregate?.subtitle.length).toBeLessThanOrEqual(120);
      expect(payloadAggregate?.activities).toHaveLength(5);
      expect(payloadAggregate?.activities[0]?.projectTitle.length).toBeLessThanOrEqual(120);
      expect(payloadAggregate?.activities[0]?.status.length).toBeLessThanOrEqual(40);
      expect(payloadAggregate?.activities[0]?.deepLink).toBe("/");
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect("queues Live Activity jobs with the device's APNs routing", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.sendForTarget({
        target: {
          ...target,
          bundle_id: "com.t3tools.t3code.preview",
          aps_environment: "production",
          ended_at: "1970-01-01T00:00:05.000Z",
        },
        aggregate,
        nowMs: 10_000,
      });

      expect(queuedJobs).toMatchObject([
        {
          payload: {
            kind: "live_activity_update",
            target: {
              token: "activity-token",
              bundleId: "com.t3tools.t3code.preview",
              apsEnvironment: "production",
            },
          },
        },
      ]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect("sends signed jobs to the device's APNs environment and bundle topic", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_update",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "activity-token",
      bundleId: "com.t3tools.t3code.preview",
      apsEnvironment: "sandbox",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-routing-1",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        requests.push(request);
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.ok).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://api.sandbox.push.apple.com/3/device/activity-token");
      expect(requests[0]?.headers["apns-topic"]).toBe(
        "com.t3tools.t3code.preview.push-type.liveactivity",
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect(
    "suppresses all deliveries when the aggregate is unchanged while a row awaits input",
    () => {
      const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
      const queuedJobs: Array<SignedApnsDeliveryJob> = [];
      const waitingAggregate: RelayAgentActivityAggregateState = {
        ...aggregate,
        activities: [
          {
            ...aggregate.activities[0]!,
            phase: "waiting_for_input",
            status: "Input",
          },
        ],
      };
      const waitingAggregateJson = JSON.stringify(waitingAggregate);

      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.sendForTarget({
          target: {
            ...target,
            // A registered alert token must not turn the suppressed Live
            // Activity update into an alert push on every republish.
            push_token: "apns-device-token",
            last_aggregate_json: waitingAggregateJson,
            last_live_activity_delivery_at: "1970-01-01T00:00:04.000Z",
          },
          aggregate: waitingAggregate,
          nowMs: 5_000,
        });

        expect(result).toBeNull();
        expect(queuedJobs).toEqual([]);
        expect(attempts).toEqual([]);
      }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
    },
  );

  it.effect(
    "queues an update inside the throttle window when a changed aggregate awaits input",
    () => {
      const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
      const queuedJobs: Array<SignedApnsDeliveryJob> = [];
      const waitingAggregate: RelayAgentActivityAggregateState = {
        ...aggregate,
        activities: [
          {
            ...aggregate.activities[0]!,
            phase: "waiting_for_input",
            status: "Input",
          },
        ],
      };
      const previousAggregateJson = JSON.stringify(aggregate);

      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.sendForTarget({
          target: {
            ...target,
            last_aggregate_json: previousAggregateJson,
            last_live_activity_delivery_at: "1970-01-01T00:00:04.000Z",
          },
          aggregate: waitingAggregate,
          nowMs: 5_000,
        });

        expect(result?.kind).toBe("live_activity_update");
        expect(queuedJobs).toMatchObject([
          {
            payload: {
              kind: "live_activity_update",
              target: {
                token: "activity-token",
              },
            },
          },
        ]);
      }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
    },
  );

  it.effect(
    "throttles updates for changed aggregates with stable counts and no pending attention",
    () => {
      const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
      const queuedJobs: Array<SignedApnsDeliveryJob> = [];
      const changedAggregate: RelayAgentActivityAggregateState = {
        ...aggregate,
        updatedAt: "1970-01-01T00:00:04.000Z",
      };
      const previousAggregateJson = JSON.stringify(aggregate);

      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.sendForTarget({
          target: {
            ...target,
            last_aggregate_json: previousAggregateJson,
            last_live_activity_delivery_at: "1970-01-01T00:00:04.000Z",
          },
          aggregate: changedAggregate,
          nowMs: 5_000,
        });

        expect(result).toBeNull();
        expect(queuedJobs).toEqual([]);
      }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
    },
  );

  it.effect("queues an end for an active Live Activity when Live Activities are disabled", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          preferences_json: disabledPreferences,
        },
        aggregate,
        nowMs: 5_000,
      });

      expect(result?.kind).toBe("live_activity_end");
      expect(queuedJobs).toMatchObject([
        {
          payload: {
            kind: "live_activity_end",
            target: {
              token: "activity-token",
            },
          },
        },
      ]);
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect(
    "queues an alert while ending an active Live Activity when only Live Activities are disabled",
    () => {
      const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
      const queuedJobs: Array<SignedApnsDeliveryJob> = [];
      const inputAggregate: RelayAgentActivityAggregateState = {
        ...aggregate,
        activities: [
          {
            ...aggregate.activities[0]!,
            phase: "waiting_for_input",
            status: "Input",
          },
        ],
      };

      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.sendForTarget({
          target: {
            ...target,
            push_token: "apns-device-token",
            preferences_json: disabledPreferences,
          },
          aggregate: inputAggregate,
          nowMs: 5_000,
        });

        expect(result?.kind).toBe("live_activity_end");
        expect(queuedJobs).toMatchObject([
          {
            payload: {
              kind: "live_activity_end",
              target: {
                token: "activity-token",
              },
            },
          },
          {
            payload: {
              kind: "push_notification",
              target: {
                token: "apns-device-token",
              },
              notification: {
                title: "Thread",
                body: "Input: Project",
                environmentId: "env",
                threadId: "thread",
                deepLink: "/",
                phase: "waiting_for_input",
                updatedAt: state.updatedAt,
              },
            },
          },
        ]);
        expect(attempts).toEqual([]);
      }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
    },
  );

  it.effect("does not queue alert pushes when notification permission is disabled", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const inputAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      activities: [
        {
          ...aggregate.activities[0]!,
          phase: "waiting_for_input",
          status: "Input",
        },
      ],
    };

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          push_token: "apns-device-token",
          preferences_json: notificationsDisabledPreferences,
        },
        aggregate: inputAggregate,
        nowMs: 5_000,
      });

      expect(result?.kind).toBe("live_activity_end");
      expect(queuedJobs).toMatchObject([
        {
          payload: {
            kind: "live_activity_end",
            target: {
              token: "activity-token",
            },
          },
        },
      ]);
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect(
    "queues a push notification for approval and input states when no Live Activity delivery is available",
    () => {
      const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
      const queuedJobs: Array<SignedApnsDeliveryJob> = [];
      const inputAggregate: RelayAgentActivityAggregateState = {
        ...aggregate,
        activities: [
          {
            ...aggregate.activities[0]!,
            phase: "waiting_for_input",
            status: "Input",
          },
        ],
      };

      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.sendForTarget({
          target: {
            ...target,
            push_token: "apns-device-token",
            push_to_start_token: null,
            activity_push_token: null,
            remote_started_at: null,
          },
          aggregate: inputAggregate,
          nowMs: 5_000,
        });

        expect(result?.kind).toBe("push_notification");
        expect(result?.ok).toBe(true);
        expect(queuedJobs).toMatchObject([
          {
            payload: {
              kind: "push_notification",
              target: {
                token: "apns-device-token",
              },
              notification: {
                title: "Thread",
                body: "Input: Project",
                environmentId: "env",
                threadId: "thread",
                deepLink: "/",
              },
            },
          },
        ]);
        expect(attempts).toEqual([]);
      }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
    },
  );

  it.effect("does not queue a push notification when a thread starts working", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          push_token: "apns-device-token",
          push_to_start_token: null,
          activity_push_token: null,
          remote_started_at: null,
        },
        aggregate,
        nowMs: 5_000,
      });

      expect(result).toBeNull();
      expect(queuedJobs).toEqual([]);
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect("queues bounded alert notification payloads", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const longTitle = "x".repeat(300);
    const inputAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      activities: [
        {
          ...aggregate.activities[0]!,
          projectTitle: longTitle,
          threadTitle: longTitle,
          phase: "waiting_for_input",
          status: "Input",
          deepLink: "https://example.test/not-an-app-link",
        },
      ],
    };

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.sendForTarget({
        target: {
          ...target,
          push_token: "apns-device-token",
          push_to_start_token: null,
          activity_push_token: null,
          remote_started_at: null,
        },
        aggregate: inputAggregate,
        nowMs: 5_000,
      });

      const notification = queuedJobs[0]?.payload.notification;
      expect(notification?.title.length).toBeLessThanOrEqual(120);
      expect(notification?.body.length).toBeLessThanOrEqual(120);
      expect(notification?.deepLink).toBe("/");
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect("preserves the schema cause for invalid queue payloads", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const error = yield* Effect.flip(deliveries.processSignedJob({ invalid: true }));

      expect(error).toMatchObject({
        _tag: "ApnsDeliveryJobQueuePayloadInvalid",
        receivedType: "object",
        message: "Invalid APNs delivery queue job with object payload.",
      });
      expect(error.cause).toMatchObject({ _tag: "SchemaError" });
    }).pipe(Effect.provide(makeLayer({ attempts })));
  });

  it.effect("skips a queued start when the user no longer has live work", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const clearedStarts: Array<
      Parameters<LiveActivities.LiveActivities["Service"]["clearStartQueued"]>[0]
    > = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_start",
      userId: target.user_id,
      deviceId: target.device_id,
      token: target.push_to_start_token ?? "start-token",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-start-1",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      // The start was decided from an aggregate that a newer terminal publish
      // has since invalidated; delivering it would birth an orphan activity.
      expect(result).toMatchObject({
        kind: "live_activity_start",
        ok: true,
        apnsStatus: null,
      });
      expect(attempts).toMatchObject([
        {
          kind: "live_activity_start",
          sourceJobId: "job-start-1",
          apnsReason: "Stale APNs start job skipped.",
        },
      ]);
      expect(clearedStarts).toMatchObject([{ userId: target.user_id, deviceId: target.device_id }]);
    }).pipe(Effect.provide(makeLayer({ attempts, clearedStarts, activityStates: [] })));
  });

  it.effect("processes signed jobs through APNs and records attempts", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const transportErrors: Array<ApnsDeliveries.ApnsDeliveryTransportError> = [];
    const logger = Logger.make(({ fiber }) => {
      const annotation = fiber.getRef(References.CurrentLogAnnotations).error;
      if (!Redacted.isRedacted(annotation)) {
        return;
      }
      const error = Redacted.value(annotation);
      if (ApnsDeliveries.isApnsDeliveryTransportError(error)) {
        transportErrors.push(error);
      }
    });
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_update",
      userId: target.user_id,
      deviceId: target.device_id,
      token: target.activity_push_token ?? "activity-token",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-1",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("live_activity_update");
      expect(result.ok).toBe(false);
      expect(attempts).toMatchObject([
        {
          kind: "live_activity_update",
          sourceJobId: "job-1",
          token: "activity-token",
        },
      ]);
      expect(transportErrors).toHaveLength(1);
      const error = transportErrors[0]!;
      expect(error).toMatchObject({
        deviceId: target.device_id,
        kind: "live_activity_update",
        sourceJobId: "job-1",
        apnsErrorTag: "ApnsJwtSigningError",
        requestStage: null,
      });
      expect(error.cause).toBeInstanceOf(ApnsClient.ApnsJwtSigningError);
      expect(error.cause).toMatchObject({
        teamId: "team-id",
        keyId: "key-id",
      });
      expect((error.cause as ApnsClient.ApnsJwtSigningError).cause).toBeDefined();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeLayer({ attempts }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("processes signed push notification jobs through APNs and records attempts", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "apns-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Input: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-1",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 })));

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("push_notification");
      expect(result.ok).toBe(true);
      expect(result.apnsStatus).toBe(200);
      expect(attempts).toMatchObject([
        {
          kind: "push_notification",
          sourceJobId: "job-push-1",
          token: "apns-device-token",
          environmentId: "env",
          threadId: "thread",
          deviceId: target.device_id,
          apnsStatus: 200,
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          currentTargets: [
            {
              ...target,
              push_token: "apns-device-token",
            },
          ],
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("skips duplicate signed queue jobs before calling APNs", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "apns-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Input: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-duplicate",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        executeCount += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result).toMatchObject({
        kind: "push_notification",
        ok: true,
        apnsStatus: null,
        apnsReason: "Duplicate APNs delivery job skipped.",
      });
      expect(executeCount).toBe(0);
      expect(attempts).toEqual([]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          sourceJobClaims: new Map([["job-push-duplicate", "completed"]]),
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("skips stale signed Live Activity jobs when the registered token changed", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_update",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "stale-activity-token",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-update-stale-token",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        executeCount += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result).toMatchObject({
        kind: "live_activity_update",
        ok: true,
        apnsStatus: null,
        apnsReason: "Stale APNs delivery job skipped.",
      });
      expect(executeCount).toBe(0);
      expect(attempts).toMatchObject([
        {
          kind: "live_activity_update",
          sourceJobId: "job-update-stale-token",
          token: "stale-activity-token",
          apnsReason: "Stale APNs delivery job skipped.",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("skips stale signed push notification jobs when the device token changed", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "stale-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Input: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-stale-token",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        executeCount += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result).toMatchObject({
        kind: "push_notification",
        ok: true,
        apnsStatus: null,
        apnsReason: "Stale APNs delivery job skipped.",
      });
      expect(executeCount).toBe(0);
      expect(attempts).toMatchObject([
        {
          kind: "push_notification",
          sourceJobId: "job-push-stale-token",
          token: "stale-device-token",
          apnsReason: "Stale APNs delivery job skipped.",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          currentTargets: [
            {
              ...target,
              push_token: "current-device-token",
            },
          ],
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("skips a queued Done Live Activity update after the thread resumes working", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const completedAt = "1970-01-01T00:00:01.000Z";
    const completedAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      activeCount: 0,
      updatedAt: completedAt,
      activities: [
        {
          ...aggregate.activities[0]!,
          phase: "completed",
          status: "Done",
          updatedAt: completedAt,
        },
      ],
    };
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_update",
      userId: target.user_id,
      deviceId: target.device_id,
      token: target.activity_push_token ?? "activity-token",
      aggregate: completedAggregate,
      alert: { title: "Thread", body: "Done: Project" },
      createdAt: completedAt,
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-update-superseded-by-running",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        executeCount += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result).toMatchObject({
        kind: "live_activity_update",
        ok: true,
        apnsStatus: null,
        apnsReason: "Stale APNs delivery job skipped.",
      });
      expect(executeCount).toBe(0);
      expect(attempts).toMatchObject([
        {
          sourceJobId: "job-update-superseded-by-running",
          apnsReason: "Stale agent activity state skipped.",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          activityStates: [
            {
              ...state,
              phase: "running",
              headline: "Running",
              updatedAt: "1970-01-01T00:00:02.000Z",
            },
          ],
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("skips a queued Done notification after the thread resumes working", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const completedAt = "1970-01-01T00:00:01.000Z";
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "apns-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Done: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
        phase: "completed",
        updatedAt: completedAt,
      },
      createdAt: completedAt,
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-superseded-by-running",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        executeCount += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result).toMatchObject({
        kind: "push_notification",
        ok: true,
        apnsStatus: null,
        apnsReason: "Stale APNs delivery job skipped.",
      });
      expect(executeCount).toBe(0);
      expect(attempts).toMatchObject([
        {
          sourceJobId: "job-push-superseded-by-running",
          apnsReason: "Stale agent activity state skipped.",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          currentTargets: [{ ...target, push_token: "apns-device-token" }],
          currentActivityStates: [
            {
              ...state,
              phase: "running",
              headline: "Running",
              updatedAt: "1970-01-01T00:00:02.000Z",
            },
          ],
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("retries signed queue jobs that are already claimed but not completed", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "apns-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Input: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-in-flight",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        executeCount += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* Effect.exit(deliveries.processSignedJob(signed));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("ApnsDeliveryJobClaimInFlight");
      }
      expect(executeCount).toBe(0);
      expect(attempts).toEqual([]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          sourceJobClaims: new Map([["job-push-in-flight", "in_flight"]]),
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("invalidates dead device push tokens after permanent APNs alert failures", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const invalidatedTokens: Array<
      Parameters<LiveActivities.LiveActivities["Service"]["invalidateDeliveryToken"]>[0]
    > = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "apns-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Failed: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-bad-token",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ reason: "BadDeviceToken" }, { status: 400 }),
        ),
      );

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("push_notification");
      expect(result.ok).toBe(false);
      expect(result.apnsStatus).toBe(400);
      expect(result.apnsReason).toBe("BadDeviceToken");
      expect(invalidatedTokens).toMatchObject([
        {
          userId: target.user_id,
          deviceId: target.device_id,
          kind: "push_notification",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          invalidatedTokens,
          currentTargets: [
            {
              ...target,
              push_token: "apns-device-token",
            },
          ],
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("clears queued start state when a start job fails in APNs", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const clearedStarts: Array<
      Parameters<LiveActivities.LiveActivities["Service"]["clearStartQueued"]>[0]
    > = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_start",
      userId: target.user_id,
      deviceId: target.device_id,
      token: target.push_to_start_token ?? "start-token",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-start-1",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("live_activity_start");
      expect(result.ok).toBe(false);
      expect(clearedStarts).toEqual([
        {
          userId: target.user_id,
          deviceId: target.device_id,
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          clearedStarts,
          activityStates: [{ ...state, updatedAt: "9999-01-01T00:00:00.000Z" }],
        }),
      ),
    );
  });

  it.effect("invalidates dead push-to-start tokens after permanent APNs start failures", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const invalidatedTokens: Array<
      Parameters<LiveActivities.LiveActivities["Service"]["invalidateDeliveryToken"]>[0]
    > = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_start",
      userId: target.user_id,
      deviceId: target.device_id,
      token: target.push_to_start_token ?? "start-token",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-start-bad-token",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ reason: "BadDeviceToken" }, { status: 400 }),
        ),
      );

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("live_activity_start");
      expect(result.ok).toBe(false);
      expect(result.apnsStatus).toBe(400);
      expect(result.apnsReason).toBe("BadDeviceToken");
      expect(invalidatedTokens).toMatchObject([
        {
          userId: target.user_id,
          deviceId: target.device_id,
          kind: "live_activity_start",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          invalidatedTokens,
          activityStates: [{ ...state, updatedAt: "9999-01-01T00:00:00.000Z" }],
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("invalidates dead Live Activity tokens after APNs unregisters them", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const invalidatedTokens: Array<
      Parameters<LiveActivities.LiveActivities["Service"]["invalidateDeliveryToken"]>[0]
    > = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_update",
      userId: target.user_id,
      deviceId: target.device_id,
      token: target.activity_push_token ?? "activity-token",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-update-unregistered",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ reason: "Unregistered" }, { status: 410 }),
        ),
      );

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("live_activity_update");
      expect(result.ok).toBe(false);
      expect(result.apnsStatus).toBe(410);
      expect(result.apnsReason).toBe("Unregistered");
      expect(invalidatedTokens).toMatchObject([
        {
          userId: target.user_id,
          deviceId: target.device_id,
          kind: "live_activity_update",
        },
      ]);
    }).pipe(
      Effect.provide(makeLayer({ attempts, invalidatedTokens, config: signingConfig, execute })),
    );
  });
});

describe("live activity alert decisions", () => {
  const preferences = {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  };

  const attentionRow = {
    ...aggregate.activities[0]!,
    threadId: "thread-2" as RelayAgentActivityState["threadId"],
    threadTitle: "Blocked thread",
    phase: "waiting_for_approval" as const,
    status: "Approval",
  };

  it("alerts when a thread newly enters an attention phase", () => {
    const alert = ApnsDeliveries.alertForAttentionTransition({
      previousAggregate: aggregate,
      nextAggregate: {
        ...aggregate,
        activeCount: 2,
        activities: [...aggregate.activities, attentionRow],
      },
      preferences,
    });
    expect(alert).toEqual({ title: "Blocked thread", body: "Approval: Project" });
  });

  it("stays silent when the attention phase was already delivered", () => {
    const withAttention = {
      ...aggregate,
      activeCount: 2,
      activities: [...aggregate.activities, attentionRow],
    };
    expect(
      ApnsDeliveries.alertForAttentionTransition({
        previousAggregate: withAttention,
        nextAggregate: withAttention,
        preferences,
      }),
    ).toBeNull();
  });

  it("stays silent without a delivered baseline so replays cannot buzz", () => {
    expect(
      ApnsDeliveries.alertForAttentionTransition({
        previousAggregate: null,
        nextAggregate: { ...aggregate, activities: [attentionRow] },
        preferences,
      }),
    ).toBeNull();
  });

  it("honors the per-event notification switch for attention alerts", () => {
    expect(
      ApnsDeliveries.alertForAttentionTransition({
        previousAggregate: aggregate,
        nextAggregate: {
          ...aggregate,
          activeCount: 2,
          activities: [...aggregate.activities, attentionRow],
        },
        preferences: { ...preferences, notifyOnApproval: false },
      }),
    ).toBeNull();
  });

  it("summarizes multiple newly blocked threads in one alert", () => {
    const secondAttentionRow = {
      ...attentionRow,
      threadId: "thread-3" as RelayAgentActivityState["threadId"],
      threadTitle: "Other blocked thread",
      phase: "waiting_for_input" as const,
      status: "Input",
    };
    const alert = ApnsDeliveries.alertForAttentionTransition({
      previousAggregate: aggregate,
      nextAggregate: {
        ...aggregate,
        activeCount: 3,
        activities: [...aggregate.activities, attentionRow, secondAttentionRow],
      },
      preferences,
    });
    expect(alert).toEqual({
      title: "2 agents need attention",
      body: "Blocked thread, Other blocked thread",
    });
  });

  it("alerts for a terminal aggregate and honors the completion switch", () => {
    const terminalAggregate = {
      ...aggregate,
      activeCount: 0,
      activities: [{ ...aggregate.activities[0]!, phase: "completed" as const, status: "Done" }],
    };
    expect(
      ApnsDeliveries.alertForTerminalAggregate({ aggregate: terminalAggregate, preferences }),
    ).toEqual({ title: "Thread", body: "Done: Project" });
    expect(
      ApnsDeliveries.alertForTerminalAggregate({
        aggregate: terminalAggregate,
        preferences: { ...preferences, notifyOnCompletion: false },
      }),
    ).toBeNull();
    expect(ApnsDeliveries.alertForTerminalAggregate({ aggregate: null, preferences })).toBeNull();
  });

  it("alerts when a previously active thread finishes mid-flight", () => {
    const doneRow = {
      ...aggregate.activities[0]!,
      phase: "completed" as const,
      status: "Done",
    };
    const next = {
      ...aggregate,
      activeCount: 0,
      activities: [attentionRow, doneRow],
    };
    expect(
      ApnsDeliveries.alertForNewlyTerminal({
        previousAggregate: aggregate,
        nextAggregate: next,
        preferences,
        nowMs: 0,
      }),
    ).toEqual({ title: "Thread", body: "Done: Project" });
    // The completion switch mutes it.
    expect(
      ApnsDeliveries.alertForNewlyTerminal({
        previousAggregate: aggregate,
        nextAggregate: next,
        preferences: { ...preferences, notifyOnCompletion: false },
        nowMs: 0,
      }),
    ).toBeNull();
    // No baseline means no transition to ring on.
    expect(
      ApnsDeliveries.alertForNewlyTerminal({
        previousAggregate: null,
        nextAggregate: next,
        preferences,
        nowMs: 0,
      }),
    ).toBeNull();
    // A Done row that was already terminal (or absent) before stays silent.
    expect(
      ApnsDeliveries.alertForNewlyTerminal({
        previousAggregate: next,
        nextAggregate: next,
        preferences,
        nowMs: 0,
      }),
    ).toBeNull();
    expect(
      ApnsDeliveries.alertForNewlyTerminal({
        previousAggregate: { ...aggregate, activities: [attentionRow] },
        nextAggregate: next,
        preferences,
        nowMs: 0,
      }),
    ).toBeNull();
  });
});

describe("paid recipient delivery", () => {
  const denied = () => Effect.fail(new ManagedAccessRequired({ message: "Subscription required" }));
  it.effect(
    "checks each recipient before enqueueing without suppressing another user's work",
    () => {
      const queuedJobs: SignedApnsDeliveryJob[] = [];
      const calls: string[] = [];
      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const unpaid = yield* deliveries.sendForTarget({ target, aggregate, nowMs: 0 });
        const paid = yield* deliveries.sendForTarget({
          target: { ...target, user_id: "paid-user" },
          aggregate,
          nowMs: 0,
        });
        expect(unpaid).toBeNull();
        expect(paid).not.toBeNull();
        expect(queuedJobs).toHaveLength(1);
        expect(calls).toEqual([target.user_id, "paid-user"]);
      }).pipe(
        Effect.provide(
          makeLayer({
            attempts: [],
            queuedJobs,
            managedAccess: {
              check: (id) => {
                calls.push(id);
                return id === "paid-user" ? Effect.void : denied();
              },
            },
          }),
        ),
      );
    },
  );
  it.effect("acknowledges a queued update after access expires without sending APNs", () => {
    const queuedJobs: SignedApnsDeliveryJob[] = [];
    let paid = true;
    let sends = 0;
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.sendForTarget({ target, aggregate, nowMs: 0 });
      paid = false;
      const result = yield* deliveries.processSignedJob(queuedJobs[0]!);
      expect(result.ok).toBe(true);
      expect(result.apnsStatus).toBeNull();
      expect(sends).toBe(0);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts: [],
          queuedJobs,
          managedAccess: { check: () => (paid ? Effect.void : denied()) },
          execute: (request) =>
            Effect.sync(() => {
              sends++;
              return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
            }),
        }),
      ),
    );
  });
  it.effect("database failure leaves queued work failed and unclaimed for retry", () => {
    const queuedJobs: SignedApnsDeliveryJob[] = [];
    const attempts: DeliveryAttempts.DeliveryAttemptInput[] = [];
    let unavailable = false;
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.sendForTarget({ target, aggregate, nowMs: 0 });
      unavailable = true;
      const result = yield* deliveries.processSignedJob(queuedJobs[0]!).pipe(Effect.flip);
      expect(result._tag).toBe("ManagedAccessUnavailable");
      expect(attempts).toEqual([]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          queuedJobs,
          managedAccess: {
            check: () =>
              unavailable
                ? Effect.fail(new ManagedAccessUnavailable({ message: "Database unavailable" }))
                : Effect.void,
          },
        }),
      ),
    );
  });
  it.effect("allows cleanup ends after expiry but drops companion paid pushes", () => {
    const queuedJobs: SignedApnsDeliveryJob[] = [];
    let sends = 0;
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.sendForTarget({
        target: { ...target, preferences_json: disabledPreferences, push_token: "push-token" },
        aggregate: {
          ...aggregate,
          activities: [
            { ...aggregate.activities[0]!, phase: "waiting_for_input", status: "Input" },
          ],
        },
        nowMs: 0,
      });
      expect(queuedJobs).toHaveLength(1);
      const result = yield* deliveries.processSignedJob(queuedJobs[0]!);
      expect(result.kind).toBe("live_activity_end");
      expect(result.ok).toBe(true);
      expect(sends).toBe(1);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts: [],
          queuedJobs,
          config: signingConfig,
          managedAccess: { check: denied },
          execute: (request) =>
            Effect.sync(() => {
              sends++;
              return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
            }),
        }),
      ),
    );
  });
});

describe("last-moment paid checks", () => {
  for (const unavailable of [false, true]) {
    it.effect(
      `rechecks push access immediately before dispatch (${unavailable ? "unavailable" : "expired"})`,
      () => {
        let checks = 0;
        let sends = 0;
        return Effect.gen(function* () {
          const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
          const task = deliveries.sendPushNotification({
            target,
            token: "push-token",
            notification: {
              title: "Thread",
              body: "Input",
              environmentId: "env",
              threadId: "thread",
              deepLink: "/",
            },
          });
          if (unavailable) {
            const failure = yield* task.pipe(Effect.flip);
            expect(failure._tag).toBe("ManagedAccessUnavailable");
          } else {
            expect((yield* task).ok).toBe(true);
          }
          expect(checks).toBe(2);
          expect(sends).toBe(0);
        }).pipe(
          Effect.provide(
            makeLayer({
              attempts: [],
              managedAccess: {
                check: () => {
                  checks++;
                  return checks === 1
                    ? Effect.void
                    : unavailable
                      ? Effect.fail(new ManagedAccessUnavailable({ message: "Unavailable" }))
                      : Effect.fail(new ManagedAccessRequired({ message: "Expired" }));
                },
              },
              execute: (request) =>
                Effect.sync(() => {
                  sends++;
                  return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
                }),
            }),
          ),
        );
      },
    );
  }
  it.effect(
    "strips an already-queued end alert during a billing outage but delivers cleanup",
    () => {
      let body = "";
      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.sendLiveActivity({
          target,
          token: "activity-token",
          kind: "live_activity_end",
          aggregate: null,
          alert: { title: "Paid alert", body: "Must not ring" },
        });
        expect(result.ok).toBe(true);
        expect(body).toContain('"event":"end"');
        expect(body).not.toContain('"alert"');
      }).pipe(
        Effect.provide(
          makeLayer({
            attempts: [],
            config: signingConfig,
            managedAccess: {
              check: () => Effect.fail(new ManagedAccessUnavailable({ message: "Unavailable" })),
            },
            execute: (request) =>
              Effect.sync(() => {
                if (request.body._tag === "Uint8Array")
                  body = new TextDecoder().decode(request.body.body);
                return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
              }),
          }),
        ),
      );
    },
  );
});

describe("durable subscription-denied receipts", () => {
  for (const kind of ["live_activity_update", "push_notification"] as const) {
    it.effect(`never sends a denied ${kind} duplicate after renewal`, () => {
      let paid = false;
      let sends = 0;
      const attempts: DeliveryAttempts.DeliveryAttemptInput[] = [];
      const payload = makeApnsDeliveryJobPayload({
        kind,
        userId: target.user_id,
        deviceId: target.device_id,
        token: kind === "push_notification" ? "push-token" : "activity-token",
        aggregate: kind === "live_activity_update" ? aggregate : null,
        notification:
          kind === "push_notification"
            ? {
                title: "Thread",
                body: "Input",
                environmentId: "env",
                threadId: "thread",
                deepLink: "/",
              }
            : null,
        createdAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-01T00:10:00.000Z",
        jobId: `denied-${kind}`,
      });
      const signed = signApnsDeliveryJob({ secret: config.apnsDeliveryJobSigningSecret, payload });
      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        expect((yield* deliveries.processSignedJob(signed)).ok).toBe(true);
        expect(attempts[0]?.apnsReason).toContain("access expired");
        paid = true;
        const duplicate = yield* deliveries.processSignedJob(signed);
        expect(duplicate.apnsReason).toContain("Duplicate");
        expect(sends).toBe(0);
      }).pipe(
        Effect.provide(
          makeLayer({
            attempts,
            config: signingConfig,
            currentTargets: [{ ...target, push_token: "push-token" }],
            managedAccess: {
              check: () =>
                paid ? Effect.void : Effect.fail(new ManagedAccessRequired({ message: "Expired" })),
            },
            execute: (request) =>
              Effect.sync(() => {
                sends++;
                return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
              }),
          }),
        ),
      );
    });
  }
  it.effect("retries a denied job if its terminal receipt cannot be persisted", () =>
    Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const failure = yield* deliveries
        .sendPushNotification({
          target,
          token: "push-token",
          sourceJobId: "denied-receipt-failed",
          notification: {
            title: "Thread",
            body: "Input",
            environmentId: "env",
            threadId: "thread",
            deepLink: "/",
          },
        })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("DeliveryAttemptRecordPersistenceError");
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts: [],
          failCompletion: true,
          managedAccess: {
            check: () => Effect.fail(new ManagedAccessRequired({ message: "Expired" })),
          },
        }),
      ),
    ),
  );
});

describe("queued delivery entitlement windows", () => {
  const accountForWindow = (userId: string, accessWindowStart: number): BillingAccount => ({
    user_id: userId,
    customer_id: "cus_window",
    deleted_at: null,
    generation: 10,
    updated_at: 60,
    lease_token: null,
    state: { accessWindowStart, accessUntil: 1000 },
  });
  const signedAtOrigin = (
    kind: "push_notification" | "live_activity_update" | "live_activity_end",
    userId = target.user_id,
  ) =>
    signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload: makeApnsDeliveryJobPayload({
        kind,
        userId,
        deviceId: target.device_id,
        token: kind === "push_notification" ? "push-token" : "activity-token",
        aggregate: kind === "push_notification" ? null : aggregate,
        notification:
          kind === "push_notification"
            ? {
                title: "Thread",
                body: "Input",
                environmentId: "env",
                threadId: "thread",
                deepLink: "/",
              }
            : null,
        alert: kind === "live_activity_end" ? { title: "Done", body: "Finished" } : null,
        createdAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-01T00:10:00.000Z",
        jobId: `window-${kind}-${userId}`,
      }),
    });

  for (const kind of ["push_notification", "live_activity_update"] as const) {
    for (const renewedAfterGap of [false, true]) {
      it.effect(
        `${kind} first delivery ${renewedAfterGap ? "drops after an access gap" : "survives continuous renewal"}`,
        () => {
          let sends = 0;
          const attempts: DeliveryAttempts.DeliveryAttemptInput[] = [];
          const accessWindowStart = renewedAfterGap ? 30 : 0;
          return Effect.gen(function* () {
            yield* TestClock.setTime(60_000);
            const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
            const job = signedAtOrigin(kind);
            const result = yield* deliveries.processSignedJob(job);
            expect(result.ok).toBe(true);
            expect(sends).toBe(renewedAfterGap ? 0 : 1);
            if (renewedAfterGap) {
              expect(attempts[0]?.apnsReason).toContain("access expired");
              yield* deliveries.processSignedJob(job);
              expect(sends).toBe(0);
            }
          }).pipe(
            Effect.provide(
              makeLayer({
                attempts,
                config: signingConfig,
                currentTargets: [{ ...target, push_token: "push-token" }],
                managedAccess: makeManagedAccess((userId) =>
                  Effect.succeed(accountForWindow(userId, accessWindowStart)),
                ),
                execute: (request) =>
                  Effect.sync(() => {
                    sends++;
                    return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
                  }),
              }),
            ),
          );
        },
      );
    }
  }

  it.effect("rechecks the original access window after claiming a job", () => {
    let loads = 0;
    let sends = 0;
    const attempts: DeliveryAttempts.DeliveryAttemptInput[] = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(60_000);
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.processSignedJob(signedAtOrigin("push_notification"));
      expect(loads).toBe(2);
      expect(sends).toBe(0);
      expect(attempts[0]?.apnsReason).toContain("access expired");
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          config: signingConfig,
          currentTargets: [{ ...target, push_token: "push-token" }],
          managedAccess: makeManagedAccess((userId) =>
            Effect.sync(() => {
              loads++;
              return accountForWindow(userId, loads === 1 ? 0 : 30);
            }),
          ),
          execute: (request) =>
            Effect.sync(() => {
              sends++;
              return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
            }),
        }),
      ),
    );
  });

  it.effect("only suppresses the expired recipient on a shared environment", () => {
    let sends = 0;
    return Effect.gen(function* () {
      yield* TestClock.setTime(60_000);
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.processSignedJob(signedAtOrigin("push_notification", "expired-recipient"));
      yield* deliveries.processSignedJob(
        signedAtOrigin("push_notification", "continuous-recipient"),
      );
      expect(sends).toBe(1);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts: [],
          config: signingConfig,
          currentTargets: [{ ...target, push_token: "push-token" }],
          managedAccess: makeManagedAccess((userId) =>
            Effect.succeed(accountForWindow(userId, userId === "expired-recipient" ? 30 : 0)),
          ),
          execute: (request) =>
            Effect.sync(() => {
              sends++;
              return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
            }),
        }),
      ),
    );
  });

  it.effect(
    "sends a cleanup end silently when its alert predates the current access window",
    () => {
      let body = "";
      return Effect.gen(function* () {
        yield* TestClock.setTime(60_000);
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        expect((yield* deliveries.processSignedJob(signedAtOrigin("live_activity_end"))).ok).toBe(
          true,
        );
        expect(body).toContain('"event":"end"');
        expect(body).not.toContain('"alert"');
      }).pipe(
        Effect.provide(
          makeLayer({
            attempts: [],
            config: signingConfig,
            managedAccess: makeManagedAccess((userId) =>
              Effect.succeed(accountForWindow(userId, 30)),
            ),
            execute: (request) =>
              Effect.sync(() => {
                if (request.body._tag === "Uint8Array")
                  body = new TextDecoder().decode(request.body.body);
                return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
              }),
          }),
        ),
      );
    },
  );

  it.effect("rollback bypasses window fencing without reading billing storage", () => {
    let sends = 0;
    return Effect.gen(function* () {
      yield* TestClock.setTime(60_000);
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      expect((yield* deliveries.processSignedJob(signedAtOrigin("push_notification"))).ok).toBe(
        true,
      );
      expect(sends).toBe(1);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts: [],
          config: signingConfig,
          currentTargets: [{ ...target, push_token: "push-token" }],
          execute: (request) =>
            Effect.sync(() => {
              sends++;
              return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
            }),
        }),
      ),
    );
  });
});
