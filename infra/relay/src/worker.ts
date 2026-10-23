import { extensionsLayer, ExtensionsService } from "./extensions/ExtensionsService.ts";
import { extensionsApi } from "./http/ExtensionsApi.ts";
import {
  registerExtensionEvaluatorBinding,
  EXTENSIONS_EVALUATOR_BINDING,
} from "./extensions/ExtensionsEvaluatorBinding.ts";
import type { ExtensionEvaluatorBinding } from "./extensions/ExtensionsEvaluatorClient.ts";
import { extensionEnvironmentKeys, parseExtensionsConfig } from "./extensions/ExtensionsConfig.ts";
import { parseDecisionsConfig } from "./decisions/DecisionsConfig.ts";
import { DecisionsService, decisionsLayer } from "./decisions/DecisionsService.ts";
import { decisionsApi } from "./http/DecisionsApi.ts";
import * as EnvironmentRelinks from "./environments/EnvironmentRelinks.ts";
import { TeamStore, makeTeamStore, TeamError } from "./teams/TeamStore.ts";
import { TeamDirectory, makeTeamDirectory } from "./teams/TeamDirectory.ts";
import { TeamRuntime } from "./teams/TeamRuntime.ts";
import {
  TeamBillingService,
  makeTeamBillingService,
  makeTeamBillingRepository,
} from "./teams/TeamBillingService.ts";
import { createTeamStripeClient } from "./teams/TeamStripeClient.ts";
import { teamsRoutes, TeamGatewaySync } from "./http/TeamsApi.ts";
import {
  ManagedGatewayHttpClient,
  makeManagedGatewayHttpClient,
} from "./environments/ManagedGatewayHttpClient.ts";
import * as HttpClient from "effect/http/HttpClient";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle/Postgres";
import * as Config from "effect/Config";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
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
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiScalar from "effect/http-api/HttpApiScalar";

import { RelayApi } from "@lecturn/contracts/relay";

import {
  RELAY_HTTP_ROUTER_CONFIG,
  traceRelayHttpRequestWith,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import * as RelayHttpApi from "./http/Api.ts";
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
import {
  RelayApnsDeliveryDeadLetterQueue,
  RelayApnsDeliveryQueue,
  RelayFcmDeliveryQueue,
  RelayFcmDeliveryDeadLetterQueue,
} from "./queues.ts";
import * as WebCrypto from "./WebCrypto.ts";
import * as FcmAssertionSigner from "./agentActivity/FcmAssertionSigner.ts";
import * as FcmClient from "./agentActivity/FcmClient.ts";
import * as FcmDeliveryQueueSender from "./agentActivity/FcmDeliveryQueueSender.ts";
import * as FcmDeliveries from "./agentActivity/FcmDeliveries.ts";
import * as FcmDeliveryQueueConsumer from "./agentActivity/FcmDeliveryQueueConsumer.ts";
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
import * as ManagedEndpointReaper from "./environments/ManagedEndpointReaper.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";
import * as HookForwarder from "./hooks/HookForwarder.ts";
import * as HeldHooks from "./hooks/HeldHooks.ts";
import * as HookInbox from "./hooks/HookInbox.ts";
import * as HookInboxObject from "./hooks/HookInboxObject.ts";

const layerWebcrypto = Layer.succeed(
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

const layerHttpPlatformNotSupported = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

const layerRelayApi = Layer.mergeAll(
  RelayHttpApi.layerHealthApi,
  RelayHttpApi.layerMetadataApi,
  RelayHttpApi.layerMobileApi,
  RelayHttpApi.layerClientApi,
  RelayHttpApi.layerTokenApi,
  RelayHttpApi.layerDpopClientApi,
  RelayHttpApi.layerServerApi,
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
>()("lecturn-relay/worker/ManagedGatewayRuntime") {}

export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}

export const layer = Api.make(
  RelayDeploymentConfig.pipe(
    Effect.map(({ relayPublicDomain }) => ({
      main: import.meta.filename,
      // Requires Workers Paid; cap each invocation at one second of CPU time.
      limits: { cpuMs: 1_000 },
      compatibility: {
        date: "2026-05-22",
        flags: ["nodejs_compat"],
      },
      domain: relayPublicDomain,
    })),
    Effect.orDie,
  ),
  Effect.gen(function* () {
    const { relayPublicOrigin, stage } = yield* RelayDeploymentConfig;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const fcmDeliveryQueue = yield* RelayFcmDeliveryQueue;
    const fcmDeliveryDeadLetterQueue = yield* RelayFcmDeliveryDeadLetterQueue;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const relayApiZone = yield* RelayApiZone;
    const managedEndpointZone = yield* ManagedEndpointZone;
    const randomApnsDeliveryJobSigningSecret = yield* ApnsDeliveryJobSigningSecret;
    const gatewayNamespace = yield* ManagedGateway;
    const randomGatewaySecret = yield* ManagedGatewaySecret;
    const observability = yield* RelayObservability;

    const apnsEnabled = yield* Config.Boolean("APNS_ENABLED").pipe(Config.withDefault(true));
    const apnsCredentials = apnsEnabled
      ? {
          environment: yield* Config.schema(RelayConfiguration.ApnsEnvironment, "APNS_ENVIRONMENT"),
          teamId: yield* Config.String("APNS_TEAM_ID"),
          keyId: yield* Config.String("APNS_KEY_ID"),
          bundleId: yield* Config.String("APNS_BUNDLE_ID"),
          privateKey: yield* Config.Redacted("APNS_PRIVATE_KEY"),
        }
      : null;
    const fcmServiceAccount = Option.getOrUndefined(
      Option.filter(
        yield* Config.option(Config.Redacted("FCM_SERVICE_ACCOUNT")),
        (value) => Redacted.value(value).trim().length > 0,
      ),
    );
    const apnsDeliveryJobSigningSecret = yield* randomApnsDeliveryJobSigningSecret;
    const gatewaySecret = yield* randomGatewaySecret;
    const apnsDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(apnsDeliveryQueue);
    const fcmDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(fcmDeliveryQueue);

    const axiomDatasetName = yield* observability.traces.name;
    const axiomIngestToken = yield* observability.workerIngestToken.token;
    const axiomTracesEndpoint = yield* observability.traces.otelTracesEndpoint;

    const clerkSecretKey = yield* Config.Redacted("CLERK_SECRET_KEY");
    const clerkPublishableKey = yield* Config.String("CLERK_PUBLISHABLE_KEY");
    const clerkJwtAudience = yield* Config.String("CLERK_JWT_AUDIENCE");
    const billingMode = yield* Config.String("BILLING_MODE").pipe(Config.withDefault("disabled"));
    const billingCheckout = yield* Config.String("BILLING_CHECKOUT_ENABLED").pipe(
      Config.withDefault("false"),
    );
    const sandboxManagedAccess = yield* Config.String(
      "BILLING_SANDBOX_MANAGED_ACCESS_ENABLED",
    ).pipe(Config.withDefault("false"));
    const billingAppOrigin = yield* Config.String("BILLING_APP_ORIGIN").pipe(
      Config.withDefault("https://lecturn.cloudgatherer.net"),
    );
    const billingGrace = yield* Config.String("BILLING_RENEWAL_GRACE_SECONDS").pipe(
      Config.withDefault("0"),
    );
    const stripeSecret = yield* Config.Redacted("STRIPE_SECRET_KEY").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const stripeWebhook = yield* Config.Redacted("STRIPE_WEBHOOK_SECRET").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const clerkBillingWebhook = yield* Config.Redacted("CLERK_BILLING_WEBHOOK_SECRET").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const monthlyPrice = yield* Config.String("STRIPE_MONTHLY_PRICE_ID").pipe(
      Config.withDefault(""),
    );
    const annualPrice = yield* Config.String("STRIPE_ANNUAL_PRICE_ID").pipe(Config.withDefault(""));
    const portalConfiguration = yield* Config.String("STRIPE_PORTAL_CONFIGURATION_ID").pipe(
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
          "BILLING_ADDITIONAL_APP_ORIGINS",
        ].map((key) => [key, Config.String(key).pipe(Config.withDefault(""))]),
      ),
    );
    const identityReconciliation = yield* Config.Boolean(
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
    const decisionsSettings = yield* Effect.all(
      Object.fromEntries(
        extensionEnvironmentKeys.map((key) => [
          key,
          Config.String(key).pipe(Config.withDefault("")),
        ]),
      ),
    );
    const extensionSettings = Object.fromEntries(
      Object.entries(decisionsSettings).filter(([, value]) => value !== ""),
    );
    const extensionsConfig = parseExtensionsConfig(extensionSettings);
    const evaluatorWorker = yield* Config.String("EXTENSIONS_EVALUATOR_WORKER").pipe(
      Config.withDefault(""),
    );
    if (evaluatorWorker) yield* registerExtensionEvaluatorBinding(evaluatorWorker);
    const decisionsConfig = parseDecisionsConfig({
      ...Object.fromEntries(Object.entries(decisionsSettings).filter(([, value]) => value !== "")),
      EXTENSIONS_EVALUATOR_WORKER: evaluatorWorker,
    });
    const teamsEnabled = yield* Config.Boolean("TEAMS_ENABLED").pipe(Config.withDefault(false));
    const teamMonthlyPrice = yield* Config.String("STRIPE_TEAM_MONTHLY_PRICE_ID").pipe(
      Config.withDefault(""),
    );
    const teamAnnualPrice = yield* Config.String("STRIPE_TEAM_ANNUAL_PRICE_ID").pipe(
      Config.withDefault(""),
    );
    const teamPortal = yield* Config.String("STRIPE_TEAM_PORTAL_CONFIGURATION_ID").pipe(
      Config.withDefault(""),
    );
    const teamStripeWebhook = yield* Config.Redacted("STRIPE_TEAM_WEBHOOK_SECRET").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const teamClerkWebhook = yield* Config.Redacted("CLERK_TEAM_WEBHOOK_SECRET").pipe(
      Config.withDefault(Redacted.make("")),
    );
    if (
      teamsEnabled &&
      (!teamMonthlyPrice ||
        !teamAnnualPrice ||
        !teamPortal ||
        !Redacted.value(teamStripeWebhook) ||
        !Redacted.value(teamClerkWebhook) ||
        billingConfig.mode === "disabled")
    )
      return yield* Effect.die(
        "Teams requires configured prices, portal, signed webhooks and enabled billing.",
      );
    const teamBillingConfig = {
      secretKey: Redacted.value(stripeSecret),
      webhookSecret: Redacted.value(teamStripeWebhook),
      livemode: billingConfig.livemode,
      appOrigin: billingConfig.appOrigin,
      monthlyPriceId: teamMonthlyPrice,
      annualPriceId: teamAnnualPrice,
      portalConfigurationId: teamPortal,
      minimumSeats: 5,
      ...(billingConfig.automaticTax === undefined
        ? {}
        : { automaticTax: billingConfig.automaticTax }),
      ...(billingConfig.accountId === undefined ? {} : { accountId: billingConfig.accountId }),
    };
    const gatewayFlags = yield* Effect.all(
      Object.fromEntries(
        [
          "MANAGED_GATEWAY_ENABLED",
          "MANAGED_GATEWAY_ORIGIN_GUARD_VERIFIED",
          "MANAGED_GATEWAY_ROUTE_VERIFIED",
        ].map((name) => [name, Config.String(name).pipe(Config.withDefault("false"))]),
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
    // Named prepared statements collide behind Hyperdrive's transaction-mode
    // pool: sql-pg < 4.0.0-rc.117 names them `effect1..N` per connection, and
    // inside a transaction a Bind can reach another request's statement
    // (#14070, Effect-TS/effect#8320). Unnamed statements cannot collide.
    const db = yield* Drizzle.Postgres(hyperdrive.connectionString, undefined, {
      prepare: false,
    });

    const managedEndpointTunnelBinding = yield* Cloudflare.Tunnel.ReadWriteTunnel();
    const suspensionProvider = yield* bindManagedSuspensionProvider;
    // Keep Worker custom-domain reconciliation ordered after API zone provisioning.
    yield* yield* relayApiZone.zoneId;
    const managedEndpointDnsBinding = yield* Cloudflare.DNS.ReadWriteDns(managedEndpointZone);
    const managedEndpointZoneName = yield* managedEndpointZone.name;
    const managedEndpointCleanupMode = yield* RelayConfiguration.managedEndpointCleanupModeConfig;
    const legacyManagedEndpointCleanupMode =
      yield* RelayConfiguration.legacyManagedEndpointCleanupModeConfig;
    const legacyTunnelGraceMinutes = Option.getOrUndefined(
      yield* RelayConfiguration.legacyTunnelGraceMinutesConfig,
    );
    // Keys are endpoint keys or hashes over them, which already differ per
    // stage, so stages sharing an account cannot collide in these namespaces.
    const hookRateLimit = yield* Cloudflare.RateLimit("HOOK_RATE_LIMIT", {
      namespaceId: 1001,
      simple: {
        limit: HookForwarder.RELAY_HOOK_RATE_LIMIT.limit,
        period: HookForwarder.RELAY_HOOK_RATE_LIMIT.periodSeconds,
      },
    });
    const hookEndpointRateLimit = yield* Cloudflare.RateLimit("HOOK_ENDPOINT_RATE_LIMIT", {
      namespaceId: 1002,
      simple: {
        limit: HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.limit,
        period: HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.periodSeconds,
      },
    });
    const hookInboxes = yield* HookInboxObject.HookInboxObject;

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
          teamsEnabled,
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
        ...(fcmServiceAccount ? { fcmServiceAccount } : {}),
        apns: apnsCredentials,
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        clerkSecretKey,
        clerkPublishableKey,
        clerkJwtAudience,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        managedEndpointBaseDomain: yield* managedEndpointZoneName,
        managedEndpointNamespace: stage,
        managedEndpointCleanupMode,
        legacyManagedEndpointCleanupMode,
        ...(legacyTunnelGraceMinutes === undefined ? {} : { legacyTunnelGraceMinutes }),
      });
    });

    const inboxCall =
      <A>(operation: HookInbox.HookInboxError["operation"], endpointKey: string) =>
      (effect: Effect.Effect<A, never, Alchemy.RuntimeContext>) =>
        effect.pipe(
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
          Effect.catchCause((cause) =>
            Effect.fail(
              new HookInbox.HookInboxError({
                operation,
                endpointKey,
                cause: Cause.squash(cause),
              }),
            ),
          ),
        );
    const layerHookInbox = Layer.succeed(HookInbox.HookInbox, {
      hold: ({ endpointKey, baseUrl, hook }) =>
        hookInboxes.getByName(endpointKey).hold(hook, baseUrl).pipe(inboxCall("hold", endpointKey)),
      wake: ({ endpointKey, baseUrl }) =>
        hookInboxes.getByName(endpointKey).wake(baseUrl).pipe(inboxCall("wake", endpointKey)),
      clear: ({ endpointKey }) =>
        hookInboxes.getByName(endpointKey).clear().pipe(inboxCall("clear", endpointKey)),
    });

    const relayTraceLayer = Layer.unwrap(
      Effect.all({
        tracesDatasetName: axiomDatasetName,
        tracesEndpoint: axiomTracesEndpoint,
        ingestToken: axiomIngestToken,
      }).pipe(Effect.map(makeRelayTraceLayer)),
    );

    const gatewayHttpClientLayer = Layer.effect(
      ManagedGatewayHttpClient,
      Effect.gen(function* () {
        const fallback = yield* HttpClient.HttpClient;
        const { store, sync } = yield* ManagedGatewayRuntime;
        const baseDomain = yield* managedEndpointZoneName;
        return makeManagedGatewayHttpClient({
          fallback,
          hostnameSuffix: `-g-${relayStageSlug(stage)}.${baseDomain}`,
          dispatch: (request) =>
            Effect.gen(function* () {
              const mapping = yield* store.lookupPublicHostname(new URL(request.url).hostname);
              if (!mapping) return new Response("Unknown managed environment", { status: 404 });
              yield* sync(mapping.userId);
              const response = yield* gatewayNamespace
                .getByName(mapping.userId)
                .fetch(HttpServerRequest.fromWeb(request));
              return HttpServerResponse.toWeb(mutableGatewayBindingResponse(response));
            }).pipe(Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext)),
        });
      }),
    ).pipe(Layer.provide(gatewayRuntimeLayer));

    const teamLayer = teamsEnabled
      ? Layer.mergeAll(
          TeamRuntime.layer,
          Layer.effect(
            TeamBillingService,
            Effect.gen(function* () {
              const store = yield* TeamStore;
              const gateway = yield* TeamGatewaySync;
              return makeTeamBillingService(
                teamBillingConfig,
                yield* makeTeamBillingRepository,
                createTeamStripeClient(teamBillingConfig),
                (organizationId) =>
                  store
                    .inventory(organizationId)
                    .pipe(
                      Effect.flatMap((environments) =>
                        Effect.forEach(
                          new Set(environments.map((env) => env.user_id)),
                          (userId) => gateway.sync(userId),
                          { concurrency: 4, discard: true },
                        ),
                      ),
                    ),
              );
            }),
          ),
        ).pipe(
          Layer.provideMerge(Layer.effect(TeamStore, makeTeamStore)),
          Layer.provideMerge(
            Layer.succeed(TeamDirectory, makeTeamDirectory(Redacted.value(clerkSecretKey))),
          ),
          Layer.provideMerge(
            Layer.effect(
              TeamGatewaySync,
              Effect.gen(function* () {
                const runtime = yield* ManagedGatewayRuntime;
                return {
                  sync: (userId: string) =>
                    runtime.sync(userId).pipe(
                      Effect.mapError(
                        () =>
                          new TeamError({
                            code: "unavailable",
                            message: "Team connection update is pending. Please retry.",
                          }),
                      ),
                    ),
                };
              }),
            ).pipe(Layer.provide(gatewayRuntimeLayer)),
          ),
        )
      : Layer.succeed(TeamBillingService, {
          checkout: () =>
            Effect.fail(new TeamError({ code: "unavailable", message: "Teams disabled" })),
          preview: () =>
            Effect.fail(new TeamError({ code: "unavailable", message: "Teams disabled" })),
          confirm: () =>
            Effect.fail(new TeamError({ code: "unavailable", message: "Teams disabled" })),
          reconcile: () =>
            Effect.fail(new TeamError({ code: "unavailable", message: "Teams disabled" })),
          portal: () =>
            Effect.fail(new TeamError({ code: "unavailable", message: "Teams disabled" })),
          receiveWebhook: () =>
            Effect.fail(new TeamError({ code: "unavailable", message: "Teams disabled" })),
          closeOrganization: () =>
            Effect.fail(new TeamError({ code: "unavailable", message: "Teams disabled" })),
          processPending: () => Effect.void,
        });

    const layerRuntime = Layer.empty
      .pipe(
        Layer.provideMerge(
          Layer.merge(BillingService.layer(billingConfig), MobileRegistrations.layer),
        ),
        Layer.provideMerge(AgentActivityPublisher.layer),
        Layer.provideMerge(EnvironmentConnector.layer.pipe(Layer.provide(gatewayHttpClientLayer))),
        Layer.provideMerge(
          EnvironmentLinker.layer.pipe(Layer.provideMerge(EnvironmentRelinks.layer)),
        ),
        Layer.provideMerge(
          Layer.mergeAll(
            EnvironmentPublishSignatures.layer,
            ManagedEndpointReaper.layer,
            HeldHooks.layer,
          ),
        ),
        Layer.provideMerge(
          ManagedEndpointProvider.layerCloudflareBindings(
            managedEndpointTunnelBinding,
            managedEndpointDnsBinding,
            alchemyRuntimeContext,
          ).pipe(
            Layer.provideMerge(gatewayEnrollmentLayer),
            Layer.provideMerge(gatewayRuntimeLayer),
          ),
        ),
        Layer.provideMerge(DpopProofs.layer),
        Layer.provideMerge(ApnsDeliveries.layer),
        Layer.provideMerge(
          FcmDeliveries.layer.pipe(
            Layer.provide(
              Layer.succeed(FcmDeliveryQueueSender.FcmDeliveryQueueSender, {
                send: (body) =>
                  fcmDeliveryQueueSender
                    .send(body)
                    .pipe(Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext)),
              }),
            ),
            Layer.provideMerge(
              FcmClient.layer.pipe(
                Layer.provide(FcmAssertionSigner.layer),
                Layer.provide(
                  Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle }),
                ),
              ),
            ),
          ),
        ),
        Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
        Layer.provideMerge(
          ApnsDeliveryQueue.layerCloudflareQueues(apnsDeliveryQueueSender, alchemyRuntimeContext),
        ),
        Layer.provideMerge(Layer.mergeAll(AgentActivityRows.layer, Devices.layer, layerHookInbox)),
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
              teamsEnabled,
            ),
            ManagedReservations.layer({
              teamsEnabled,
              enabled: billingConfig.managedAccessEnabled === true,
              enforcementUsers:
                billingConfig.mode === "enforce" ? billingConfig.enforcementUsers : undefined,
            }),
          ),
        ),
        Layer.provideMerge(
          Layer.merge(teamLayer, decisionsLayer(decisionsConfig, billingConfig.appOrigin)).pipe(
            Layer.provideMerge(
              extensionsLayer(
                extensionsConfig,
                billingConfig.appOrigin,
                alchemyRuntimeContext.get<ExtensionEvaluatorBinding>(EXTENSIONS_EVALUATOR_BINDING),
              ),
            ),
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
      )
      .pipe(Layer.provideMerge(layerWebcrypto));

    // Fails open: a limiter outage must not drop webhooks the environment would accept.
    const allowWith =
      (limiter: typeof hookRateLimit) =>
      (key: string): Effect.Effect<boolean> =>
        limiter.limit({ key }).pipe(
          Effect.map((result) => result.success),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
          Effect.catch((error) =>
            Effect.logWarning("Hook rate limiter unavailable", { error: error.message }).pipe(
              Effect.andThen(
                Effect.annotateCurrentSpan({ "relay.hook.rate_limiter_failed_open": true }),
              ),
              Effect.as(true),
            ),
          ),
        );
    const layerHookRateLimiter = Layer.succeed(HookForwarder.HookRateLimiter, {
      allowHook: allowWith(hookRateLimit),
      allowEndpoint: allowWith(hookEndpointRateLimit),
    });
    // Forwarded webhooks reach gateway-routed endpoints through the gateway binding,
    // like every other internal request; a same-zone fetch would not reach them.
    const layerHookHttpClient = Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        return yield* ManagedGatewayHttpClient;
      }),
    ).pipe(Layer.provide(gatewayHttpClientLayer));

    const layerApp = Layer.mergeAll(
      layerRelayApi,
      HookForwarder.layerApi.pipe(
        Layer.provide(HookForwarder.layer.pipe(Layer.provide(layerHookHttpClient))),
        Layer.provide(layerHookRateLimiter),
      ),
      decisionsApi({
        appOrigin: billingConfig.appOrigin,
        additionalAppOrigins: billingConfig.additionalAppOrigins ?? [],
      }),
      extensionsApi({
        appOrigin: billingConfig.appOrigin,
        additionalAppOrigins: billingConfig.additionalAppOrigins ?? [],
      }),
    ).pipe(
      Layer.provideMerge(RelayHttpApi.layerClientAuth),
      Layer.provideMerge(RelayHttpApi.layerDpopClientAuth),
      Layer.provideMerge(RelayHttpApi.layerEnvironmentAuth),
      Layer.provide(layerRuntime),
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
          Effect.provide(layerRuntime),
        ),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      fcmDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "1 second",
        retryDelay: "30 seconds",
        deadLetterQueue: fcmDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.fcm_delivery_queue.process_batch"),
          Stream.runForEach(FcmDeliveryQueueConsumer.processMessage),
          Effect.provide(layerRuntime),
        ),
    );

    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      Effect.all(
        [
          DpopProofs.DpopProofReplay.pipe(
            Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
            Effect.andThen(
              Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
                Effect.flatMap(([activityRows, now]) =>
                  activityRows.pruneTerminal({
                    updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
                  }),
                ),
              ),
            ),
            Effect.andThen(
              EnvironmentRelinks.EnvironmentRelinks.pipe(
                Effect.flatMap((relinks) => relinks.drain()),
              ),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logWarning("Failed to prune expired relay state", { cause }),
            ),
          ),
          ManagedEndpointReaper.ManagedEndpointReaper.pipe(
            Effect.flatMap((reaper) => reaper.sweep.pipe(Effect.timeout("2 minutes"))),
            Effect.tap((result) =>
              result.scanned > 0
                ? Effect.logInfo("Finished managed tunnel cleanup", result)
                : Effect.void,
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logWarning("Failed to clean up inactive managed tunnels", { cause }),
            ),
          ),
        ],
        { concurrency: 2, discard: true },
      ).pipe(
        Effect.withSpan("relay.cron.prune_expired_state"),
        // Export cron spans to Axiom like HTTP spans; the scope flushes them before the run ends.
        Effect.provide(Layer.merge(layerRuntime, relayTraceLayer)),
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
          if (teamsEnabled) {
            const teams = yield* TeamBillingService;
            tasks.push(
              teams.processPending().pipe(
                Effect.timeout("45 seconds"),
                Effect.catch(() => Effect.logWarning("Team billing reconciliation deferred")),
              ),
            );
          }

          if (billingConfig.suspensionEnabled) {
            const suspensions = yield* makeManagedSuspensions({
              teamsEnabled,
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
        }).pipe(Effect.provide(layerRuntime), (maintenance) =>
          traceBillingMaintenance(maintenance, relayTraceLayer),
        ),
      );
    }

    // Identity deletion invalidates extension consent even when billing maintenance is disabled.
    if (identityReconciliation)
      yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
        Effect.gen(function* () {
          const store = yield* makeBillingStore;
          const operations = yield* makeBillingOperations({
            store,
            identity: clerkIdentityLookup(Redacted.value(clerkSecretKey)),
          });
          yield* operations.reconcileIdentities(5);
        }).pipe(
          Effect.timeout("45 seconds"),
          Effect.catch(() => Effect.logWarning("Identity reconciliation deferred")),
          Effect.provide(layerRuntime),
        ),
      );

    // Admission may be disabled while dispatched attempts still need durable reconciliation.
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      DecisionsService.pipe(
        Effect.flatMap((service) =>
          service.usage.reconcile().pipe(
            Effect.andThen(
              ExtensionsService.pipe(
                Effect.flatMap((extensions) =>
                  extensions
                    .reconcilePrivate()
                    .pipe(Effect.andThen(extensions.usage.contextual.reconcile())),
                ),
              ),
            ),
            Effect.andThen(service.usage.health),
            Effect.flatMap((health) =>
              health.anomaly ||
              health.overdueAttempts > 0 ||
              health.exposureNanoUsd >= decisionsConfig.globalExposureNanoUsd
                ? Effect.logWarning("Decisions operational alert", health)
                : Effect.logInfo("Decisions operational health", health),
            ),
          ),
        ),
        Effect.timeout("45 seconds"),
        Effect.catchCause(() => Effect.logWarning("Decisions reconciliation deferred")),
        Effect.provide(layerRuntime),
      ),
    );

    yield* Cloudflare.Workers.cron("*/10 * * * *", () =>
      ExtensionsService.pipe(
        Effect.flatMap((service) => service.cleanupPrivate()),
        Effect.timeout("45 seconds"),
        Effect.catch(() => Effect.logWarning("Extensions evaluator cleanup deferred")),
        Effect.provide(layerRuntime),
      ),
    );

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
        Effect.provide(layerRuntime),
      ),
    );

    const fetch = Layer.merge(
      Layer.mergeAll(
        HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
          Layer.provide(layerApp),
        ),
        HttpApiScalar.layer(RelayApi, { path: "/docs" }),
        RelayHttpApi.layerDocsRedirectRoute,
        ...(teamsEnabled
          ? [
              teamsRoutes({
                appOrigin: billingConfig.appOrigin,
                additionalAppOrigins: billingConfig.additionalAppOrigins ?? [],
                clerkWebhookSecret: Redacted.value(teamClerkWebhook),
                checkoutEnabled: billingConfig.checkoutEnabled,
              }).pipe(Layer.provide(layerRuntime)),
            ]
          : []),
        billingRoutes(billingConfig, Redacted.value(clerkBillingWebhook)).pipe(
          Layer.provide(layerRuntime),
        ),
      ).pipe(
        Layer.provide([
          Etag.layerWeak,
          layerHttpPlatformNotSupported,
          RelayHttpApi.layerCorsFor(billingConfig.appOrigin, billingConfig.additionalAppOrigins),
        ]),
      ),
      RelayHttpApi.layerNotFoundRoute,
    ).pipe(
      HttpRouter.toHttpEffect,
      Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG),
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
              }).pipe(Effect.provide(layerRuntime));
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
        Layer.provideMerge(Cloudflare.Workers.RateLimitBinding),
        Layer.provideMerge(HookInboxObject.layer),
        Layer.provideMerge(ManagedGatewayLive),
      ),
    ),
  ),
);

export default layer;
