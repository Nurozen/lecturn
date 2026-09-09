import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Redacted from "effect/Redacted";
import { parseBillingConfig } from "./billing/BillingConfig.ts";
import { parseManagedGatewayConfig } from "./billing/ManagedGatewayConfig.ts";
import { makeManagedGatewayStore } from "./billing/ManagedGatewayStore.ts";
import { GATEWAY_ORIGIN_PATH, managedGatewayOriginHop } from "./billing/ManagedGateway.ts";
import {
  ManagedGateway,
  ManagedGatewayLive,
  ManagedGatewaySecret,
  gatewayHttpResponse,
  mutableGatewayBindingResponse,
} from "./environments/ManagedGatewayBinding.ts";
import { ManagedGatewayEnrollment } from "./environments/ManagedGatewayEnrollment.ts";
import * as ManagedReservations from "./billing/ManagedReservations.ts";
import * as ManagedAccess from "./billing/ManagedAccess.ts";
import * as BillingService from "./billing/BillingService.ts";
import { makeBillingStore } from "./billing/BillingStore.ts";
import { makeBillingOperations, clerkIdentityLookup } from "./billing/BillingOperations.ts";
import { makeManagedSuspensions } from "./billing/ManagedSuspensions.ts";
import { bindManagedSuspensionProvider } from "./environments/ManagedSuspensionBinding.ts";
import { billingRoutes } from "./http/BillingApi.ts";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";

import { RelayApi } from "@t3tools/contracts/relay";

import {
  clientApi,
  dpopClientApi,
  healthApi,
  metadataApi,
  mobileApi,
  relayClientAuthLayer,
  relayDpopClientAuthLayer,
  makeRelayCors,
  relayDocsRedirectRoute,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  serverApi,
  traceRelayHttpRequestWith,
  tokenApi,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./zone.ts";
import { relayStageSlug } from "./deploymentConfig.ts";
import { makeRelayTraceLayer, RelayObservability } from "./observability.ts";
import { reportBillingHealth, traceBillingMaintenance } from "./billing/BillingHealthTelemetry.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as RelayDb from "./db.ts";
import { RelayApnsDeliveryDeadLetterQueue, RelayApnsDeliveryQueue } from "./queues.ts";
import * as RelayConfiguration from "./Config.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";

const webcryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const httpPlatformNotSupportedLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

const relayApiLayer = Layer.mergeAll(
  healthApi,
  metadataApi,
  mobileApi,
  clientApi,
  tokenApi,
  dpopClientApi,
  serverApi,
);

const CloudMintKeyPair = Alchemy.KeyPair("CloudMintKeyPair");
const ApnsDeliveryJobSigningSecret = Alchemy.makeRandom("ApnsDeliveryJobSigningSecret", {
  bytes: 32,
});

class ManagedGatewayRuntime extends Context.Service<
  ManagedGatewayRuntime,
  {
    readonly store: Effect.Success<ReturnType<typeof makeManagedGatewayStore>>;
    readonly sync: (userId: string) => Effect.Effect<void, ManagedAccess.ManagedAccessUnavailable>;
  }
>()("t3code-relay/worker/ManagedGatewayRuntime") {}

export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}

export const ApiLive = Api.make(
  RelayDeploymentConfig.pipe(
    Effect.map(({ relayPublicDomain }) => ({
      main: import.meta.filename,
      compatibility: {
        date: "2026-05-22",
        flags: ["nodejs_compat"],
      },
      domain: relayPublicDomain,
    })),
    Effect.orDie,
  ),
  Effect.gen(function* () {
    //
    // 1. Provision Infrastructure for the Worker to use
    //
    const { relayPublicOrigin, stage } = yield* RelayDeploymentConfig;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const relayApiZone = yield* RelayApiZone;
    const managedEndpointZone = yield* ManagedEndpointZone;
    const randomApnsDeliveryJobSigningSecret = yield* ApnsDeliveryJobSigningSecret;
    const gatewayNamespace = yield* ManagedGateway;
    const randomGatewaySecret = yield* ManagedGatewaySecret;
    const observability = yield* RelayObservability;

    //
    // 2. Create bindings
    //
    const environment = yield* Config.schema(
      RelayConfiguration.ApnsEnvironment,
      "APNS_ENVIRONMENT",
    );
    const apnsTeamId = yield* Config.string("APNS_TEAM_ID");
    const apnsKeyId = yield* Config.string("APNS_KEY_ID");
    const apnsBundleId = yield* Config.string("APNS_BUNDLE_ID");
    const apnsPrivateKey = yield* Config.redacted("APNS_PRIVATE_KEY");
    const apnsDeliveryJobSigningSecret = yield* randomApnsDeliveryJobSigningSecret;
    const gatewaySecret = yield* randomGatewaySecret;
    const apnsDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(apnsDeliveryQueue);

    const axiomDatasetName = yield* observability.traces.name;
    const axiomIngestToken = yield* observability.workerIngestToken.token;
    const axiomTracesEndpoint = yield* observability.traces.otelTracesEndpoint;

    const clerkSecretKey = yield* Config.redacted("CLERK_SECRET_KEY");
    const clerkPublishableKey = yield* Config.string("CLERK_PUBLISHABLE_KEY");
    const clerkJwtAudience = yield* Config.string("CLERK_JWT_AUDIENCE");
    const billingMode = yield* Config.string("BILLING_MODE").pipe(Config.withDefault("disabled"));
    const billingCheckout = yield* Config.string("BILLING_CHECKOUT_ENABLED").pipe(
      Config.withDefault("false"),
    );
    const sandboxManagedAccess = yield* Config.string(
      "BILLING_SANDBOX_MANAGED_ACCESS_ENABLED",
    ).pipe(Config.withDefault("false"));
    const billingAppOrigin = yield* Config.string("BILLING_APP_ORIGIN").pipe(
      Config.withDefault("https://lecturn.cloudgatherer.net"),
    );
    const billingGrace = yield* Config.string("BILLING_RENEWAL_GRACE_SECONDS").pipe(
      Config.withDefault("0"),
    );
    const stripeSecret = yield* Config.redacted("STRIPE_SECRET_KEY").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const stripeWebhook = yield* Config.redacted("STRIPE_WEBHOOK_SECRET").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const clerkBillingWebhook = yield* Config.redacted("CLERK_BILLING_WEBHOOK_SECRET").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const monthlyPrice = yield* Config.string("STRIPE_MONTHLY_PRICE_ID").pipe(
      Config.withDefault(""),
    );
    const annualPrice = yield* Config.string("STRIPE_ANNUAL_PRICE_ID").pipe(Config.withDefault(""));
    const portalConfiguration = yield* Config.string("STRIPE_PORTAL_CONFIGURATION_ID").pipe(
      Config.withDefault(""),
    );
    const billingExtra = yield* Effect.all(
      Object.fromEntries(
        [
          "STRIPE_LIVEMODE",
          "STRIPE_ACCOUNT_ID",
          "BILLING_PRODUCTION_READY",
          "BILLING_SUSPENSION_ENABLED",
          "BILLING_AUTOMATIC_TAX",
          "BILLING_ALLOWED_COUNTRIES",
          "BILLING_COUNTRY_POLICY",
          "BILLING_COUNTRY_RESTRICTION_VERIFIED",
          "BILLING_ENFORCEMENT_USERS",
          "BILLING_CHECKOUT_USERS",
        ].map((key) => [key, Config.string(key).pipe(Config.withDefault(""))]),
      ),
    );
    const identityReconciliation = yield* Config.boolean(
      "BILLING_IDENTITY_RECONCILIATION_ENABLED",
    ).pipe(Config.withDefault(false));
    const billingConfig = yield* Effect.try(() =>
      parseBillingConfig({
        ...Object.fromEntries(Object.entries(billingExtra).filter(([, value]) => value !== "")),
        BILLING_MODE: billingMode,
        BILLING_SANDBOX_MANAGED_ACCESS_ENABLED: sandboxManagedAccess,
        BILLING_CHECKOUT_ENABLED: billingCheckout,
        BILLING_APP_ORIGIN: billingAppOrigin,
        BILLING_RENEWAL_GRACE_SECONDS: billingGrace,
        STRIPE_SECRET_KEY: Redacted.value(stripeSecret),
        STRIPE_WEBHOOK_SECRET: Redacted.value(stripeWebhook),
        STRIPE_MONTHLY_PRICE_ID: monthlyPrice,
        STRIPE_ANNUAL_PRICE_ID: annualPrice,
        STRIPE_PORTAL_CONFIGURATION_ID: portalConfiguration,
      }),
    ).pipe(Effect.orDie);
    const gatewayFlags = yield* Effect.all(
      Object.fromEntries(
        [
          "MANAGED_GATEWAY_ENABLED",
          "MANAGED_GATEWAY_ORIGIN_GUARD_VERIFIED",
          "MANAGED_GATEWAY_ROUTE_VERIFIED",
        ].map((name) => [name, Config.string(name).pipe(Config.withDefault("false"))]),
      ),
    );
    const gatewayConfig = yield* Effect.try(() =>
      parseManagedGatewayConfig(gatewayFlags, billingConfig, stage),
    ).pipe(Effect.orDie);
    if (billingConfig.checkoutEnabled && !Redacted.value(clerkBillingWebhook)) {
      return yield* Effect.die(
        "Checkout requires a dedicated Clerk billing lifecycle webhook secret",
      );
    }
    if (stage === "prod" && billingConfig.mode !== "disabled" && !billingConfig.livemode) {
      return yield* Effect.die("Sandbox billing must use an isolated relay stage and database");
    }

    if (stage !== "prod" && billingConfig.livemode)
      return yield* Effect.die("Live Stripe resources require the production stage");
    if (
      billingConfig.mode !== "disabled" &&
      !Redacted.value(clerkSecretKey).startsWith(billingConfig.livemode ? "sk_live_" : "sk_test_")
    )
      return yield* Effect.die("Clerk and Stripe environment mismatch");

    const cloudMintPrivateKey = yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* cloudMintKeyPair.publicKey;
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(yield* RelayDb.RelayHyperdrive);
    const db = yield* Drizzle.Postgres(hyperdrive.connectionString);

    const managedEndpointTunnelBinding = yield* Cloudflare.Tunnel.ReadWriteTunnel();
    const suspensionProvider = yield* bindManagedSuspensionProvider;
    // Keep Worker custom-domain reconciliation ordered after API zone provisioning.
    yield* yield* relayApiZone.zoneId;
    const managedEndpointDnsBinding = yield* Cloudflare.DNS.ReadWriteDns(managedEndpointZone);
    const managedEndpointZoneName = yield* managedEndpointZone.name;

    //
    // 3. Runtime layers and app construction
    //
    const alchemyRuntimeContext: Alchemy.BaseRuntimeContext = yield* Cloudflare.Worker;

    const gatewayUnavailable = () =>
      new ManagedAccess.ManagedAccessUnavailable({
        message: "Managed gateway state is unavailable. Retry shortly.",
      });
    const gatewayRuntimeLayer = Layer.effect(
      ManagedGatewayRuntime,
      Effect.gen(function* () {
        const store = yield* makeManagedGatewayStore({
          ...gatewayConfig,
          stage,
          baseDomain: yield* managedEndpointZoneName,
        });
        const sync = (userId: string) =>
          Effect.gen(function* () {
            const snapshot = yield* store.capture(userId);
            yield* gatewayNamespace.getByName(userId).update(snapshot);
          }).pipe(
            Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            Effect.timeout("5 seconds"),
            Effect.catchCause(() => Effect.fail(gatewayUnavailable())),
          );
        return { store, sync };
      }).pipe(Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext)),
    );
    // Keep the adapter installed when enrollment is disabled so existing gateway allocations
    // can be closed and removed, and can never silently downgrade to direct tunnels.
    const gatewayEnrollmentLayer = Layer.effect(
      ManagedGatewayEnrollment,
      Effect.gen(function* () {
        const { store, sync } = yield* ManagedGatewayRuntime;
        const available = <A, E>(effect: Effect.Effect<A, E>) =>
          effect.pipe(Effect.mapError(gatewayUnavailable));
        const mappingFor = (userId: string, environmentId: string) =>
          available(store.get(userId, environmentId)).pipe(
            Effect.map((mapping) =>
              mapping ? { ...mapping, originDnsRecordId: mapping.originDnsRecordId ?? null } : null,
            ),
          );
        return ManagedGatewayEnrollment.of({
          enabledFor: (userId) =>
            Effect.succeed(
              gatewayConfig.enabled &&
                (gatewayConfig.enforcementUsers.includes("*") ||
                  gatewayConfig.enforcementUsers.includes(userId)),
            ),
          get: ({ userId, environmentId }) => mappingFor(userId, environmentId),
          registerPending: (input) =>
            available(store.registerPending(input)).pipe(
              Effect.map((mapping) => ({
                ...mapping,
                originDnsRecordId: mapping.originDnsRecordId ?? null,
              })),
            ),
          recordOriginDns: (input) => available(store.recordOriginDns(input)),
          checkpointAllocation: (input) => available(store.checkpointAllocation(input)),
          markReady: (input) =>
            Effect.gen(function* () {
              const mapping = yield* mappingFor(input.userId, input.environmentId);
              if (!mapping || mapping.deleting || mapping.generation !== input.generation)
                return false;
              return yield* available(store.markReady(mapping));
            }),
          pause: (input) =>
            available(store.pause(input)).pipe(Effect.map((mapping) => mapping !== undefined)),
          remove: (input) =>
            Effect.gen(function* () {
              const mapping = yield* mappingFor(input.userId, input.environmentId);
              if (!mapping || mapping.generation !== input.generation) return false;
              return (
                (yield* available(
                  store.remove(
                    input.userId,
                    input.environmentId,
                    mapping.originHostname,
                    input.generation,
                  ),
                )) !== undefined
              );
            }),
          finalizeRemove: (input) => available(store.finalizeRemove(input)),
          sync,
        });
      }),
    );

    const loadSettings = Effect.gen(function* () {
      return RelayConfiguration.RelayConfiguration.of({
        relayIssuer: relayPublicOrigin,
        apns: {
          environment,
          teamId: apnsTeamId,
          keyId: apnsKeyId,
          bundleId: apnsBundleId,
          privateKey: apnsPrivateKey,
        },
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        clerkSecretKey,
        clerkPublishableKey,
        clerkJwtAudience,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        managedEndpointBaseDomain: yield* managedEndpointZoneName,
        managedEndpointNamespace: stage,
      });
    });

    const relayTraceLayer = Layer.unwrap(
      Effect.all({
        tracesDatasetName: axiomDatasetName,
        tracesEndpoint: axiomTracesEndpoint,
        ingestToken: axiomIngestToken,
      }).pipe(Effect.map(makeRelayTraceLayer)),
    );

    const runtimeLayer = Layer.empty.pipe(
      Layer.provideMerge(
        Layer.merge(BillingService.layer(billingConfig), MobileRegistrations.layer),
      ),
      Layer.provideMerge(AgentActivityPublisher.layer),
      Layer.provideMerge(EnvironmentConnector.layer),
      Layer.provideMerge(EnvironmentLinker.layer),
      Layer.provideMerge(EnvironmentPublishSignatures.layer),
      Layer.provideMerge(
        ManagedEndpointProvider.layerCloudflareBindings(
          managedEndpointTunnelBinding,
          managedEndpointDnsBinding,
          alchemyRuntimeContext,
        ).pipe(Layer.provideMerge(gatewayEnrollmentLayer), Layer.provideMerge(gatewayRuntimeLayer)),
      ),
      Layer.provideMerge(DpopProofs.layer),
      Layer.provideMerge(ApnsDeliveries.layer),
      Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
      Layer.provideMerge(
        ApnsDeliveryQueue.layerCloudflareQueues(apnsDeliveryQueueSender, alchemyRuntimeContext),
      ),
      Layer.provideMerge(AgentActivityRows.layer),
      Layer.provideMerge(Devices.layer),
      Layer.provideMerge(EnvironmentCredentials.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          EnvironmentLinks.layer,
          ManagedEndpointAllocations.layer,
          ManagedTunnelLimits.layer,
          ManagedAccess.layer(
            billingConfig.mode !== "disabled",
            billingConfig.mode === "enforce" ? billingConfig.enforcementUsers : undefined,
            billingConfig.managedAccessEnabled === true,
          ),
          ManagedReservations.layer({
            enabled: billingConfig.managedAccessEnabled === true,
            enforcementUsers:
              billingConfig.mode === "enforce" ? billingConfig.enforcementUsers : undefined,
          }),
        ),
      ),
      Layer.provideMerge(LiveActivities.layer),
      Layer.provideMerge(DeliveryAttempts.layer),
      Layer.provideMerge(RelayTokens.layer),
      Layer.provideMerge(
        RelayDb.RelayTransactions.layer.pipe(
          Layer.provideMerge(Layer.succeed(RelayDb.RelayDb, db)),
        ),
      ),
      Layer.provideMerge(Layer.effect(RelayConfiguration.RelayConfiguration, loadSettings)),
      Layer.provideMerge(webcryptoLayer),
    );

    const appLayer = relayApiLayer.pipe(
      Layer.provideMerge(relayClientAuthLayer),
      Layer.provideMerge(relayDpopClientAuthLayer),
      Layer.provideMerge(relayEnvironmentAuthLayer),
      Layer.provide(runtimeLayer),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      apnsDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "5 seconds",
        retryDelay: "30 seconds",
        deadLetterQueue: apnsDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.apn_delivery_queue.process_batch"),
          Stream.runForEach((message) =>
            ApnsDeliveries.ApnsDeliveries.pipe(
              Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
              Effect.withSpan("relay.apn_delivery_queue.process_message"),
            ),
          ),
          Effect.provide(runtimeLayer),
        ),
    );

    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      DpopProofs.DpopProofReplay.pipe(
        Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
        // Terminal thread rows are kept briefly so finished agents show as
        // Done/Failed in the Live Activity; sweep them once they age out.
        Effect.andThen(
          Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
            Effect.flatMap(([activityRows, now]) =>
              activityRows.pruneTerminal({
                updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
              }),
            ),
          ),
        ),
        Effect.withSpan("relay.cron.prune_expired_state"),
        Effect.provide(runtimeLayer),
      ),
    );

    if (billingConfig.mode !== "disabled") {
      yield* Cloudflare.Workers.cron("* * * * *", () =>
        Effect.gen(function* () {
          const store = yield* makeBillingStore;
          const operations = yield* makeBillingOperations({
            store,
            identity: clerkIdentityLookup(Redacted.value(clerkSecretKey)),
          });
          const billing = yield* BillingService.BillingService;
          const tasks = [
            billing.processPending(20).pipe(
              Effect.timeout("45 seconds"),
              Effect.catch(() => Effect.logWarning("Billing provider reconciliation deferred")),
            ),
            reportBillingHealth(operations.health()),
          ];
          if (identityReconciliation)
            tasks.push(operations.reconcileIdentities(5).pipe(Effect.asVoid));
          if (billingConfig.suspensionEnabled) {
            const suspensions = yield* makeManagedSuspensions({
              enabled: () =>
                Effect.succeed(
                  billingConfig.mode === "enforce" && billingConfig.suspensionEnabled === true,
                ),
              enforcementUsers: billingConfig.enforcementUsers,
              provider: suspensionProvider(alchemyRuntimeContext),
            });
            tasks.push(
              suspensions.drain().pipe(
                Effect.timeout("50 seconds"),
                Effect.catch(() => Effect.logWarning("Billing suspension drain deferred")),
              ),
            );
          }
          // Independent deadlines keep provider outages from starving cutoff and health reporting.
          yield* Effect.all(
            tasks.map((task) =>
              task.pipe(
                Effect.catch(() =>
                  Effect.logWarning("An independent billing maintenance task failed"),
                ),
              ),
            ),
            { concurrency: "unbounded", discard: true },
          );
        }).pipe(Effect.provide(runtimeLayer), (maintenance) =>
          traceBillingMaintenance(maintenance, relayTraceLayer),
        ),
      );
    }

    // Always reconcile existing objects, including after billing/enrollment is disabled.
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      Effect.gen(function* () {
        const { store, sync } = yield* ManagedGatewayRuntime;
        const users = yield* store.claimDue(20);
        yield* Effect.forEach(
          users,
          (userId) =>
            sync(userId).pipe(
              Effect.catch(() => Effect.logWarning("Managed gateway reconciliation deferred")),
            ),
          { concurrency: 4, discard: true },
        );
      }).pipe(
        Effect.timeout("45 seconds"),
        Effect.catchCause(() => Effect.logWarning("Managed gateway maintenance deferred")),
        Effect.withSpan("relay.gateway.reconcile"),
        Effect.provide(runtimeLayer),
      ),
    );

    const fetch = Layer.merge(
      Layer.mergeAll(
        HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
          Layer.provide(appLayer),
        ),
        HttpApiScalar.layer(RelayApi, { path: "/docs" }),
        relayDocsRedirectRoute,
        billingRoutes(billingConfig, Redacted.value(clerkBillingWebhook)).pipe(
          Layer.provide(runtimeLayer),
        ),
      ).pipe(
        Layer.provide([
          Etag.layerWeak,
          httpPlatformNotSupportedLayer,
          makeRelayCors(billingConfig.appOrigin),
        ]),
      ),
      relayNotFoundRoute,
    ).pipe(
      HttpRouter.toHttpEffect,
      withoutCapturedParentSpan,
      Effect.flatMap((httpEffect) =>
        traceRelayHttpRequestWith(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const webRequest = yield* HttpServerRequest.toWeb(request);
            const url = new URL(webRequest.url);
            const baseDomain = yield* managedEndpointZoneName;
            const managedHostname = url.hostname.endsWith(`.${baseDomain}`);
            const originHop = url.pathname === GATEWAY_ORIGIN_PATH;
            const gatewaySuffix = `-g-${relayStageSlug(stage)}.${baseDomain}`;
            const gatewayHostname =
              managedHostname &&
              (url.hostname.endsWith(gatewaySuffix) ||
                url.hostname.startsWith("g-") ||
                /-g-[a-z0-9-]+\./.test(url.hostname));
            if (managedHostname && url.hostname.startsWith("gw-origin-"))
              return HttpServerResponse.text("Forbidden", { status: 403 });
            if (!originHop && !gatewayHostname) return yield* httpEffect;
            return yield* Effect.gen(function* () {
              if (originHop) {
                const secret = Redacted.value(yield* gatewaySecret);
                const response = yield* Effect.tryPromise(() =>
                  managedGatewayOriginHop(webRequest, {
                    secret,
                    originSuffix: baseDomain,
                    fetch: globalThis.fetch,
                  }),
                );
                return gatewayHttpResponse(response);
              }
              if (
                !url.hostname.endsWith(gatewaySuffix) ||
                !/^[a-f0-9]{16}$/.test(url.hostname.slice(0, -gatewaySuffix.length)) ||
                url.protocol !== "https:" ||
                url.port
              )
                return HttpServerResponse.text("Unknown managed environment", { status: 404 });
              return yield* Effect.gen(function* () {
                const { store, sync } = yield* ManagedGatewayRuntime;
                const mapping = yield* store.lookupPublicHostname(url.hostname);
                if (!mapping)
                  return HttpServerResponse.text("Unknown managed environment", { status: 404 });
                yield* sync(mapping.userId);
                return mutableGatewayBindingResponse(
                  yield* gatewayNamespace.getByName(mapping.userId).fetch(request),
                );
              }).pipe(Effect.provide(runtimeLayer));
            }).pipe(
              Effect.catchCause(() =>
                Effect.succeed(
                  HttpServerResponse.text("Managed connection unavailable", { status: 503 }),
                ),
              ),
            );
          }).pipe(Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext)),
          relayTraceLayer,
        ),
      ),
    );

    return { fetch };
  }).pipe(
    Effect.provide(
      Layer.empty.pipe(
        Layer.provideMerge(Cloudflare.Hyperdrive.ConnectBinding),
        Layer.provideMerge(Cloudflare.Workers.CronEventSourceLive),
        Layer.provideMerge(Cloudflare.Queues.WriteQueueBinding),
        Layer.provideMerge(Cloudflare.Queues.EventSourceLive),
        Layer.provideMerge(Cloudflare.Tunnel.ReadWriteTunnelBinding),
        Layer.provideMerge(Cloudflare.DNS.ReadWriteDnsHttp),
        Layer.provideMerge(ManagedGatewayLive),
      ),
    ),
  ),
);

export default ApiLive;
