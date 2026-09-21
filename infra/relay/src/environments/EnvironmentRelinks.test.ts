import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as RelayDb from "../db.ts";
import {
  relayEnvironmentLinks,
  relayEnvironmentLinkCleanup,
  relayEnvironmentLinkOwners,
} from "../persistence/schema.ts";
import { TeamRuntime } from "../teams/TeamRuntime.ts";
import {
  ManagedEndpointProvider,
  ManagedEndpointDeprovisioningFailed,
} from "./ManagedEndpointProvider.ts";
import { EnvironmentCredentials } from "./EnvironmentCredentials.ts";
import { EnvironmentRelinks, layer } from "./EnvironmentRelinks.ts";

type Row = Record<string, unknown>;
function fixture() {
  const links: Row[] = [
    {
      userId: "A",
      environmentId: "env",
      environmentPublicKey: "key",
      revokedAt: null,
      updatedAt: "2026-01-01",
      createdAt: "2026-01-01",
    },
  ];
  const pending: Row[] = [];
  const owners: Row[] = [];
  const events: string[] = [];
  let failCleanup = true;
  let funding: { organizationId: string } | undefined = { organizationId: "old-team" };
  const rows = (table: unknown) =>
    table === relayEnvironmentLinks
      ? links
      : table === relayEnvironmentLinkCleanup
        ? pending
        : owners;
  const client = Object.assign(() => Effect.void, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const snapshots = [links, pending, owners].map((table) => table.map((row) => ({ ...row })));
        return yield* effect.pipe(
          Effect.tapError(() =>
            Effect.sync(() =>
              [links, pending, owners].forEach((table, i) =>
                table.splice(0, table.length, ...snapshots[i]!),
              ),
            ),
          ),
        );
      }),
  });
  const db = {
    $client: client,
    select: () => ({
      from: (table: unknown) => {
        const selected = () =>
          rows(table).filter((row) =>
            table === relayEnvironmentLinks
              ? row.revokedAt === null
              : table === relayEnvironmentLinkOwners
                ? row.legacyCleanupPending === true
                : true,
          );
        const result = () =>
          Object.assign(Effect.sync(selected), {
            limit: () => Effect.sync(selected),
            orderBy: () => Effect.sync(selected),
          });
        return { where: result, limit: () => Effect.sync(selected) };
      },
    }),
    insert: (table: unknown) => ({
      values: (value: Row) => ({
        onConflictDoUpdate: () =>
          Effect.sync(() => {
            const existing = rows(table).find(
              (row) => row.userId === value.userId && row.environmentId === value.environmentId,
            );
            if (existing) Object.assign(existing, value);
            else rows(table).push({ ...value });
          }),
      }),
    }),
    update: (table: unknown) => ({
      set: (value: Row) => ({
        where: () => Effect.sync(() => rows(table).forEach((row) => Object.assign(row, value))),
      }),
    }),
    delete: (table: unknown) => ({
      where: () =>
        Effect.sync(() => {
          rows(table).splice(0);
        }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
  const provider = {
    prepareDeprovision: () => Effect.succeed({ allocation: null, reservationGeneration: 7 }),
    deprovision: (input: { target?: { reservationGeneration: number | null } | null }) =>
      Effect.gen(function* () {
        expect(input.target?.reservationGeneration).toBe(7);
        events.push("deprovision");
        if (failCleanup)
          return yield* new ManagedEndpointDeprovisioningFailed({
            userId: "A",
            environmentId: "env",
            stage: "load-allocation",
            cause: "fixture failure",
          });
      }),
  } as unknown as ManagedEndpointProvider["Service"];
  const service = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RelayDb.RelayDb, db),
        Layer.succeed(ManagedEndpointProvider, provider),
        Layer.succeed(EnvironmentCredentials, {
          revokeForEnvironmentPublicKey: () =>
            Effect.sync(() => {
              events.push("revoke-credential");
              return true;
            }),
        } as unknown as EnvironmentCredentials["Service"]),
        Layer.succeed(TeamRuntime, {
          funding: () => Effect.succeed(funding),
          unlinked: () =>
            Effect.sync(() => {
              events.push("release-team");
              funding = undefined;
            }),
        } as unknown as TeamRuntime["Service"]),
      ),
    ),
  );
  return {
    service,
    links,
    pending,
    owners,
    events,
    setFail: (value: boolean) => {
      failCleanup = value;
    },
    setFunding: (value: string) => {
      funding = { organizationId: value };
    },
  };
}

describe("EnvironmentRelinks", () => {
  it.effect("rolls back displacement and cleanup intent when the replacement link fails", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const relinks = yield* EnvironmentRelinks;
      const result = yield* Effect.result(
        relinks.withLinkLock(
          "env",
          Effect.gen(function* () {
            yield* relinks.displace({ userId: "B", environmentId: "env" });
            return yield* Effect.fail("replacement failed");
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(f.links[0]!.revokedAt).toBeNull();
      expect(f.pending).toEqual([]);
      expect(f.events).not.toContain("deprovision");
    }).pipe(Effect.provide(f.service));
  });
  it.effect("commits revocation and durable cleanup before a failed teardown, then retries", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const relinks = yield* EnvironmentRelinks;
      yield* relinks.withLinkLock("env", relinks.displace({ userId: "B", environmentId: "env" }));
      expect(f.links[0]!.revokedAt).not.toBeNull();
      expect(f.pending).toHaveLength(1);
      expect(f.events).toEqual(["revoke-credential", "deprovision"]);
      f.setFail(false);
      yield* relinks.drain("env");
      expect(f.pending).toEqual([]);
      expect(f.events).toEqual(["revoke-credential", "deprovision", "deprovision", "release-team"]);
    }).pipe(Effect.provide(f.service));
  });
  it.effect(
    "blocks relink-back until prior cleanup finishes before preparing new resources",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const relinks = yield* EnvironmentRelinks;
        yield* relinks.withLinkLock("env", relinks.displace({ userId: "B", environmentId: "env" }));
        let prepared = false;
        const prepare = Effect.sync(() => {
          prepared = true;
          f.events.push("prepare-new");
        });
        expect((yield* Effect.result(relinks.withLinkLock("env", prepare)))._tag).toBe("Failure");
        expect(prepared).toBe(false);
        f.setFail(false);
        yield* relinks.withLinkLock("env", prepare);
        expect(f.events.indexOf("release-team")).toBeLessThan(f.events.indexOf("prepare-new"));
      }).pipe(Effect.provide(f.service));
    },
  );
  it.effect("does not release funding that belongs to a different organization", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const relinks = yield* EnvironmentRelinks;
      yield* relinks.withLinkLock("env", relinks.displace({ userId: "B", environmentId: "env" }));
      f.setFunding("new-team");
      f.setFail(false);
      yield* relinks.drain("env");
      expect(f.events).not.toContain("release-team");
    }).pipe(Effect.provide(f.service));
  });
});
