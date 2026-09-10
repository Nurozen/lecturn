import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { StaveLifecycleRepositoryLive } from "./StaveLifecycleRepository.ts";
import { StaveLifecycleRepository } from "../Services/StaveLifecycleRepository.ts";

const base = {
  workspaceRoot: "/space",
  spaceId: "space",
  manifestCreatedAt: "2026-01-01T00:00:00.000Z",
  now: "2026-01-01T00:00:00.000Z",
};
it.layer(StaveLifecycleRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "Stave lifecycle repository",
  (it) => {
    it.effect(
      "fences stale owners after expiry and preserves the schedule across renewals and transitions",
      () =>
        Effect.gen(function* () {
          const repo = yield* StaveLifecycleRepository;
          const projectId = ProjectId.make("lease");
          const initial = yield* repo.ensure({ ...base, projectId });
          const a = Option.getOrThrow(
            yield* repo.acquireLease({
              projectId,
              expectedEpoch: initial.leaseEpoch,
              ownerToken: "a",
              now: base.now,
              leaseUntil: "2026-01-01T00:01:00.000Z",
            }),
          );
          assert.equal(a.leaseEpoch, 1);
          const duplicateProjectId = ProjectId.make("duplicate-root");
          yield* repo.ensure({
            ...base,
            projectId: duplicateProjectId,
            now: "2026-01-01T00:00:01.000Z",
          });
          assert.equal(
            Option.getOrThrow(yield* repo.getByWorkspaceRoot(base.workspaceRoot)).ownerToken,
            "a",
          );
          assert.isTrue(
            Option.isNone(
              yield* repo.acquireLease({
                projectId: duplicateProjectId,
                expectedEpoch: 0,
                ownerToken: "duplicate",
                now: base.now,
                leaseUntil: "2026-01-01T00:01:00.000Z",
              }),
            ),
          );

          assert.isTrue(
            Option.isNone(
              yield* repo.acquireLease({
                projectId,
                expectedEpoch: 1,
                ownerToken: "b",
                now: base.now,
                leaseUntil: "2026-01-01T00:02:00.000Z",
              }),
            ),
          );
          const aLease = { projectId, leaseEpoch: a.leaseEpoch, ownerToken: "a", now: base.now };
          assert.isTrue(
            yield* repo.updateDisposition({
              ...aLease,
              patch: {
                disposition: "pending_archive",
                scheduledAt: base.now,
                archiveDeadlineAt: "2026-01-02T00:00:00.000Z",
              },
            }),
          );
          assert.isTrue(
            yield* repo.renewLease({ ...aLease, leaseUntil: "2026-01-01T00:02:00.000Z" }),
          );
          const later = "2026-01-01T00:03:00.000Z";
          const b = Option.getOrThrow(
            yield* repo.acquireLease({
              projectId,
              expectedEpoch: 1,
              ownerToken: "b",
              now: later,
              leaseUntil: "2026-01-01T00:04:00.000Z",
            }),
          );
          assert.equal(b.leaseEpoch, 2);
          assert.isFalse(
            yield* repo.updateDisposition({
              ...aLease,
              now: later,
              patch: { disposition: "destroyed" },
            }),
          );
          assert.isFalse(yield* repo.releaseLease({ ...aLease, now: later }));
          assert.isFalse(
            yield* repo.renewLease({
              ...aLease,
              now: later,
              leaseUntil: "2026-01-01T00:05:00.000Z",
            }),
          );
          assert.isTrue(
            yield* repo.updateDisposition({
              projectId,
              leaseEpoch: b.leaseEpoch,
              ownerToken: "b",
              now: later,
              patch: { disposition: "archived", scheduledAt: later },
            }),
          );
          const row = Option.getOrThrow(yield* repo.getByProjectId(projectId));
          assert.equal(row.disposition, "archived");
          assert.equal(row.scheduledAt, base.now);
          assert.equal(row.archiveDeadlineAt, "2026-01-02T00:00:00.000Z");
          assert.isFalse(
            yield* repo.markRefreshed({ projectId, updatedAt: base.now, refreshedAt: later }),
          );
          assert.isTrue(
            yield* repo.markRefreshed({ projectId, updatedAt: later, refreshedAt: later }),
          );
          assert.equal(
            (yield* repo.listUnrefreshed()).filter((row) => row.projectId === projectId).length,
            0,
          );
        }),
    );
    it.effect("does not reset an existing terminal disposition or identity on ensure", () =>
      Effect.gen(function* () {
        const repo = yield* StaveLifecycleRepository;
        const projectId = ProjectId.make("terminal");
        yield* repo.ensure({ ...base, projectId, workspaceRoot: "/terminal" });
        const row = Option.getOrThrow(
          yield* repo.acquireLease({
            projectId,
            expectedEpoch: 0,
            ownerToken: "owner",
            now: base.now,
            leaseUntil: "2026-01-01T00:01:00.000Z",
          }),
        );
        yield* repo.updateDisposition({
          projectId,
          leaseEpoch: row.leaseEpoch,
          ownerToken: "owner",
          now: base.now,
          patch: { disposition: "destroyed" },
        });
        const preserved = yield* repo.ensure({
          ...base,
          projectId,
          workspaceRoot: "/replacement",
          spaceId: "replacement",
        });
        assert.equal(preserved.disposition, "destroyed");
        assert.equal(preserved.workspaceRoot, "/terminal");
        assert.equal(preserved.spaceId, base.spaceId);
      }),
    );
  },
);
