import { ProjectId } from "@lecturn/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
      "rebinds a stale active-project root and fills the new incarnation without inheriting its old episode",
      () =>
        Effect.gen(function* () {
          const repo = yield* StaveLifecycleRepository;
          const sql = yield* SqlClient.SqlClient;
          const projectId = ProjectId.make("rebound");
          yield* repo.ensure({ ...base, projectId, workspaceRoot: "/old-root" });
          yield* sql`UPDATE stave_project_lifecycle SET disposition = 'pending_archive', scheduled_at = ${base.now}, anchor_at = ${base.now}, archive_deadline_at = ${base.now} WHERE project_id = ${projectId}`;
          yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId}, 'Rebound', '/new-root', '[]', ${base.now}, ${base.now})`;
          const row = yield* repo.ensure({
            ...base,
            projectId,
            workspaceRoot: "/new-root",
            spaceId: "new",
            manifestCreatedAt: "2026-01-02T00:00:00.000Z",
          });
          assert.equal(row.workspaceRoot, "/new-root");
          assert.equal(row.spaceId, "new");
          assert.equal(row.manifestCreatedAt, "2026-01-02T00:00:00.000Z");
          assert.equal(row.disposition, "pending_evaluation");
          assert.isNull(row.scheduledAt);
          assert.isNull(row.archiveDeadlineAt);
          assert.equal(row.leaseEpoch, 1);
        }),
    );
    it.effect("persists reset intent until the lease owner resets the episode", () =>
      Effect.gen(function* () {
        const repo = yield* StaveLifecycleRepository;
        const projectId = ProjectId.make("durable-reset");
        yield* repo.ensure({ ...base, projectId, workspaceRoot: "/durable-reset" });
        const held = Option.getOrThrow(
          yield* repo.acquireLease({
            projectId,
            expectedEpoch: 0,
            ownerToken: "owner",
            now: base.now,
            leaseUntil: "2026-01-01T00:02:00.000Z",
          }),
        );
        const lease = {
          projectId,
          leaseEpoch: held.leaseEpoch,
          ownerToken: "owner",
          now: base.now,
        };
        yield* repo.updateDisposition({
          ...lease,
          patch: { disposition: "pending_archive", scheduledAt: base.now },
        });
        yield* repo.observePolicy({ enabled: false, archiveMode: "archive-after-grace" });
        yield* repo.observePolicy({ enabled: true, archiveMode: "archive-after-grace" });
        assert.isTrue(yield* repo.isScheduleResetRequested(projectId));
        const reset = {
          ...lease,
          disposition: "live" as const,
          anchorAt: null,
          scheduledAt: null,
          archiveDeadlineAt: null,
        };
        assert.isFalse(yield* repo.resetScheduleEpisode({ ...reset, ownerToken: "stranger" }));
        assert.isTrue(yield* repo.isScheduleResetRequested(projectId));
        assert.isTrue(yield* repo.resetScheduleEpisode(reset));
        assert.isFalse(yield* repo.isScheduleResetRequested(projectId));
      }),
    );
    it.effect(
      "clears expired abandoned owners but preserves incomplete transition journals and active leases",
      () =>
        Effect.gen(function* () {
          const repo = yield* StaveLifecycleRepository;
          for (const disposition of ["live", "archiving", "pending_evaluation"] as const) {
            const projectId = ProjectId.make(`expired-${disposition}`);
            yield* repo.ensure({ ...base, projectId, workspaceRoot: `/${projectId}` });
            yield* repo.acquireLease({
              projectId,
              expectedEpoch: 0,
              ownerToken: "owner",
              now: base.now,
              leaseUntil:
                disposition === "pending_evaluation"
                  ? "2026-01-01T00:10:00.000Z"
                  : "2026-01-01T00:01:00.000Z",
            });
            yield* repo.updateDisposition({
              projectId,
              leaseEpoch: 1,
              ownerToken: "owner",
              now: base.now,
              patch: { disposition },
            });
          }
          yield* repo.releaseExpiredLeases("2026-01-01T00:02:00.000Z");
          assert.isNull(
            Option.getOrThrow(yield* repo.getByProjectId(ProjectId.make("expired-live")))
              .ownerToken,
          );
          assert.equal(
            Option.getOrThrow(yield* repo.getByProjectId(ProjectId.make("expired-archiving")))
              .ownerToken,
            "owner",
          );
          assert.equal(
            Option.getOrThrow(
              yield* repo.getByProjectId(ProjectId.make("expired-pending_evaluation")),
            ).ownerToken,
            "owner",
          );
        }),
    );

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
    it.effect("resets and clears schedule episodes only for the unexpired lease owner", () =>
      Effect.gen(function* () {
        const repo = yield* StaveLifecycleRepository;
        const projectId = ProjectId.make("schedule-reset");
        yield* repo.ensure({ ...base, projectId, workspaceRoot: "/schedule-reset" });
        yield* repo.acquireLease({
          projectId,
          expectedEpoch: 0,
          ownerToken: "owner",
          now: base.now,
          leaseUntil: "2026-01-01T00:05:00.000Z",
        });
        const lease = { projectId, leaseEpoch: 1, ownerToken: "owner", now: base.now };
        yield* repo.updateDisposition({
          ...lease,
          patch: {
            disposition: "refused",
            scheduledAt: base.now,
            refusalCode: "dirty_worktrees",
            refusalMessage: "Dirty",
          },
        });
        yield* repo.markRefreshed({ projectId, updatedAt: base.now, refreshedAt: base.now });
        const reset = {
          ...lease,
          now: "2026-01-01T00:01:00.000Z",
          anchorAt: "2026-01-01T00:01:00.000Z",
          scheduledAt: "2026-01-01T00:01:00.000Z",
          archiveDeadlineAt: "2026-01-08T00:01:00.000Z",
          disposition: "pending_archive" as const,
        };
        assert.isFalse(yield* repo.resetScheduleEpisode({ ...reset, ownerToken: "stranger" }));
        assert.isFalse(yield* repo.resetScheduleEpisode({ ...reset, leaseEpoch: 0 }));
        assert.isFalse(
          yield* repo.resetScheduleEpisode({ ...reset, now: "2026-01-01T00:05:00.000Z" }),
        );
        assert.equal(
          Option.getOrThrow(yield* repo.getByProjectId(projectId)).scheduledAt,
          base.now,
        );
        assert.isTrue(yield* repo.resetScheduleEpisode(reset));
        const scheduled = Option.getOrThrow(yield* repo.getByProjectId(projectId));
        assert.equal(scheduled.scheduledAt, reset.scheduledAt);
        assert.equal(scheduled.anchorAt, reset.anchorAt);
        assert.equal(scheduled.archiveDeadlineAt, reset.archiveDeadlineAt);
        assert.equal(scheduled.refusalCode, null);
        assert.equal(scheduled.refusalMessage, null);
        assert.equal(scheduled.refreshedAt, null);
        assert.equal(scheduled.updatedAt, reset.now);
        assert.isTrue(
          yield* repo.resetScheduleEpisode({
            ...reset,
            disposition: "live",
            anchorAt: null,
            scheduledAt: null,
            archiveDeadlineAt: null,
          }),
        );
        const active = Option.getOrThrow(yield* repo.getByProjectId(projectId));
        assert.equal(active.disposition, "live");
        assert.equal(active.anchorAt, null);
        assert.equal(active.scheduledAt, null);
        assert.equal(active.archiveDeadlineAt, null);
      }),
    );
    it.effect("lists only projected deleted projects with actionable delete intents", () =>
      Effect.gen(function* () {
        const repo = yield* StaveLifecycleRepository;
        const sql = yield* SqlClient.SqlClient;
        const cases = [
          ["pending", "pending_evaluation", true, true],
          ["destroy", "pending_destroy", true, true],
          ["archive", "pending_archive", true, true],
          ["refused", "refused", true, true],
          ["live", "pending_archive", false, true],
          ["no-intent", "refused", true, false],
          ["terminal", "destroyed", true, true],
          ["busy", "destroying", true, true],
          ["unprojected", "refused", null, true],
        ] as const;
        for (const [name, disposition, deleted, intent] of cases) {
          const projectId = ProjectId.make(`cleanup-${name}`);
          if (deleted !== null) {
            yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
              VALUES (${projectId}, ${name}, ${`/cleanup-${name}`}, '[]', ${base.now}, ${base.now}, ${deleted ? base.now : null})`;
          }
          assert.equal(yield* repo.isProjectDeleted(projectId), deleted === true);
          yield* repo.ensure({ ...base, projectId, workspaceRoot: `/cleanup-${name}` });
          yield* repo.acquireLease({
            projectId,
            expectedEpoch: 0,
            ownerToken: "owner",
            now: base.now,
            leaseUntil: "2026-01-01T00:01:00.000Z",
          });
          yield* repo.updateDisposition({
            projectId,
            leaseEpoch: 1,
            ownerToken: "owner",
            now: base.now,
            patch: { disposition, deleteIntentSequence: intent ? 42 : null },
          });
        }
        assert.deepEqual(
          (yield* repo.listDeletedCleanups()).map((entry) => entry.projectId),
          ["cleanup-archive", "cleanup-destroy", "cleanup-pending", "cleanup-refused"],
        );
        assert.isTrue(
          (yield* repo.listPending()).some((entry) => entry.projectId === "cleanup-live"),
        );
        assert.isFalse(yield* repo.isProjectDeleted(ProjectId.make("absent")));
      }),
    );
  },
);
