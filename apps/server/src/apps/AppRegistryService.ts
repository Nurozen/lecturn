// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  type AppEmbedContext,
  type AppId,
  type AppRegistration,
  AppsError,
  type AppStatus,
  type AppStatusStreamEvent,
  appGrantFingerprintSource,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import {
  type AppPairingRequestRecord,
  type AppRegistrationRecord,
  AppRegistrationRepository,
  type AppRegistrationRepositoryError,
  layer as AppRegistrationRepositoryLayer,
} from "../persistence/AppRegistrations.ts";
import {
  type AppLease,
  AppLeaseService,
  AppProjectService,
  AppRegistryService,
  AppsNotImplemented,
  LiveToolClient,
} from "./services.ts";

const PAIRING_REQUEST_TTL = Duration.minutes(10);

/**
 * First segments of Lecturn's own MCP tool names, plus namespaces Lecturn or
 * MCP keep for themselves. Built-in tools win name clashes at the /mcp
 * interceptor, so an app with one of these prefixes would have tools that
 * silently never run.
 */
export const RESERVED_APP_TOOL_PREFIXES: ReadonlySet<string> = new Set([
  "app",
  "apps",
  "attachment",
  "create",
  "delegate",
  "delete",
  "device",
  "environment",
  "html",
  "lecturn",
  "link",
  "list",
  "mcp",
  "orchestrator",
  "preview",
  "project",
  "projects",
  "queue",
  "read",
  "request",
  "run",
  "schedule",
  "task",
  "tasks",
  "thread",
  "threads",
  "ui",
  "unlink",
  "unwatch",
  "update",
  "watch",
  "worktree",
  "write",
]);

const sha256Hex = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

/** The re-approval key (R1.4): the exact command, env and frame origins the user approved. */
export const registrationFingerprint = (registration: AppRegistration) =>
  sha256Hex(appGrantFingerprintSource(registration));

const sameSecretHash = (expected: string, actual: string) => {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(actual, "hex");
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};

const invalid = (message: string) => new AppsError({ code: "invalid", message });
const notFound = (message: string) => new AppsError({ code: "not-found", message });

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "AppRegistryService", method });

const iso = (value: DateTime.Utc) => DateTime.formatIso(value);

const toStatus = (
  record: AppRegistrationRecord,
  pending: AppPairingRequestRecord | undefined,
  lease: Option.Option<AppLease>,
): AppStatus => {
  const { registration } = record;
  return {
    appId: record.appId,
    name: registration.name,
    iconDataUrl: registration.iconDataUrl,
    toolPrefix: registration.toolPrefix,
    refPrefixes: registration.refPrefixes,
    openUrlTemplate: registration.openUrlTemplate ?? null,
    state: record.state,
    live: Option.match(lease, {
      onNone: () => null,
      onSome: (value) => ({ expiresAt: iso(value.expiresAt) }),
    }),
    lastSeenAt: record.lastSeenAt === null ? null : iso(record.lastSeenAt),
    runtimeCeiling: record.runtimeCeiling,
    headlessTools: registration.headlessTools ?? null,
    gatedTools: registration.gatedTools,
    embedOrigins: registration.embedOrigins ?? [],
    pendingRequest:
      pending === undefined
        ? null
        : {
            requestId: pending.requestId,
            registration: pending.registration,
            requestedAt: iso(pending.createdAt),
          },
  };
};

const toEmbedContext = (status: AppStatus): AppEmbedContext => ({
  appId: status.appId,
  name: status.name,
  iconDataUrl: status.iconDataUrl,
  refPrefixes: status.refPrefixes,
  openUrlTemplate: status.openUrlTemplate,
  live: status.live,
  state: status.state,
});

export const make = Effect.gen(function* () {
  const repository = yield* AppRegistrationRepository;
  const leases = yield* AppLeaseService;
  const liveTools = yield* LiveToolClient;
  const projects = yield* AppProjectService;
  const config = yield* ServerConfig.ServerConfig;
  const layerScope = yield* Effect.scope;
  const statusChanges = yield* PubSub.unbounded<AppStatusStreamEvent>();
  const liveRefreshes = yield* FiberMap.make<AppId>();

  // The cause is logged here; clients only learn that storage failed.
  const storage = <A>(effect: Effect.Effect<A, AppRegistrationRepositoryError>) =>
    effect.pipe(
      Effect.tapError((cause) => Effect.logError("Connected-app storage failed", { cause })),
      Effect.mapError(
        () => new AppsError({ code: "unavailable", message: "Connected-app storage failed." }),
      ),
    );

  const requireRecord = (appId: AppId) =>
    storage(repository.get(appId)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(notFound(`No connected app is registered as ${appId}.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const pendingRequests = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const pending = yield* storage(repository.listPendingPairingRequests(now));
    return new Map(pending.map((request) => [request.appId, request]));
  });

  const statusOf = (appId: AppId) =>
    Effect.gen(function* () {
      const record = yield* storage(repository.get(appId));
      if (Option.isNone(record)) return Option.none<AppStatus>();
      const pending = (yield* pendingRequests).get(appId);
      return Option.some(toStatus(record.value, pending, yield* leases.current(appId)));
    });

  const publishStatus = (appId: AppId) =>
    statusOf(appId).pipe(
      Effect.flatMap((status) =>
        PubSub.publish(
          statusChanges,
          Option.match(status, {
            onNone: () => ({ type: "remove", appId }) as const,
            onSome: (app) => ({ type: "upsert", app }) as const,
          }),
        ),
      ),
      Effect.asVoid,
    );

  const list = Effect.gen(function* () {
    const records = yield* storage(repository.list);
    const pending = yield* pendingRequests;
    return yield* Effect.forEach(records, (record) =>
      leases
        .current(record.appId)
        .pipe(Effect.map((lease) => toStatus(record, pending.get(record.appId), lease))),
    );
  });

  /** A prefix both reserved-free and unique, so `<prefix>_<tool>` names one tool. */
  const checkToolPrefix = (registration: AppRegistration) =>
    Effect.gen(function* () {
      if (RESERVED_APP_TOOL_PREFIXES.has(registration.toolPrefix)) {
        return yield* invalid(
          `Tool prefix "${registration.toolPrefix}" is reserved for Lecturn's own tools.`,
        );
      }
      const records = yield* storage(repository.list);
      const holder = records.find(
        (record) =>
          record.appId !== registration.appId &&
          record.registration.toolPrefix === registration.toolPrefix,
      );
      if (holder !== undefined) {
        return yield* new AppsError({
          code: "conflict",
          message: `Tool prefix "${registration.toolPrefix}" is already used by ${holder.registration.name}.`,
        });
      }
    });

  const createPairingRequest: AppRegistryService["Service"]["createPairingRequest"] = (
    registration,
  ) =>
    Effect.gen(function* () {
      yield* checkToolPrefix(registration);
      const now = yield* DateTime.now;
      const expiresAt = DateTime.addDuration(now, PAIRING_REQUEST_TTL);
      const requestId = NodeCrypto.randomUUID();
      const pollSecret = NodeCrypto.randomBytes(32).toString("base64url");
      const existing = yield* storage(repository.get(registration.appId));
      // A granted or revoked app keeps what the user approved until a decision;
      // the new registration waits on the request.
      const keepsGrant = Option.exists(
        existing,
        (record) => record.state === "granted" || record.state === "revoked",
      );
      if (!keepsGrant) {
        yield* storage(
          repository.upsert({
            appId: registration.appId,
            registration,
            state: "pairing-requested",
            grantedFingerprint: null,
            runtimeCeiling: null,
            cachedHeadlessTools: null,
            cachedLiveTools: null,
            lastSeenAt: null,
            now,
          }),
        );
      }
      yield* storage(
        repository.createPairingRequest({
          requestId,
          appId: registration.appId,
          registration,
          pollSecretHash: sha256Hex(pollSecret),
          expiresAt,
          now,
        }),
      );
      yield* publishStatus(registration.appId);
      // Takes the expired prompt off every client without them keeping timers.
      yield* Effect.sleep(PAIRING_REQUEST_TTL).pipe(
        Effect.andThen(publishStatus(registration.appId)),
        Effect.ignore,
        Effect.forkIn(layerScope),
      );
      return { requestId, pollSecret, expiresAt: iso(expiresAt) };
    });

  const pollPairingRequest: AppRegistryService["Service"]["pollPairingRequest"] = ({
    requestId,
    pollSecret,
  }) =>
    Effect.gen(function* () {
      const request = yield* storage(repository.getPairingRequest(requestId));
      // One answer for unknown ids and wrong secrets, so ids cannot be probed.
      if (
        Option.isNone(request) ||
        !sameSecretHash(request.value.pollSecretHash, sha256Hex(pollSecret))
      ) {
        return yield* notFound("Unknown pairing request.");
      }
      const now = yield* DateTime.now;
      switch (request.value.state) {
        case "pending":
          return {
            state: DateTime.isLessThan(now, request.value.expiresAt)
              ? "pairing-requested"
              : "expired",
          } as const;
        case "superseded":
          return { state: "expired" } as const;
        case "granted":
        case "denied":
          return { state: request.value.state } as const;
      }
    });

  const get: AppRegistryService["Service"]["get"] = (appId) =>
    Effect.gen(function* () {
      const record = yield* storage(repository.get(appId));
      if (Option.isNone(record)) return Option.none();
      const pending = (yield* pendingRequests).get(appId);
      return Option.some({
        status: toStatus(record.value, pending, yield* leases.current(appId)),
        registration: record.value.registration,
      });
    });

  const isGranted: AppRegistryService["Service"]["isGranted"] = (appId) =>
    storage(repository.get(appId)).pipe(
      Effect.map(Option.exists((record) => record.state === "granted")),
    );

  const cachedTools: AppRegistryService["Service"]["cachedTools"] = (appId) =>
    requireRecord(appId).pipe(
      Effect.map((record) => ({
        headless: Option.fromNullishOr(record.cachedHeadlessTools),
        live: Option.fromNullishOr(record.cachedLiveTools),
      })),
    );

  const setCachedTools: AppRegistryService["Service"]["setCachedTools"] = (
    appId,
    tier,
    definitions,
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const updated = yield* storage(
        repository.setCachedTools({ appId, tier, tools: definitions, now }),
      );
      if (!updated) return yield* notFound(`No connected app is registered as ${appId}.`);
    });

  const seedSidecarGrant: AppRegistryService["Service"]["seedSidecarGrant"] = ({ registration }) =>
    Effect.gen(function* () {
      yield* checkToolPrefix(registration);
      const now = yield* DateTime.now;
      const fingerprint = registrationFingerprint(registration);
      const existing = Option.getOrUndefined(yield* storage(repository.get(registration.appId)));
      // A different command may list different tools, so its headless cache is stale.
      const sameCommand = existing?.grantedFingerprint === fingerprint;
      yield* storage(
        repository.upsert({
          appId: registration.appId,
          registration,
          state: "granted",
          grantedFingerprint: fingerprint,
          runtimeCeiling: existing?.runtimeCeiling ?? null,
          cachedHeadlessTools: sameCommand ? (existing?.cachedHeadlessTools ?? null) : null,
          cachedLiveTools: existing?.cachedLiveTools ?? null,
          lastSeenAt: now,
          now,
        }),
      );
      yield* publishStatus(registration.appId);
    });

  const streamStatus: AppRegistryService["Service"]["streamStatus"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before the snapshot so no change falls between the two.
      const subscription = yield* PubSub.subscribe(statusChanges);
      const apps = yield* list;
      return Stream.concat(
        Stream.make({ type: "snapshot", apps } as const),
        Stream.fromSubscription(subscription),
      );
    }),
  );

  const streamEmbedContext: AppRegistryService["Service"]["streamEmbedContext"] = (projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const binding = yield* projects.resolveAppForProject(projectId);
        if (Option.isNone(binding)) {
          return yield* notFound("This project does not belong to a connected app.");
        }
        const { appId } = binding.value;
        const subscription = yield* PubSub.subscribe(statusChanges);
        const initial = yield* statusOf(appId);
        if (Option.isNone(initial)) {
          return yield* notFound(`No connected app is registered as ${appId}.`);
        }
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.takeWhile((event) => !(event.type === "remove" && event.appId === appId)),
          Stream.filter(
            (event): event is Extract<AppStatusStreamEvent, { readonly type: "upsert" }> =>
              event.type === "upsert" && event.app.appId === appId,
          ),
          Stream.map((event) => toEmbedContext(event.app)),
        );
        return Stream.concat(Stream.make(toEmbedContext(initial.value)), updates);
      }),
    );

  // Heartbeats renew a lease every few seconds. Only an established or lost
  // lease changes what clients show, and a status carries a 64 KB icon, so
  // renewals are not broadcast.
  const establishedLeases = new Map<AppId, AppLease>();
  const refreshLiveDefinitions = (lease: AppLease) =>
    Effect.gen(function* () {
      const record = yield* requireRecord(lease.appId);
      if (!record.registration.liveTools) return;
      const definitions = yield* liveTools.listTools(lease);
      yield* setCachedTools(lease.appId, "live", definitions);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("Live tool definitions were not refreshed", { appId: lease.appId, cause }),
      ),
    );

  yield* leases.stream.pipe(
    Stream.runForEach(({ appId, lease }) =>
      Effect.gen(function* () {
        const previous = establishedLeases.get(appId);
        if (Option.isNone(lease)) {
          establishedLeases.delete(appId);
          return yield* publishStatus(appId);
        }
        establishedLeases.set(appId, lease.value);
        const established =
          previous === undefined ||
          previous.url !== lease.value.url ||
          previous.bearer !== lease.value.bearer;
        if (!established) return;
        yield* storage(repository.touchLastSeen({ appId, at: yield* DateTime.now }));
        // The app reads as open only once its fresh definitions are cached, so
        // a tools/list after the switch flips never sees the previous run's.
        yield* FiberMap.run(
          liveRefreshes,
          appId,
          refreshLiveDefinitions(lease.value).pipe(Effect.andThen(publishStatus(appId))),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Connected-app lease change was not applied", { appId, cause }),
        ),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  // A sidecar exists only for its app, so a registration it cannot serve
  // stops it instead of running without the app.
  if (config.appSidecar !== undefined) {
    yield* seedSidecarGrant(config.appSidecar).pipe(Effect.orDie);
  }

  return AppRegistryService.of({
    createPairingRequest,
    pollPairingRequest,
    decidePairing: () => Effect.fail(notImplemented("decidePairing")),
    revoke: () => Effect.fail(notImplemented("revoke")),
    delete: () => Effect.fail(notImplemented("delete")),
    setRuntimeCeiling: () => Effect.fail(notImplemented("setRuntimeCeiling")),
    list,
    streamStatus,
    get,
    isGranted,
    cachedTools,
    setCachedTools,
    seedSidecarGrant,
    streamEmbedContext,
  });
});

export const layer = Layer.effect(AppRegistryService, make).pipe(
  Layer.provide(AppRegistrationRepositoryLayer),
);
