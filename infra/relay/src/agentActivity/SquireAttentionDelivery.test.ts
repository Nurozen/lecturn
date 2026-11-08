import { EnvironmentId, ThreadId } from "@lecturn/contracts";
import { RelayAgentActivityState } from "@lecturn/contracts/relay";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { HttpClient } from "effect/http";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { layerDisabled } from "../billing/ManagedAccess.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as AgentActivityPublisher from "./AgentActivityPublisher.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import { makeAggregateState } from "./agentActivityAggregate.ts";
import * as ApnsClient from "./ApnsClient.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as FcmClient from "./FcmClient.ts";
import * as FcmDeliveries from "./FcmDeliveries.ts";
import * as FcmDeliveryQueueConsumer from "./FcmDeliveryQueueConsumer.ts";
import * as FcmDeliveryQueueSender from "./FcmDeliveryQueueSender.ts";
import * as LiveActivities from "./LiveActivities.ts";
import fixtureJson from "./squireAttention.fixture.json" with { type: "json" };

/**
 * D27 end to end: the payload sequence the server's Squire row publishes
 * (apps/server/src/relay/AgentAwarenessRelay.test.ts) buzzes each phone exactly when the Squire
 * first needs the user, through ingestion and real APNs and FCM delivery decisions; only the
 * network clients are fake.
 */

const SquireFixture = Schema.Struct({
  environmentId: Schema.String,
  scenarios: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        step: Schema.String,
        publishes: Schema.Array(
          Schema.Struct({
            threadId: Schema.String,
            state: Schema.NullOr(RelayAgentActivityState),
            userPresent: Schema.Boolean,
          }),
        ),
        mobile: Schema.Array(Schema.String),
      }),
    ),
  ),
});
const fixture = Schema.decodeUnknownSync(SquireFixture)(fixtureJson);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const preferences = encodeJson({
  liveActivitiesEnabled: true,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

const USER = "user";
const ENVIRONMENT_KEY = "environment-key";
const FIXTURE_START = Date.parse("2026-11-02T08:00:00.000Z");

/** Another agent's row: the card the phones last showed, and optionally still running. */
const background: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("other-environment"),
  threadId: ThreadId.make("other-thread"),
  projectTitle: "Other project",
  threadTitle: "Long build",
  phase: "running",
  headline: "Working",
  modelTitle: "Codex",
  updatedAt: "2026-11-02T07:59:00.000Z",
  deepLink: "/threads/other-environment/other-thread",
};

const deviceRow = (
  overrides: Partial<LiveActivities.TargetRow> & Pick<LiveActivities.TargetRow, "device_id">,
): LiveActivities.TargetRow => ({
  user_id: USER,
  platform: "ios",
  ios_major_version: 18,
  app_version: "1.0.0",
  bundle_id: "com.cloudgatherer.lecturn.dev",
  aps_environment: null,
  push_token: "apns-push-token",
  push_to_start_token: "apns-start-token",
  preferences_json: preferences,
  notified_push_events_json: null,
  activity_push_token: "apns-activity-token",
  remote_start_queued_at: null,
  remote_started_at: "2026-11-02T07:00:00.000Z",
  ended_at: null,
  // The delivered baseline: without one, a publish is a replay and never rings.
  last_aggregate_json: encodeJson(
    makeAggregateState({ activeStates: [background], terminalState: null, nowMs: FIXTURE_START }),
  ),
  last_live_activity_delivery_at: "2026-11-02T07:59:00.000Z",
  ...overrides,
});

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("unused"),
    bundleId: "com.cloudgatherer.lecturn.dev",
  },
  fcmServiceAccount: Redacted.make("configured"),
  apnsDeliveryJobSigningSecret: Redacted.make("job-signing-secret"),
  clerkSecretKey: Redacted.make("unused"),
  clerkPublishableKey: "unused",
  clerkJwtAudience: "unused",
  cloudMintPrivateKey: Redacted.make("unused"),
  cloudMintPublicKey: "unused",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});

/** One user with an iPhone and an Android phone, over stores held in memory. */
function harness(options: { readonly concurrent: boolean }) {
  const devices = new Map<string, LiveActivities.TargetRow>([
    ["iphone", deviceRow({ device_id: "iphone" })],
    [
      "android",
      deviceRow({
        device_id: "android",
        platform: "android",
        ios_major_version: null,
        push_token: "fcm-token",
        push_to_start_token: null,
        activity_push_token: null,
      }),
    ],
  ]);
  const states = new Map<string, RelayAgentActivityState>(
    options.concurrent ? [[`${background.environmentId}/${background.threadId}`, background]] : [],
  );
  const apnsJobs: Array<unknown> = [];
  const fcmJobs: Array<FcmDeliveries.FcmDeliveryJob> = [];
  const alerts = { ios: 0, android: 0 };

  const updateDevice = (deviceId: string, patch: Partial<LiveActivities.TargetRow>) =>
    Effect.sync(() => {
      const row = devices.get(deviceId);
      if (row) devices.set(deviceId, { ...row, ...patch });
    });

  const liveActivities = LiveActivities.LiveActivities.of({
    register: () => Effect.void,
    listTargets: () => Effect.sync(() => [...devices.values()]),
    listIdleArmedTargets: () => Effect.succeed([]),
    markDelivery: (input) =>
      updateDevice(input.deviceId, {
        last_aggregate_json: input.aggregate === null ? null : encodeJson(input.aggregate),
        last_live_activity_delivery_at: input.deliveredAt,
        // As the store does: a start or an end retires the update token.
        ...(input.kind === "live_activity_start" || input.kind === "live_activity_end"
          ? { activity_push_token: null }
          : {}),
        ...(input.kind === "live_activity_end" ? { ended_at: input.deliveredAt } : {}),
      }),
    withPushNotificationLock: (target, use) =>
      Effect.suspend(() => use(devices.get(target.device_id) ?? target)),
    markPushNotified: (input) =>
      updateDevice(input.deviceId, { notified_push_events_json: encodeJson(input.events) }),
    markStartQueued: (input) =>
      updateDevice(input.deviceId, { remote_start_queued_at: input.queuedAt }),
    clearStartQueued: (input) => updateDevice(input.deviceId, { remote_start_queued_at: null }),
    invalidateDeliveryToken: () => Effect.void,
  });

  const rows = AgentActivityRows.AgentActivityRows.of({
    upsert: (input) =>
      Effect.sync(() => {
        states.set(`${input.state.environmentId}/${input.state.threadId}`, input.state);
      }),
    remove: (input) =>
      Effect.sync(() => {
        states.delete(`${input.environmentId}/${input.threadId}`);
      }),
    pruneTerminal: () => Effect.void,
    listForUser: () => Effect.sync(() => [...states.values()]),
    getForUserThread: (input) =>
      Effect.sync(() => states.get(`${input.environmentId}/${input.threadId}`) ?? null),
  });

  const links = EnvironmentLinks.EnvironmentLinks.of({
    upsert: () => Effect.void,
    listUsersForEnvironment: () => Effect.succeed([USER]),
    listDeliveryUsersForEnvironment: () =>
      Effect.succeed([{ userId: USER, notificationsEnabled: true, liveActivitiesEnabled: true }]),
    listForUser: () => Effect.succeed([]),
    getForUser: (input) =>
      Effect.succeed({
        environmentId: EnvironmentId.make(input.environmentId),
        label: "Desktop",
        environmentPublicKey: ENVIRONMENT_KEY,
        linkedAt: "2026-11-01T00:00:00.000Z",
        endpoint: {
          httpBaseUrl: "https://env.test",
          wsBaseUrl: "wss://env.test",
          providerKind: "manual",
        },
      }),
    findActiveManagedForEnvironment: () => Effect.succeed([]),
    setHoldWebhooksWhileOffline: () => Effect.void,
    revokeForUser: () => Effect.succeed(false),
  });

  const attempts = DeliveryAttempts.DeliveryAttempts.of({
    record: () => Effect.void,
    claimSourceJob: () => Effect.succeed("claimed"),
    completeSourceJob: () => Effect.void,
  });

  const ok = { ok: true, status: 200, apnsId: "apns-id" } as const;
  // Real request builders; only the HTTP send is replaced, counting alerting pushes.
  const layerApnsClient = Layer.effect(
    ApnsClient.ApnsClient,
    Effect.map(ApnsClient.make, (real) =>
      ApnsClient.ApnsClient.of({
        ...real,
        sendLiveActivityRequest: ({ request }) =>
          Effect.sync(() => {
            const aps = (request.payload as { readonly aps: Record<string, unknown> }).aps;
            if ("alert" in aps) alerts.ios += 1;
            return ok;
          }),
        sendPushNotificationRequest: () =>
          Effect.sync(() => {
            alerts.ios += 1;
            return ok;
          }),
      }),
    ),
  ).pipe(
    Layer.provide(ApnsProviderTokens.layer),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("APNs must not be reached")),
      ),
    ),
  );

  const layerStores = Layer.mergeAll(
    NodeCryptoLayer.layer,
    RelayConfiguration.layer(config),
    layerDisabled,
    Layer.succeed(LiveActivities.LiveActivities, liveActivities),
    Layer.succeed(AgentActivityRows.AgentActivityRows, rows),
    Layer.succeed(EnvironmentLinks.EnvironmentLinks, links),
    Layer.succeed(DeliveryAttempts.DeliveryAttempts, attempts),
    Layer.succeed(RelayDb.RelayDb, {} as RelayDb.RelayDb["Service"]),
    Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
      send: (job) => Effect.sync(() => void apnsJobs.push(job)),
    }),
    Layer.succeed(FcmDeliveryQueueSender.FcmDeliveryQueueSender, {
      send: (job) => Effect.sync(() => void fcmJobs.push(job)),
    }),
    Layer.succeed(FcmClient.FcmClient, {
      send: (input) =>
        Effect.sync(() => {
          if (input.alert) alerts.android += 1;
          return { unregistered: false };
        }),
    }),
  );

  const layer = AgentActivityPublisher.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ApnsDeliveries.layer.pipe(
          Layer.provide(layerApnsClient),
          Layer.provide(ApnsDeliveryQueue.layer),
        ),
        FcmDeliveries.layer,
      ),
    ),
    Layer.provideMerge(layerStores),
  );

  /** Ingests one publish, then drains both delivery queues inline as their consumers would. */
  const ingest = (publish: (typeof fixture.scenarios)[string][number]["publishes"][number]) =>
    Effect.gen(function* () {
      const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
      const apns = yield* ApnsDeliveries.ApnsDeliveries;
      yield* publisher.publish({
        environmentId: fixture.environmentId,
        environmentPublicKey: ENVIRONMENT_KEY,
        threadId: publish.threadId,
        state: publish.state,
        userPresent: publish.userPresent,
      });
      while (apnsJobs.length > 0 || fcmJobs.length > 0) {
        for (const job of apnsJobs.splice(0)) yield* apns.processSignedJob(job);
        for (const job of fcmJobs.splice(0)) {
          let acked = false;
          yield* FcmDeliveryQueueConsumer.processMessage({
            id: "message",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            attempts: 1,
            body: job,
            ack: () => {
              acked = true;
            },
            retry: () => {},
          } as unknown as Cloudflare.Queues.Message<unknown>);
          expect(acked).toBe(true);
        }
      }
    });

  return { layer, ingest, alerts };
}

/** Alerts per step on each phone, after replaying a scenario from a fresh relay. */
const replay = (name: string, options: { readonly concurrent: boolean }) =>
  Effect.gen(function* () {
    const steps = fixture.scenarios[name];
    if (steps === undefined) return yield* Effect.die(`missing fixture scenario ${name}`);
    const h = harness(options);
    yield* TestClock.setTime(FIXTURE_START);
    return yield* Effect.gen(function* () {
      const perStep = [];
      for (const step of steps) {
        const before = { ...h.alerts };
        for (const publish of step.publishes) {
          if (publish.state !== null) {
            yield* TestClock.setTime(
              DateTime.toEpochMillis(DateTime.makeUnsafe(publish.state.updatedAt)),
            );
          }
          yield* h.ingest(publish);
        }
        perStep.push({
          step: step.step,
          ios: h.alerts.ios - before.ios,
          android: h.alerts.android - before.android,
          // The server's mobile delivery rows for the same step.
          alerted: step.mobile.filter((outcome) => outcome === "alerted").length,
        });
      }
      return perStep;
    }).pipe(Effect.provide(h.layer));
  });

const expectedAlerts = [
  ["cards", [1, 0, 0, 1]],
  ["notify", [1, 0, 1]],
  ["digests", [1]],
  ["digest push off", [0]],
  ["question alone", [0]],
  ["held then escalated", [0, 1]],
  ["opened before escalation", [0, 0, 0]],
  ["held FYI", [0, 0]],
] as const;

describe("Squire attention delivery (D27)", () => {
  it.effect.each(expectedAlerts)("%s alerts each phone %j", ([name, expected]) =>
    Effect.gen(function* () {
      const steps = yield* replay(name, { concurrent: false });
      expect(steps.map((step) => step.ios)).toEqual(expected);
      expect(steps.map((step) => step.android)).toEqual(expected);
      // Each buzz is the step the server recorded as `alerted`.
      expect(steps.map((step) => step.alerted)).toEqual(expected);
    }),
  );

  // With another agent's row on the card, an Android deletion job keeps its
  // old baseline (FcmDeliveries' acknowledgeAggregate), so a Squire row that
  // re-enters attention after its tombstone does not ring Android again.
  // Changing that needs a relay deploy; the iPhone rings as D27 says.
  it.effect.each(expectedAlerts)(
    "%s alerts an iPhone beside another agent %j",
    ([name, expected]) =>
      Effect.gen(function* () {
        const steps = yield* replay(name, { concurrent: true });
        expect(steps.map((step) => step.ios)).toEqual(expected);
      }),
  );

  it("publishes no row at all with Notify Off", () => {
    const steps = fixture.scenarios["notify off"] ?? [];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.flatMap((step) => step.publishes)).toEqual([]);
  });
});
