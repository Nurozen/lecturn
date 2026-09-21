import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import * as RelayDb from "../db.ts";
import {
  relayEnvironmentLinks,
  relayEnvironmentLinkOwners,
  relayEnvironmentLinkCleanup,
} from "../persistence/schema.ts";
import { TeamRuntime } from "../teams/TeamRuntime.ts";
import { ManagedEndpointProvider } from "./ManagedEndpointProvider.ts";
import { EnvironmentCredentials } from "./EnvironmentCredentials.ts";

export class EnvironmentRelinkError extends Schema.TaggedErrorClass<EnvironmentRelinkError>()(
  "EnvironmentRelinkError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class EnvironmentRelinks extends Context.Service<
  EnvironmentRelinks,
  {
    readonly withLinkLock: <A, E, R>(
      environmentId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | EnvironmentRelinkError, R>;
    readonly displace: (input: {
      userId: string;
      environmentId: string;
    }) => Effect.Effect<void, EnvironmentRelinkError>;
    readonly drain: (environmentId?: string) => Effect.Effect<void, EnvironmentRelinkError>;
  }
>()("lecturn-relay/environments/EnvironmentRelinks") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const provider = yield* ManagedEndpointProvider;
  const credentials = yield* EnvironmentCredentials;
  const teams = yield* Effect.serviceOption(TeamRuntime);
  const lock = Effect.fn("relay.environment_relinks.lock")(function* (environmentId: string) {
    yield* db.$client`SET LOCAL lock_timeout = '5s'`;
    yield* db.insert(relayEnvironmentLinkOwners).values({ environmentId }).onConflictDoUpdate({
      target: relayEnvironmentLinkOwners.environmentId,
      set: { environmentId },
    });
  });
  const cleanup = Effect.fn("relay.environment_relinks.cleanup")(function* (environmentId: string) {
    const pending = yield* db
      .select()
      .from(relayEnvironmentLinkCleanup)
      .where(eq(relayEnvironmentLinkCleanup.environmentId, environmentId));
    for (const item of pending) {
      // Every host-approved relink takes the same environment lock and drains
      // old intents before preparing new team funding or endpoint generations.
      yield* provider.deprovision({ userId: item.userId, environmentId, target: item.target });
      if (Option.isSome(teams) && item.organizationId) {
        const current = yield* teams.value.funding(item.userId, environmentId);
        if (current?.organizationId === item.organizationId)
          yield* teams.value.unlinked(item.userId, environmentId);
      }
      yield* db
        .delete(relayEnvironmentLinkCleanup)
        .where(
          and(
            eq(relayEnvironmentLinkCleanup.environmentId, environmentId),
            eq(relayEnvironmentLinkCleanup.userId, item.userId),
          ),
        );
    }
  });
  const drainEnvironment = (environmentId: string) =>
    db.$client
      .withTransaction(
        Effect.gen(function* () {
          yield* lock(environmentId);
          yield* cleanup(environmentId);
        }),
      )
      .pipe(
        Effect.timeout("25 seconds"),
        Effect.mapError((cause) => new EnvironmentRelinkError({ environmentId, cause })),
      );

  const withLinkLock = <A, E, R>(environmentId: string, effect: Effect.Effect<A, E, R>) =>
    db.$client
      .withTransaction(
        Effect.gen(function* () {
          yield* lock(environmentId).pipe(
            Effect.mapError((cause) => new EnvironmentRelinkError({ environmentId, cause })),
          );
          yield* cleanup(environmentId).pipe(
            Effect.mapError((cause) => new EnvironmentRelinkError({ environmentId, cause })),
          );
          return yield* effect;
        }),
      )
      .pipe(
        Effect.timeout("25 seconds"),
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(new EnvironmentRelinkError({ environmentId, cause })),
        ),
        Effect.catchTag("TimeoutError", (cause) =>
          Effect.fail(new EnvironmentRelinkError({ environmentId, cause })),
        ),
        Effect.tap(() =>
          drainEnvironment(environmentId).pipe(
            Effect.tapError((error) => Effect.logWarning("Relink cleanup remains pending", error)),
            Effect.ignore,
          ),
        ),
      );

  const displace = Effect.fn("relay.environment_relinks.displace")(
    function* (input: { userId: string; environmentId: string; preservePublicKey?: string }) {
      const displaced = yield* db
        .select()
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            ne(relayEnvironmentLinks.userId, input.userId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        );
      const now = DateTime.formatIso(yield* DateTime.now);
      for (const link of displaced) {
        const target = yield* provider.prepareDeprovision({
          userId: link.userId,
          environmentId: input.environmentId,
        });
        const funding = Option.isSome(teams)
          ? yield* teams.value.funding(link.userId, input.environmentId)
          : undefined;
        yield* db
          .insert(relayEnvironmentLinkCleanup)
          .values({
            userId: link.userId,
            environmentId: input.environmentId,
            target,
            organizationId: funding?.organizationId ?? null,
          })
          .onConflictDoUpdate({
            target: [relayEnvironmentLinkCleanup.userId, relayEnvironmentLinkCleanup.environmentId],
            set: { target, organizationId: funding?.organizationId ?? null },
          });
        yield* db
          .update(relayEnvironmentLinks)
          .set({ revokedAt: now, updatedAt: now })
          .where(
            and(
              eq(relayEnvironmentLinks.environmentId, input.environmentId),
              eq(relayEnvironmentLinks.userId, link.userId),
            ),
          );
        if (link.environmentPublicKey !== input.preservePublicKey)
          yield* credentials.revokeForEnvironmentPublicKey({
            environmentId: input.environmentId,
            environmentPublicKey: link.environmentPublicKey,
          });
      }
    },
    Effect.mapError((cause) => new EnvironmentRelinkError({ environmentId: "displace", cause })),
  );
  return EnvironmentRelinks.of({
    withLinkLock,
    displace,
    drain: Effect.fn("relay.environment_relinks.drain")(function* (onlyEnvironmentId?: string) {
      const legacy = yield* db
        .select({ environmentId: relayEnvironmentLinkOwners.environmentId })
        .from(relayEnvironmentLinkOwners)
        .where(
          and(
            eq(relayEnvironmentLinkOwners.legacyCleanupPending, true),
            onlyEnvironmentId === undefined
              ? undefined
              : eq(relayEnvironmentLinkOwners.environmentId, onlyEnvironmentId),
          ),
        )
        .limit(100)
        .pipe(
          Effect.mapError(
            (cause) => new EnvironmentRelinkError({ environmentId: "legacy", cause }),
          ),
        );
      for (const { environmentId } of legacy) {
        yield* withLinkLock(
          environmentId,
          Effect.gen(function* () {
            const links = yield* db
              .select()
              .from(relayEnvironmentLinks)
              .where(
                and(
                  eq(relayEnvironmentLinks.environmentId, environmentId),
                  isNull(relayEnvironmentLinks.revokedAt),
                ),
              )
              .orderBy(
                desc(relayEnvironmentLinks.updatedAt),
                desc(relayEnvironmentLinks.createdAt),
                asc(relayEnvironmentLinks.userId),
              );
            const winner = links[0];
            if (winner && links.length > 1)
              yield* displace({
                userId: winner.userId,
                environmentId,
                preservePublicKey: winner.environmentPublicKey,
              });
            yield* db
              .update(relayEnvironmentLinkOwners)
              .set({ legacyCleanupPending: false })
              .where(eq(relayEnvironmentLinkOwners.environmentId, environmentId));
          }),
        ).pipe(Effect.mapError((cause) => new EnvironmentRelinkError({ environmentId, cause })));
      }
      const pending = yield* db
        .select({ environmentId: relayEnvironmentLinkCleanup.environmentId })
        .from(relayEnvironmentLinkCleanup)
        .where(
          onlyEnvironmentId === undefined
            ? undefined
            : eq(relayEnvironmentLinkCleanup.environmentId, onlyEnvironmentId),
        )
        .limit(100)
        .pipe(
          Effect.mapError(
            (cause) => new EnvironmentRelinkError({ environmentId: "pending", cause }),
          ),
        );
      for (const environmentId of new Set(pending.map((row) => row.environmentId)))
        yield* drainEnvironment(environmentId).pipe(
          Effect.tapError((error) => Effect.logWarning("Relink cleanup remains pending", error)),
          Effect.ignore,
        );
    }),
  });
});
export const layer = Layer.effect(EnvironmentRelinks, make);
