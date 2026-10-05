import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@lecturn/contracts/relay";
import type { EnvironmentId } from "@lecturn/contracts";
import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
} from "@lecturn/contracts/relay";
import { decodeRelayJwt } from "@lecturn/shared/relayJwt";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { findErrorTraceId } from "../errors/errorTrace.ts";
import * as ManagedRelay from "./managedRelay.ts";
import { relayProtectedErrorMessage } from "./errorPresentation.ts";

const DEFAULT_STALE_TIME_MS = 15_000;
const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const CLERK_TOKEN_EXPIRY_SKEW_MS = 5_000;
const isManagedRelayRequestFailedError = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);

export interface ManagedRelaySession {
  readonly accountId: string;
  readonly readClerkToken: () => Effect.Effect<string | null, ManagedRelaySessionError>;
}

export interface ManagedRelaySessionInput {
  readonly accountId: string;
  readonly readClerkToken: () => Promise<string | null>;
}

interface ManagedRelaySessionControl {
  readonly updateReadClerkToken: (
    readClerkToken: ManagedRelaySessionInput["readClerkToken"],
  ) => void;
}

export interface ManagedRelaySnapshotState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly errorTraceId: string | null;
  readonly isPending: boolean;
}

export interface ManagedRelayQueryEvent {
  readonly operation: "environments" | "devices" | "environment-status";
  readonly stage: "clerk-token" | "relay-request" | "validation";
  readonly phase: "start" | "success" | "failure";
  readonly accountId: string;
  readonly environmentId?: string;
  readonly message?: string;
  readonly traceId?: string | null;
}

export class ManagedRelaySessionError extends Data.TaggedError("ManagedRelaySessionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ManagedRelaySnapshotError extends Data.TaggedError("ManagedRelaySnapshotError")<{
  readonly message: string;
}> {}

/** Signed-in Connect accounts and their sessions, in the order they were added. */
export const managedRelaySessionsAtom = Atom.make<ReadonlyMap<string, ManagedRelaySession>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:sessions"));

const managedRelayPrimaryAccountIdAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("managed-relay:primary-account"),
);

/**
 * The primary account's session, for readers that still act on one account.
 * Resolves to the designated primary account, else the first signed-in account.
 */
export const managedRelaySessionAtom = Atom.make((get): ManagedRelaySession | null => {
  const sessions = get(managedRelaySessionsAtom);
  const primaryAccountId = get(managedRelayPrimaryAccountIdAtom);
  const primary = primaryAccountId === null ? undefined : sessions.get(primaryAccountId);
  return primary ?? sessions.values().next().value ?? null;
}).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:session"));

/** One account's session. Unlike the map, it only changes when that account's session does. */
export const managedRelayAccountSessionAtom = Atom.family((accountId: string) =>
  Atom.make((get) => get(managedRelaySessionsAtom).get(accountId) ?? null).pipe(
    Atom.withLabel(`managed-relay:session:${accountId}`),
  ),
);

const managedRelaySessionControls = new WeakMap<ManagedRelaySession, ManagedRelaySessionControl>();

export function createManagedRelaySession(input: ManagedRelaySessionInput): ManagedRelaySession {
  let cachedToken: { readonly token: string; readonly expiresAtMillis: number } | null = null;
  let pendingToken: Promise<string | null> | null = null;
  let readClerkToken = input.readClerkToken;
  let tokenProviderGeneration = 0;

  const readCachedClerkToken = async (nowMillis: number): Promise<string | null> => {
    if (cachedToken && cachedToken.expiresAtMillis > nowMillis + CLERK_TOKEN_EXPIRY_SKEW_MS) {
      return cachedToken.token;
    }
    if (pendingToken) {
      return await pendingToken;
    }

    const operationGeneration = tokenProviderGeneration;
    const operation = readClerkToken().then((token) => {
      if (operationGeneration !== tokenProviderGeneration) {
        return token;
      }
      if (!token) {
        cachedToken = null;
        return null;
      }
      try {
        const expiresAtSeconds = decodeRelayJwt(token).exp;
        cachedToken =
          typeof expiresAtSeconds === "number"
            ? { token, expiresAtMillis: expiresAtSeconds * 1_000 }
            : null;
      } catch {
        cachedToken = null;
      }
      return token;
    });
    pendingToken = operation;
    try {
      return await operation;
    } finally {
      if (pendingToken === operation) {
        pendingToken = null;
      }
    }
  };

  const session: ManagedRelaySession = {
    accountId: input.accountId,
    readClerkToken: Effect.fn("clientRuntime.managedRelaySession.readClerkToken")(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise({
        try: () => readCachedClerkToken(nowMillis),
        catch: (cause) =>
          new ManagedRelaySessionError({
            message: "Could not obtain the Lecturn Connect session token.",
            cause,
          }),
      });
    }),
  };
  managedRelaySessionControls.set(session, {
    updateReadClerkToken: (nextReadClerkToken) => {
      readClerkToken = nextReadClerkToken;
      tokenProviderGeneration += 1;
      pendingToken = null;
    },
  });
  return session;
}

/** Replaces the signed-in accounts. Sessions are added, updated, and removed by diff. */
export function syncManagedRelaySessions(
  registry: AtomRegistry.AtomRegistry,
  accounts: ReadonlyArray<ManagedRelaySessionInput>,
): void {
  const current = registry.get(managedRelaySessionsAtom);
  const next = new Map<string, ManagedRelaySession>();
  for (const [accountId, session] of current) {
    if (accounts.some((input) => input.accountId === accountId)) {
      next.set(accountId, session);
    }
  }
  let changed = next.size !== current.size;
  for (const input of accounts) {
    const existing = next.get(input.accountId);
    const control = existing && managedRelaySessionControls.get(existing);
    if (control) {
      // Clerk can replace its token reader during routine same-account refreshes.
      // Keep the session stable so those refreshes do not invalidate queries or reconnect leases.
      control.updateReadClerkToken(input.readClerkToken);
      continue;
    }
    next.set(input.accountId, createManagedRelaySession(input));
    changed = true;
  }
  if (changed) {
    registry.set(managedRelaySessionsAtom, next);
  }
}

/** Single-account producers: the one signed-in account, or null when signed out. */
export function setManagedRelaySession(
  registry: AtomRegistry.AtomRegistry,
  input: ManagedRelaySessionInput | null,
): void {
  syncManagedRelaySessions(registry, input === null ? [] : [input]);
}

/** Designates the account that `managedRelaySessionAtom` resolves to. */
export function setManagedRelayPrimaryAccount(
  registry: AtomRegistry.AtomRegistry,
  accountId: string | null,
): void {
  registry.set(managedRelayPrimaryAccountIdAtom, accountId);
}

/** Signed-in account IDs, primary account first. */
export function managedRelayAccountIds(registry: AtomRegistry.AtomRegistry): ReadonlyArray<string> {
  const accountIds = [...registry.get(managedRelaySessionsAtom).keys()];
  const primary = registry.get(managedRelaySessionAtom)?.accountId;
  return primary === undefined
    ? accountIds
    : [primary, ...accountIds.filter((accountId) => accountId !== primary)];
}

export interface ManagedRelayAccountChange {
  readonly added: ReadonlySet<string>;
  readonly removed: ReadonlySet<string>;
}

export function managedRelayAccountChanges(
  registry: AtomRegistry.AtomRegistry,
): Stream.Stream<ManagedRelayAccountChange> {
  return AtomRegistry.toStream(registry, managedRelaySessionsAtom).pipe(
    Stream.zipWithPrevious,
    Stream.map(([previous, sessions]): ManagedRelayAccountChange => {
      const before = Option.getOrElse(previous, () => sessions);
      return {
        added: new Set([...sessions.keys()].filter((accountId) => !before.has(accountId))),
        removed: new Set([...before.keys()].filter((accountId) => !sessions.has(accountId))),
      };
    }),
    Stream.filter((change) => change.added.size > 0 || change.removed.size > 0),
  );
}

function readSessionClerkToken(
  session: ManagedRelaySession,
): Effect.Effect<string, ManagedRelaySessionError> {
  return session.readClerkToken().pipe(
    Effect.flatMap((token) =>
      token
        ? Effect.succeed(token)
        : Effect.fail(
            new ManagedRelaySessionError({
              message: "The Lecturn Connect session token is unavailable.",
            }),
          ),
    ),
  );
}

export const waitForManagedRelayClerkToken = Effect.fn(
  "clientRuntime.managedRelaySession.waitForClerkToken",
)(function* (registry: AtomRegistry.AtomRegistry, accountId: string) {
  return yield* Effect.callback<string, ManagedRelaySessionError>((resume) => {
    let unsubscribe: (() => void) | undefined;
    let completed = false;
    const readCurrentSession = () => {
      if (completed) {
        return true;
      }
      const session = registry.get(managedRelaySessionsAtom).get(accountId);
      if (!session) {
        return false;
      }
      completed = true;
      unsubscribe?.();
      resume(readSessionClerkToken(session));
      return true;
    };

    if (readCurrentSession()) {
      return;
    }

    unsubscribe = registry.subscribe(managedRelaySessionsAtom, readCurrentSession);
    readCurrentSession();
    return Effect.sync(() => unsubscribe?.());
  });
});

/** Removes an environment from one signed-in account without contacting that environment. */
export const deregisterManagedRelayEnvironment = Effect.fn(
  "clientRuntime.managedRelaySession.deregisterEnvironment",
)(function* (
  registry: AtomRegistry.AtomRegistry,
  input: { readonly accountId: string; readonly environmentId: EnvironmentId },
) {
  const session = registry.get(managedRelaySessionsAtom).get(input.accountId);
  if (!session) {
    return yield* new ManagedRelaySessionError({
      message: "Sign in to Lecturn Connect before deregistering an environment.",
    });
  }
  const clerkToken = yield* readSessionClerkToken(session);
  const relay = yield* ManagedRelay.ManagedRelayClient;
  yield* relay.unlinkEnvironment({ clerkToken, environmentId: input.environmentId });
});

function requireClerkToken(
  get: Atom.AtomContext,
  accountId: string,
): Effect.Effect<string, ManagedRelaySessionError> {
  const session = get(managedRelayAccountSessionAtom(accountId));
  if (!session) {
    return Effect.fail(
      new ManagedRelaySessionError({
        message: "Sign in to Lecturn Connect before loading relay data.",
      }),
    );
  }
  return readSessionClerkToken(session);
}

function statusKey(input: {
  readonly accountId: string;
  readonly environment: RelayClientEnvironmentRecord;
}): string {
  return JSON.stringify(input);
}

function parseStatusKey(key: string): {
  readonly accountId: string;
  readonly environment: RelayClientEnvironmentRecord;
} {
  return JSON.parse(key) as {
    readonly accountId: string;
    readonly environment: RelayClientEnvironmentRecord;
  };
}

function endpointMatches(
  left: RelayClientEnvironmentRecord["endpoint"],
  right: RelayClientEnvironmentRecord["endpoint"],
): boolean {
  return (
    left.httpBaseUrl === right.httpBaseUrl &&
    left.wsBaseUrl === right.wsBaseUrl &&
    left.providerKind === right.providerKind
  );
}

function validateEnvironmentStatus(
  environment: RelayClientEnvironmentRecord,
  status: RelayEnvironmentStatusResponse,
): Effect.Effect<RelayEnvironmentStatusResponse, ManagedRelaySnapshotError> {
  if (status.environmentId !== environment.environmentId) {
    return Effect.fail(
      new ManagedRelaySnapshotError({
        message: "Relay returned status for a different environment.",
      }),
    );
  }
  if (!endpointMatches(status.endpoint, environment.endpoint)) {
    return Effect.fail(
      new ManagedRelaySnapshotError({
        message: "Relay returned status for a different endpoint.",
      }),
    );
  }
  if (status.descriptor && status.descriptor.environmentId !== environment.environmentId) {
    return Effect.fail(
      new ManagedRelaySnapshotError({
        message: "Relay returned status descriptor for a different environment.",
      }),
    );
  }
  return Effect.succeed(status);
}

export function readManagedRelaySnapshotState<A>(
  result: AsyncResult.AsyncResult<A, unknown>,
): ManagedRelaySnapshotState<A> {
  let error: string | null = null;
  let errorTraceId: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error =
      isManagedRelayRequestFailedError(cause) && cause.relayError
        ? relayProtectedErrorMessage(cause.relayError)
        : cause instanceof Error
          ? cause.message
          : "Could not load Lecturn Connect data.";
    errorTraceId = findErrorTraceId(cause);
  }
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error,
    errorTraceId,
    isPending: result.waiting,
  };
}

export function createManagedRelayQueryManager(
  runtime: Atom.AtomRuntime<ManagedRelay.ManagedRelayClient>,
  options?: {
    readonly staleTimeMs?: number;
    readonly idleTtlMs?: number;
    readonly onQueryEvent?: (event: ManagedRelayQueryEvent) => void;
  },
) {
  const staleTime = options?.staleTimeMs ?? DEFAULT_STALE_TIME_MS;
  const idleTtl = options?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const observe = <A, E, R>(
    input: Omit<ManagedRelayQueryEvent, "phase" | "message" | "traceId">,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      options?.onQueryEvent?.({ ...input, phase: "start" });
      return yield* effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (exit._tag === "Success") {
              options?.onQueryEvent?.({ ...input, phase: "success" });
              return;
            }
            const error = Cause.squash(exit.cause);
            options?.onQueryEvent?.({
              ...input,
              phase: "failure",
              message: error instanceof Error ? error.message : String(error),
              traceId: findErrorTraceId(error),
            });
          }),
        ),
      );
    });

  const environmentsAtom = Atom.family((accountId: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const base = { operation: "environments" as const, accountId };
          const clerkToken = yield* observe(
            { ...base, stage: "clerk-token" },
            requireClerkToken(get, accountId),
          );
          const relay = yield* ManagedRelay.ManagedRelayClient;
          return yield* observe(
            { ...base, stage: "relay-request" },
            relay.listEnvironments({ clerkToken }),
          );
        }),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:environments:${accountId}`),
      ),
  );

  const devicesAtom = Atom.family((accountId: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const base = { operation: "devices" as const, accountId };
          const clerkToken = yield* observe(
            { ...base, stage: "clerk-token" },
            requireClerkToken(get, accountId),
          );
          const relay = yield* ManagedRelay.ManagedRelayClient;
          return yield* observe(
            { ...base, stage: "relay-request" },
            relay.listDevices({ clerkToken }),
          );
        }),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:devices:${accountId}`),
      ),
  );

  const environmentStatusAtom = Atom.family((key: string) => {
    const { accountId, environment } = parseStatusKey(key);
    return runtime
      .atom((get) =>
        Effect.gen(function* () {
          const base = {
            operation: "environment-status" as const,
            accountId,
            environmentId: environment.environmentId,
          };
          const clerkToken = yield* observe(
            { ...base, stage: "clerk-token" },
            requireClerkToken(get, accountId),
          );
          const relay = yield* ManagedRelay.ManagedRelayClient;
          const status = yield* observe(
            { ...base, stage: "relay-request" },
            relay.getEnvironmentStatus({
              clerkToken,
              scopes: [RelayEnvironmentStatusScope, RelayEnvironmentConnectScope],
              environmentId: environment.environmentId,
            }),
          );
          return yield* observe(
            { ...base, stage: "validation" },
            validateEnvironmentStatus(environment, status),
          );
        }),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:environment-status:${key}`),
      );
  });

  return {
    environmentsAtom,
    devicesAtom,
    environmentStatusAtom: (input: {
      readonly accountId: string;
      readonly environment: RelayClientEnvironmentRecord;
    }) => environmentStatusAtom(statusKey(input)),
    refreshEnvironments(registry: AtomRegistry.AtomRegistry, accountId: string): void {
      registry.refresh(environmentsAtom(accountId));
    },
    refreshDevices(registry: AtomRegistry.AtomRegistry, accountId: string): void {
      registry.refresh(devicesAtom(accountId));
    },
    refreshEnvironmentStatus(
      registry: AtomRegistry.AtomRegistry,
      input: {
        readonly accountId: string;
        readonly environment: RelayClientEnvironmentRecord;
      },
    ): void {
      registry.refresh(environmentStatusAtom(statusKey(input)));
    },
  };
}
