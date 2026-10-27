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
import { appToolTitle } from "@lecturn/shared/appToolPresentation";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  type AppPairingRequestRecord,
  type AppRegistrationRecord,
  AppRegistrationRepository,
  type AppRegistrationRepositoryError,
  type AppRegistrationWrite,
  layer as AppRegistrationRepositoryLayer,
} from "../persistence/AppRegistrations.ts";
import { issueAppCredential } from "./appCredential.ts";
import { syncAppToolPresentations } from "./appToolPresentationSync.ts";
import {
  type AppLease,
  AppLeaseService,
  AppProjectService,
  AppRegistryService,
  LiveToolClient,
} from "./services.ts";
import { parseAppSubject } from "./subjects.ts";

const PAIRING_REQUEST_TTL = Duration.minutes(10);
// Timers can fire a few milliseconds early; this far past expiry every clock
// reading agrees the request has lapsed.
const LAPSE_GRACE = Duration.seconds(1);

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

const iso = (value: DateTime.Utc) => DateTime.formatIso(value);

/** The stored row as a write, so an update names only what it changes. */
const writeOf = (
  record: AppRegistrationRecord,
  now: DateTime.Utc,
  changes: Partial<Omit<AppRegistrationWrite, "appId" | "now">> = {},
): AppRegistrationWrite => ({
  appId: record.appId,
  registration: record.registration,
  state: record.state,
  grantedFingerprint: record.grantedFingerprint,
  runtimeCeiling: record.runtimeCeiling,
  cachedHeadlessTools: record.cachedHeadlessTools,
  cachedLiveTools: record.cachedLiveTools,
  lastSeenAt: record.lastSeenAt,
  ...changes,
  now,
});

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
  embedOrigins: status.embedOrigins,
});

export const make = Effect.gen(function* () {
  const repository = yield* AppRegistrationRepository;
  const leases = yield* AppLeaseService;
  const liveTools = yield* LiveToolClient;
  const projects = yield* AppProjectService;
  const config = yield* ServerConfig.ServerConfig;
  const sessions = yield* SessionStore.SessionStore;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const layerScope = yield* Effect.scope;
  const statusChanges = yield* PubSub.unbounded<AppStatusStreamEvent>();
  const toolDefinitionChanges = yield* PubSub.unbounded<AppId>();
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

  /**
   * A request nobody answered leaves the app as the user last decided it:
   * `pairing-requested` holds only while a request waits, so no client shows
   * a prompt it cannot answer.
   */
  const settleLapsed = (publish: ReadonlyArray<AppId>) =>
    Effect.gen(function* () {
      const settled = yield* storage(repository.settleLapsedPairings(yield* DateTime.now));
      yield* Effect.forEach(new Set([...publish, ...settled]), publishStatus, { discard: true });
    });

  // Clients keep no timers: this update takes the lapsed prompt off them.
  const settleAfterLapse = (appId: AppId, expiresAt: DateTime.Utc) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        Effect.sleep(Duration.sum(DateTime.distance(now, expiresAt), LAPSE_GRACE)),
      ),
      Effect.andThen(settleLapsed([appId])),
      Effect.ignore,
      Effect.forkIn(layerScope),
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
      const existing = Option.getOrUndefined(yield* storage(repository.get(registration.appId)));
      // Stored before the app's state changes, so a lapse settling in between
      // sees this request waiting and leaves the app alone.
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
      if (existing === undefined) {
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
      } else {
        // A changed command or frame origin is not what the user approved, so
        // the grant is suspended until they decide (R1.4). Denied and revoked
        // apps keep their state, which an unanswered request then leaves standing.
        const suspend =
          existing.state === "pairing-requested" ||
          (existing.state === "granted" &&
            existing.grantedFingerprint !== registrationFingerprint(registration));
        // An approved registration stays on the record while the new one waits
        // on the request; with none approved, the record shows what is asked.
        const unapproved = existing.grantedFingerprint === null;
        if (suspend || unapproved) {
          yield* storage(
            repository.upsert(
              writeOf(existing, now, {
                ...(suspend ? { state: "pairing-requested" as const } : {}),
                ...(unapproved ? { registration } : {}),
              }),
            ),
          );
        }
      }
      yield* publishStatus(registration.appId);
      yield* settleAfterLapse(registration.appId, expiresAt);
      return { requestId, pollSecret, expiresAt: iso(expiresAt) };
    });

  const credentialFailed = (cause: unknown) =>
    Effect.logError("Connected-app credential could not be issued", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new AppsError({
            code: "unavailable",
            message: "The app credential could not be issued.",
          }),
        ),
      ),
    );

  /** Live sessions acting for the app: its credentials and, unless `onlyCredentials`, its embed tokens. */
  const revokeAppSessions = (
    appId: AppId,
    options: { readonly keep?: string; readonly onlyCredentials?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const active = yield* sessions.listActive().pipe(Effect.catch(credentialFailed));
      yield* Effect.forEach(
        active.filter((session) => {
          const subject = parseAppSubject(session.subject);
          return (
            session.sessionId !== options.keep &&
            subject?.appId === appId &&
            (!options.onlyCredentials || subject.kind === "app")
          );
        }),
        (session) => sessions.revoke(session.sessionId).pipe(Effect.catch(credentialFailed)),
        { discard: true },
      );
    });

  const deliverCredential = (request: AppPairingRequestRecord) =>
    Effect.gen(function* () {
      const record = Option.getOrUndefined(yield* storage(repository.get(request.appId)));
      // Revoked or deleted between the grant and this poll.
      if (record === undefined) return { state: "revoked" } as const;
      if (record.state !== "granted") return { state: record.state } as const;
      if (request.credentialDelivered) return { state: "granted" } as const;
      // Issued before claiming: a claim followed by a failed issue would lose
      // the credential for good, while an unclaimed issue is simply revoked.
      const issued = yield* issueAppCredential(sessions, {
        appId: record.appId,
        name: record.registration.name,
        ceiling: record.runtimeCeiling,
      }).pipe(Effect.catch(credentialFailed));
      const claimed = yield* storage(repository.claimCredentialDelivery(request.requestId)).pipe(
        Effect.onError(() => sessions.revoke(issued.sessionId).pipe(Effect.ignore)),
      );
      if (!claimed) {
        yield* sessions.revoke(issued.sessionId).pipe(Effect.ignore);
        return { state: "granted" } as const;
      }
      // One credential per app: pairing again retires the previous one. Open
      // embed views keep their short-lived tokens and refresh through the app.
      yield* revokeAppSessions(record.appId, { keep: issued.sessionId, onlyCredentials: true });
      return {
        state: "granted",
        credential: {
          token: issued.token,
          expiresAt: iso(DateTime.toUtc(issued.expiresAt)),
          environmentId: yield* environment.getEnvironmentId,
        },
      } as const;
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
        case "denied":
          return { state: "denied" } as const;
        case "granted":
          return yield* deliverCredential(request.value);
      }
    });

  const requireStatus = (appId: AppId) =>
    statusOf(appId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(notFound(`No connected app is registered as ${appId}.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const decidePairing: AppRegistryService["Service"]["decidePairing"] = ({ requestId, decision }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const request = Option.getOrUndefined(
        yield* storage(repository.getPairingRequest(requestId)),
      );
      if (
        request === undefined ||
        request.state !== "pending" ||
        !DateTime.isLessThan(now, request.expiresAt)
      ) {
        return yield* notFound("This pairing request is no longer waiting for a decision.");
      }
      const record = yield* requireRecord(request.appId);
      // Another app may have taken the prefix while the prompt was open.
      if (decision === "grant") yield* checkToolPrefix(request.registration);
      const decided = yield* storage(
        repository.decidePairingRequest({
          requestId,
          state: decision === "grant" ? "granted" : "denied",
        }),
      );
      // Another client answered the same prompt first.
      if (!decided) {
        return yield* notFound("This pairing request is no longer waiting for a decision.");
      }
      if (decision === "grant") {
        const fingerprint = registrationFingerprint(request.registration);
        yield* storage(
          repository.upsert(
            writeOf(record, now, {
              registration: request.registration,
              state: "granted",
              grantedFingerprint: fingerprint,
              // A different command may list different tools.
              cachedHeadlessTools:
                record.grantedFingerprint === fingerprint ? record.cachedHeadlessTools : null,
            }),
          ),
        );
      } else if (record.state === "pairing-requested") {
        // A granted app asking for a fresh credential with the command the user
        // already approved keeps its grant, and a revoked or denied one stays so.
        yield* storage(repository.upsert(writeOf(record, now, { state: "denied" })));
        yield* revokeAppSessions(record.appId);
      }
      yield* publishStatus(request.appId);
      return yield* requireStatus(request.appId);
    });

  const revoke: AppRegistryService["Service"]["revoke"] = (appId) =>
    Effect.gen(function* () {
      const record = yield* requireRecord(appId);
      const now = yield* DateTime.now;
      yield* storage(repository.upsert(writeOf(record, now, { state: "revoked" })));
      yield* revokeAppSessions(appId);
      yield* leases.clear(appId);
      // Headless processes stop from this status change (HeadlessToolHost).
      yield* publishStatus(appId);
      return yield* requireStatus(appId);
    });

  const setRuntimeCeiling: AppRegistryService["Service"]["setRuntimeCeiling"] = ({
    appId,
    ceiling,
  }) =>
    Effect.gen(function* () {
      const record = yield* requireRecord(appId);
      const now = yield* DateTime.now;
      // The registry is what the tool gate reads; a credential's `rtc` claim
      // catches up when the app next pairs.
      yield* storage(repository.upsert(writeOf(record, now, { runtimeCeiling: ceiling })));
      yield* publishStatus(appId);
      return yield* requireStatus(appId);
    });

  const deleteApp: AppRegistryService["Service"]["delete"] = ({ appId, deleteThreads }) =>
    Effect.gen(function* () {
      const record = yield* requireRecord(appId);
      yield* revokeAppSessions(appId);
      yield* leases.clear(appId);
      if (deleteThreads) {
        // Revoked first, so the app is shut out and its headless processes stop
        // while its threads go; a deletion that fails part way leaves a revoked
        // app the user can delete again, never a granted one missing threads.
        const now = yield* DateTime.now;
        yield* storage(repository.upsert(writeOf(record, now, { state: "revoked" })));
        yield* publishStatus(appId);
        yield* projects.deleteAppProjects(appId);
      }
      yield* storage(repository.delete(appId));
      yield* publishStatus(appId);
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
      yield* PubSub.publish(toolDefinitionChanges, appId);
    });

  /** Headless tools win a name both tiers list, as they do in AppToolkit's listing. */
  const toolTitlesOf = (appId: AppId) =>
    storage(repository.get(appId)).pipe(
      Effect.map((found) => {
        const titles = new Map<string, string>();
        if (Option.isNone(found)) return titles;
        const record = found.value;
        const seen = new Set<string>();
        for (const tool of [
          ...(record.cachedHeadlessTools ?? []),
          ...(record.registration.liveTools ? (record.cachedLiveTools ?? []) : []),
        ]) {
          if (seen.has(tool.name)) continue;
          seen.add(tool.name);
          const title = appToolTitle(tool);
          if (title !== undefined) titles.set(tool.name, title);
        }
        return titles;
      }),
      // A row without its title still reads as the tool's name.
      Effect.orElseSucceed(() => new Map<string, string>()),
    );

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

  yield* syncAppToolPresentations(
    Stream.merge(
      streamStatus,
      Stream.fromPubSub(toolDefinitionChanges).pipe(
        Stream.map((appId) => ({ type: "tools", appId }) as const),
      ),
    ),
    toolTitlesOf,
  ).pipe(Effect.forkScoped({ startImmediately: true }));

  // Lapse timers end with the server: settle what lapsed while it was down,
  // and time what still waits.
  yield* Effect.gen(function* () {
    yield* settleLapsed([]);
    const waiting = yield* storage(repository.listPendingPairingRequests(yield* DateTime.now));
    yield* Effect.forEach(
      waiting,
      (request) => settleAfterLapse(request.appId, request.expiresAt),
      { discard: true },
    );
  }).pipe(Effect.ignore);

  // A sidecar exists only for its app, so a registration it cannot serve
  // stops it instead of running without the app.
  if (config.appSidecar !== undefined) {
    yield* seedSidecarGrant(config.appSidecar).pipe(Effect.orDie);
  }

  return AppRegistryService.of({
    createPairingRequest,
    pollPairingRequest,
    decidePairing,
    revoke,
    delete: deleteApp,
    setRuntimeCeiling,
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
