import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@lecturn/contracts/relay";
import { decodeRelayJwt } from "@lecturn/shared/relayJwt";
import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
} from "@lecturn/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ManagedRelay from "./managedRelay.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Connectivity from "../connection/connectivity.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { mapManagedRelayError } from "../connection/errors.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "../connection/model.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";

export type RelayEnvironmentAvailability = "checking" | "online" | "offline" | "error";

export interface RelayDiscoveredEnvironment {
  readonly environment: RelayClientEnvironmentRecord;
  readonly availability: RelayEnvironmentAvailability;
  readonly status: Option.Option<RelayEnvironmentStatusResponse>;
  readonly error: Option.Option<ConnectionAttemptError>;
}

export interface RelayEnvironmentDiscoveryState {
  readonly environments: ReadonlyMap<string, RelayDiscoveredEnvironment>;
  readonly refreshing: boolean;
  readonly offline: boolean;
  readonly error: Option.Option<ConnectionAttemptError>;
}

export class RelayEnvironmentDiscovery extends Context.Service<
  RelayEnvironmentDiscovery,
  {
    /** Every account's environments as one list, for readers that do not segment by account. */
    readonly state: SubscriptionRef.SubscriptionRef<RelayEnvironmentDiscoveryState>;
    /** Discovery per signed-in account, primary account first. */
    readonly accountStates: SubscriptionRef.SubscriptionRef<
      ReadonlyMap<string, RelayEnvironmentDiscoveryState>
    >;
    readonly refresh: Effect.Effect<void>;
  }
>()("@lecturn/client-runtime/relay/discovery/RelayEnvironmentDiscovery") {}

export const EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE: RelayEnvironmentDiscoveryState = {
  environments: new Map(),
  refreshing: false,
  offline: false,
  error: Option.none(),
};

function mergeAccountStates(
  accounts: ReadonlyMap<string, RelayEnvironmentDiscoveryState>,
  offline: boolean,
): RelayEnvironmentDiscoveryState {
  const environments = new Map<string, RelayDiscoveredEnvironment>();
  let refreshing = false;
  let error = Option.none<ConnectionAttemptError>();
  for (const account of accounts.values()) {
    for (const [environmentId, environment] of account.environments) {
      if (!environments.has(environmentId)) {
        environments.set(environmentId, environment);
      }
    }
    refreshing = refreshing || account.refreshing;
    error = Option.orElse(error, () => account.error);
  }
  return { environments, refreshing, offline, error };
}

function validateStatus(
  environment: RelayClientEnvironmentRecord,
  status: RelayEnvironmentStatusResponse,
): Effect.Effect<RelayEnvironmentStatusResponse, ConnectionAttemptError> {
  if (status.environmentId !== environment.environmentId) {
    return Effect.fail(
      new ConnectionBlockedError({
        reason: "configuration",
        detail: "Relay returned status for a different environment.",
      }),
    );
  }
  if (
    status.endpoint.httpBaseUrl !== environment.endpoint.httpBaseUrl ||
    status.endpoint.wsBaseUrl !== environment.endpoint.wsBaseUrl ||
    status.endpoint.providerKind !== environment.endpoint.providerKind
  ) {
    return Effect.fail(
      new ConnectionBlockedError({
        reason: "configuration",
        detail: "Relay returned status for a different environment endpoint.",
      }),
    );
  }
  if (
    status.descriptor !== undefined &&
    status.descriptor.environmentId !== environment.environmentId
  ) {
    return Effect.fail(
      new ConnectionBlockedError({
        reason: "configuration",
        detail: "Relay returned a descriptor for a different environment.",
      }),
    );
  }
  return Effect.succeed(status);
}

function relayAccountId(clerkToken: string): Option.Option<string> {
  try {
    return Option.fromNullishOr(decodeRelayJwt(clerkToken).sub).pipe(
      Option.filter((subject) => subject.length > 0),
    );
  } catch {
    return Option.none();
  }
}

export const make = Effect.fn("RelayEnvironmentDiscovery.make")(function* () {
  const relay = yield* ManagedRelay.ManagedRelayClient;
  const session = yield* ClientCapabilities.CloudSession;
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const connectivity = yield* Connectivity.Connectivity;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const state = yield* SubscriptionRef.make(EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE);
  const accountStates = yield* SubscriptionRef.make<
    ReadonlyMap<string, RelayEnvironmentDiscoveryState>
  >(new Map());
  const refreshLock = yield* Semaphore.make(1);
  const hasRefreshed = yield* Ref.make(false);
  const networkOffline = yield* Ref.make(false);
  // Bumped when an account's credentials change, so a response requested
  // before the change can no longer write that account's state.
  const accountGenerations = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const offlineReportFingerprints = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  const accountGeneration = (accountId: string) =>
    Ref.get(accountGenerations).pipe(Effect.map((current) => current.get(accountId) ?? 0));

  // Every write goes through here: the per-account map and the merged view
  // change together, and generation checks cannot interleave with a bump.
  const commit = (
    update: (
      current: ReadonlyMap<string, RelayEnvironmentDiscoveryState>,
    ) => Effect.Effect<ReadonlyMap<string, RelayEnvironmentDiscoveryState>>,
  ) =>
    SubscriptionRef.updateEffect(accountStates, (current) =>
      Effect.gen(function* () {
        const next = yield* update(current);
        yield* SubscriptionRef.set(state, mergeAccountStates(next, yield* Ref.get(networkOffline)));
        return next;
      }),
    );

  const updateAccount = Effect.fn("RelayEnvironmentDiscovery.updateAccount")(function* (
    accountId: string,
    generation: number,
    update: (current: RelayEnvironmentDiscoveryState) => RelayEnvironmentDiscoveryState,
  ) {
    yield* commit((current) =>
      accountGeneration(accountId).pipe(
        Effect.map((latest) =>
          latest === generation
            ? new Map(current).set(
                accountId,
                update(current.get(accountId) ?? EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE),
              )
            : current,
        ),
      ),
    );
  });

  // Drops the state of the given accounts, or of every account, and
  // invalidates whatever is still in flight for them.
  const forgetAccounts = Effect.fn("RelayEnvironmentDiscovery.forgetAccounts")(function* (
    accountIds: ReadonlySet<string> | undefined,
  ) {
    yield* commit((current) =>
      Effect.gen(function* () {
        const forgotten = accountIds ?? new Set(current.keys());
        yield* Ref.update(accountGenerations, (generations) => {
          const next = new Map(generations);
          for (const accountId of forgotten) {
            next.set(accountId, (next.get(accountId) ?? 0) + 1);
          }
          return next;
        });
        return new Map([...current].filter(([accountId]) => !forgotten.has(accountId)));
      }),
    );
  });

  const clearOfflineReport = Effect.fn("RelayEnvironmentDiscovery.clearOfflineReport")(function* (
    environmentId: string,
  ) {
    yield* Ref.update(offlineReportFingerprints, (current) => {
      if (!current.has(environmentId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });
  });

  const updateEnvironment = (
    accountId: string,
    generation: number,
    environmentId: string,
    update: (current: RelayDiscoveredEnvironment) => RelayDiscoveredEnvironment,
  ) =>
    updateAccount(accountId, generation, (current) => {
      const entry = current.environments.get(environmentId);
      if (entry === undefined) {
        return current;
      }
      const environments = new Map(current.environments);
      environments.set(environmentId, update(entry));
      return { ...current, environments };
    });

  const refreshStatus = Effect.fn("RelayEnvironmentDiscovery.refreshStatus")(function* (
    accountId: string,
    generation: number,
    clerkToken: string,
    environment: RelayClientEnvironmentRecord,
  ) {
    const result = yield* relay
      .getEnvironmentStatus({
        clerkToken,
        scopes: [RelayEnvironmentStatusScope, RelayEnvironmentConnectScope],
        environmentId: environment.environmentId,
      })
      .pipe(
        Effect.mapError(mapManagedRelayError),
        Effect.flatMap((status) => validateStatus(environment, status)),
        Effect.result,
      );

    if (result._tag === "Success") {
      if (result.success.status === "offline") {
        const fingerprint = `${result.success.endpoint.httpBaseUrl}\n${result.success.error ?? ""}`;
        const shouldReport = yield* Ref.modify(offlineReportFingerprints, (current) => {
          if (current.get(environment.environmentId) === fingerprint) {
            return [false, current];
          }
          return [true, new Map(current).set(environment.environmentId, fingerprint)];
        });
        if (shouldReport) {
          yield* Effect.logWarning("Relay environment health check reported offline", {
            environmentId: result.success.environmentId,
            endpoint: result.success.endpoint.httpBaseUrl,
            message: result.success.error,
            traceId: result.success.traceId,
          });
        }
      } else {
        yield* clearOfflineReport(environment.environmentId);
      }
      yield* updateEnvironment(accountId, generation, environment.environmentId, (current) => ({
        ...current,
        availability: result.success.status,
        status: Option.some(result.success),
        error: Option.none(),
      }));
      return;
    }

    yield* clearOfflineReport(environment.environmentId);
    yield* updateEnvironment(accountId, generation, environment.environmentId, (current) => ({
      ...current,
      availability: "error",
      error: Option.some(result.failure),
    }));
  });

  const refreshAccount = Effect.fn("RelayEnvironmentDiscovery.refreshAccount")(function* (
    accountId: string,
  ) {
    const generation = yield* accountGeneration(accountId);
    const settle = updateAccount(accountId, generation, (current) => ({
      ...current,
      refreshing: false,
    }));
    yield* Effect.gen(function* () {
      yield* updateAccount(accountId, generation, () => ({
        environments: new Map(),
        refreshing: true,
        offline: false,
        error: Option.none(),
      }));

      // Signed out is the idle state, not a failure: the proactive refresh on
      // a credentials change also runs on sign-out and must settle back to a
      // clean empty list. Only the session-level "no credentials" error is
      // benign — relay-side auth failures (expired/invalid tokens) happen
      // after this point and must surface as errors.
      const tokenResult = yield* Effect.result(session.clerkToken(accountId));
      if (tokenResult._tag === "Failure") {
        const failure = tokenResult.failure;
        if (failure._tag === "ConnectionBlockedError" && failure.reason === "authentication") {
          return yield* settle;
        }
        return yield* Effect.fail(failure);
      }
      const clerkToken = tokenResult.success;
      // A token for someone else would list that account's environments under
      // this one, so it is not used.
      const tokenAccountId = relayAccountId(clerkToken);
      if (Option.isSome(tokenAccountId) && tokenAccountId.value !== accountId) {
        return yield* new ConnectionBlockedError({
          reason: "authentication",
          detail: "The Connect session returned a token for a different account.",
        });
      }

      const environments = yield* relay
        .listEnvironments({ clerkToken })
        .pipe(Effect.mapError(mapManagedRelayError));
      const next = new Map<string, RelayDiscoveredEnvironment>();
      for (const environment of environments) {
        next.set(environment.environmentId, {
          environment,
          availability: "checking",
          status: Option.none(),
          error: Option.none(),
        });
      }
      yield* updateAccount(accountId, generation, (current) => ({
        ...current,
        environments: next,
      }));

      // The listing is the evidence of ownership the catalog adopts entries
      // on. It counts only when the token names this account and no
      // credentials change arrived while the request was out.
      if (Option.isSome(tokenAccountId) && (yield* accountGeneration(accountId)) === generation) {
        yield* registry
          .reconcileRelayEnvironments(
            accountId,
            environments.map((environment) => environment.environmentId),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not reconcile the catalog with the relay listing.", {
                error,
              }),
            ),
          );
      }

      yield* Effect.forEach(
        environments,
        (environment) => refreshStatus(accountId, generation, clerkToken, environment),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
      yield* settle;
    }).pipe(
      Effect.catch((error) =>
        updateAccount(accountId, generation, (current) => ({
          ...current,
          refreshing: false,
          error: Option.some(error),
        })),
      ),
    );
  });

  const markOffline = Ref.set(networkOffline, true).pipe(
    Effect.andThen(
      commit((current) =>
        Effect.succeed(
          new Map(
            [...current].map(([accountId, account]) => [
              accountId,
              { ...account, refreshing: false, offline: true },
            ]),
          ),
        ),
      ),
    ),
  );

  // Refreshes the given accounts, or every signed-in account.
  const refreshAccounts = (only?: ReadonlySet<string>) =>
    refreshLock.withPermits(1)(
      Effect.gen(function* () {
        yield* Ref.set(hasRefreshed, true);
        if ((yield* connectivity.status) === "offline") {
          return yield* markOffline;
        }
        yield* Ref.set(networkOffline, false);

        const accountIds = yield* session.accountIds;
        const signedOut = [...(yield* SubscriptionRef.get(accountStates)).keys()].filter(
          (accountId) => !accountIds.includes(accountId),
        );
        yield* forgetAccounts(new Set(signedOut));
        // Keeps the merged view in account order, primary first.
        yield* commit((current) =>
          Effect.succeed(
            new Map(
              accountIds.map((accountId) => [
                accountId,
                current.get(accountId) ?? EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
              ]),
            ),
          ),
        );
        yield* Effect.forEach(
          accountIds.filter((accountId) => only === undefined || only.has(accountId)),
          refreshAccount,
          { concurrency: "unbounded", discard: true },
        );
      }),
    );
  const refresh = refreshAccounts();

  yield* connectivity.changes.pipe(
    Stream.changes,
    Stream.runForEach((networkStatus) =>
      networkStatus === "offline"
        ? markOffline
        : Ref.get(hasRefreshed).pipe(
            Effect.flatMap((shouldRefresh) => (shouldRefresh ? refresh : Effect.void)),
          ),
    ),
    Effect.forkScoped,
  );
  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) =>
      ConnectionWakeups.isCredentialsChangeFor(reason, undefined)
        ? Effect.gen(function* () {
            // Only the accounts that signed in or out start over; the rest
            // keep their rows and their in-flight refresh.
            const changed = typeof reason === "string" ? undefined : reason.accountIds;
            yield* Ref.set(offlineReportFingerprints, new Map());
            yield* forgetAccounts(changed);
            // Refresh proactively — this wakeup fires when a session activates
            // (sign-in or cold start), and the list should be populated before
            // any screen asks for it. A signed-out refresh settles back to the
            // clean empty state.
            yield* refreshAccounts(changed).pipe(Effect.forkScoped);
          })
        : Effect.void,
    ),
    Effect.forkScoped,
  );

  return RelayEnvironmentDiscovery.of({ state, accountStates, refresh });
});

export const layer = Layer.effect(RelayEnvironmentDiscovery, make());
