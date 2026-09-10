import { CommandId, type StaveLifecycleActionOperation } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import { ServerConfig } from "../../config.ts";
import {
  StaveLifecycleRepository,
  type StaveLifecycleRow,
  type StaveLifecyclePatch,
} from "../../persistence/Services/StaveLifecycleRepository.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import { StaveCli } from "../../stave/StaveCli.ts";
import { StaveBinary } from "../../stave/StaveBinary.ts";
import { StaveOperations, StaveRefusalError } from "../../stave/StaveOperations.ts";
import { StaveSpaceLock } from "../../stave/StaveSpaceLock.ts";
import { StaveWorkspaceReader } from "../../stave/StaveWorkspaceReader.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { StaveLifecycleService } from "../Services/StaveLifecycleService.ts";
import { evaluateDeletedProject, resolveArchiveDeadline } from "../StaveLifecyclePolicy.ts";

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const binary = yield* StaveBinary;
  const cli = yield* Effect.serviceOption(StaveCli);
  const repo = yield* StaveLifecycleRepository;
  const reader = yield* StaveWorkspaceReader;
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const deletion = yield* ThreadDeletionReactor;
  const operations = yield* StaveOperations;
  const locks = yield* StaveSpaceLock;
  const fs = yield* FileSystem.FileSystem;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const refusal = (message: string) =>
    new StaveRefusalError({ code: "space_transitioning", message, details: null });
  const enabled = Effect.gen(function* () {
    if (!config.staveEnabled) return false;
    const current = yield* settings.getSettings;
    if (!current.stave.enabled) return false;
    return yield* binary.resolve.pipe(
      Effect.match({ onFailure: () => false, onSuccess: () => true }),
    );
  });
  const refresh = (row: StaveLifecycleRow) =>
    Effect.gen(function* () {
      const project = yield* snapshots.getProjectShellById(row.projectId);
      if (Option.isSome(project))
        yield* engine.dispatch({
          type: "project.refresh",
          projectId: row.projectId,
          commandId: CommandId.make(
            `server:stave:refresh:${row.projectId}:${NodeCrypto.randomUUID()}`,
          ),
          createdAt: yield* nowIso,
        });
      yield* repo.markRefreshed({
        projectId: row.projectId,
        updatedAt: row.updatedAt,
        refreshedAt: yield* nowIso,
      });
    });
  const update = (row: StaveLifecycleRow, patch: StaveLifecyclePatch, reset = false) =>
    locks.withSpaceLock(
      row.workspaceRoot,
      Effect.gen(function* () {
        const current = yield* repo.getByProjectId(row.projectId);
        if (
          Option.isNone(current) ||
          current.value.updatedAt !== row.updatedAt ||
          current.value.leaseEpoch !== row.leaseEpoch
        )
          return;
        const now = yield* nowIso;
        const ownerToken = `server:stave:schedule:${NodeCrypto.randomUUID()}`;
        const acquired = yield* repo.acquireLease({
          projectId: row.projectId,
          expectedEpoch: current.value.leaseEpoch,
          ownerToken,
          now,
          leaseUntil: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { minutes: 1 })),
        });
        if (Option.isNone(acquired)) return;
        const lease = {
          projectId: row.projectId,
          leaseEpoch: acquired.value.leaseEpoch,
          ownerToken,
          now,
        };
        yield* Effect.gen(function* () {
          if (reset)
            yield* repo.resetScheduleEpisode({
              ...lease,
              anchorAt: patch.anchorAt ?? null,
              scheduledAt: patch.scheduledAt ?? null,
              archiveDeadlineAt: patch.archiveDeadlineAt ?? null,
              disposition: patch.disposition === "pending_archive" ? "pending_archive" : "live",
            });
          else yield* repo.updateDisposition({ ...lease, patch });
        }).pipe(Effect.ensuring(repo.releaseLease(lease).pipe(Effect.ignore)));
      }),
    );
  const validateParticipant = (projectId: StaveLifecycleRow["projectId"]) =>
    Effect.gen(function* () {
      const policy = (yield* settings.getSettings).stave.lifecycle;
      const row = yield* repo.getByProjectId(projectId);
      const active = yield* snapshots.getProjectShellById(projectId);
      if (Option.isSome(active) && active.value.stave?.state === "archived") return;
      if (
        Option.isNone(active) ||
        Option.isNone(row) ||
        active.value.workspaceRoot !== row.value.workspaceRoot ||
        (yield* repo.isScheduleResetRequested(projectId)) ||
        !["pending_archive", "archiving"].includes(row.value.disposition)
      )
        return yield* refusal("A saga member has no eligible archive schedule.");
      const anchors = yield* snapshots.listThreadLifecycleAnchorsByProjectId(projectId);
      const decision = resolveArchiveDeadline({
        anchors,
        row: row.value,
        graceDays: policy.onAllThreadsSettled === "archive" ? 0 : policy.archiveGraceDays,
        now: yield* nowIso,
      });
      if (
        decision === null ||
        decision.kept ||
        decision.reset ||
        Date.parse(decision.deadlineAt) > Date.parse(yield* nowIso)
      )
        return yield* refusal(
          "A saga member is active, kept, or still inside its archive grace window.",
        );
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "StaveRefusalError" ? error : refusal(error.message),
      ),
    );
  const sagaReady = (
    project: Effect.Success<ReturnType<typeof snapshots.getShellSnapshot>>["projects"][number],
  ) =>
    Effect.gen(function* () {
      if (!project.stave?.isSaga) return true;
      if (Option.isNone(cli)) return false;
      const status = yield* cli.value.spaceStatus(project.stave.spaceId);
      if (status.manifest.saga == null) return false;
      const snapshot = yield* snapshots.getShellSnapshot();
      for (const member of status.manifest.saga.members) {
        const active = snapshot.projects.find(
          (candidate) => candidate.stave?.spaceId === member.id && candidate.stave.state === "live",
        );
        if (active === undefined) continue;
        const checked = yield* validateParticipant(active.id).pipe(
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        );
        if (!checked) return false;
      }
      return true;
    });
  const execute = (
    row: StaveLifecycleRow,
    target: "archive" | "destroy",
    automaticArchive: boolean,
  ) =>
    Effect.gen(function* () {
      const current = yield* settings.getSettings;
      const operation: StaveLifecycleActionOperation = {
        kind: "lifecycleAction",
        projectId: row.projectId,
        workspaceRoot: row.workspaceRoot,
        ...(row.manifestCreatedAt === null
          ? {}
          : { expectedManifestCreatedAt: row.manifestCreatedAt }),
        action: "retry",
        target,
        force: false,
        memory: target === "archive" ? "keep" : current.stave.lifecycle.memoryFateOnDestroy,
        sagaRemoveConfirmed: row.sagaRemoveConfirmed,
        ...(row.sagaTeardown === null
          ? {}
          : { expectedSagaReview: row.sagaTeardown.expectedSagaReview }),
      };
      const validate = Effect.gen(function* () {
        if (!(yield* enabled)) return yield* refusal("Stave cleanup is disabled.");
        const latest = yield* settings.getSettings.pipe(
          Effect.mapError((error) => refusal(error.message)),
        );
        if (!automaticArchive) {
          const intent = yield* repo
            .getByProjectId(row.projectId)
            .pipe(Effect.mapError((error) => refusal(error.message)));
          if (
            row.deleteIntentSequence === null ||
            Option.isNone(intent) ||
            intent.value.deleteIntentSequence !== row.deleteIntentSequence ||
            !["pending_destroy", "pending_archive", "destroying", "archiving"].includes(
              intent.value.disposition,
            )
          )
            return yield* refusal("This cleanup was dismissed or its delete intent changed.");
          if (latest.stave.lifecycle.onProjectDelete !== target)
            return yield* refusal("The deletion policy changed before cleanup.");
          if (
            !(yield* repo
              .isProjectDeleted(row.projectId)
              .pipe(Effect.mapError((error) => refusal(error.message))))
          )
            return yield* refusal("The project is no longer deleted.");
          return;
        }
        const mode = latest.stave.lifecycle.onAllThreadsSettled;
        if (mode !== "archive" && mode !== "archive-after-grace")
          return yield* refusal("Automatic archiving was disabled.");
        const bound = yield* snapshots
          .getProjectShellById(row.projectId)
          .pipe(Effect.mapError((error) => refusal(error.message)));
        if (
          Option.isNone(bound) ||
          bound.value.workspaceRoot !== row.workspaceRoot ||
          (yield* repo
            .isScheduleResetRequested(row.projectId)
            .pipe(Effect.mapError((error) => refusal(error.message))))
        )
          return yield* refusal("The project binding or archive schedule changed.");
        const anchors = yield* snapshots
          .listThreadLifecycleAnchorsByProjectId(row.projectId)
          .pipe(Effect.mapError((error) => refusal(error.message)));
        const fresh = yield* repo
          .getByProjectId(row.projectId)
          .pipe(Effect.mapError((error) => refusal(error.message)));
        const decision = resolveArchiveDeadline({
          anchors,
          row: Option.getOrNull(fresh),
          graceDays: mode === "archive" ? 0 : latest.stave.lifecycle.archiveGraceDays,
          now: yield* nowIso,
        });
        if (
          decision === null ||
          decision.kept ||
          decision.anchorAt !== row.anchorAt ||
          Date.parse(decision.deadlineAt) > Date.parse(yield* nowIso)
        )
          return yield* refusal("Thread activity changed the archive schedule.");
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "StaveRefusalError" ? error : refusal(error.message),
        ),
      );
      yield* operations
        .executeLifecycle(operation, validate, automaticArchive ? validateParticipant : undefined)
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const failed = yield* repo.getByProjectId(row.projectId);
              if (
                Option.isSome(failed) &&
                failed.value.deleteIntentSequence === row.deleteIntentSequence &&
                failed.value.anchorAt === row.anchorAt &&
                ["pending_destroy", "pending_archive", "pending_evaluation"].includes(
                  failed.value.disposition,
                )
              )
                yield* update(failed.value, {
                  disposition: "refused",
                  refusalCode: error.code,
                  refusalMessage: error.message,
                });
              return yield* error;
            }),
          ),
        );
    });
  const processDeleted = (row: StaveLifecycleRow) =>
    Effect.gen(function* () {
      if (!(yield* repo.isProjectDeleted(row.projectId))) return;
      if (
        row.disposition === "refused" ||
        (row.leaseUntil !== null && Date.parse(row.leaseUntil) > Date.parse(yield* nowIso))
      )
        return;
      if (["destroyed", "archived", "kept", "not_stave"].includes(row.disposition)) {
        yield* update(row, {
          deleteIntentSequence: null,
          ...(row.disposition === "archived" ? { disposition: "kept" as const } : {}),
        });
        return;
      }
      const current = yield* settings.getSettings;
      yield* reader.invalidate(row.workspaceRoot);
      const manifest = yield* reader.load(row.workspaceRoot);
      if (
        Option.isNone(manifest) &&
        row.manifestCreatedAt !== null &&
        (yield* fs.exists(row.workspaceRoot))
      ) {
        yield* update(row, {
          disposition: "refused",
          refusalCode: "unreadable",
          refusalMessage: "The recorded space root exists but its manifest cannot be read.",
        });
        return;
      }
      const decision = evaluateDeletedProject(
        row,
        Option.getOrNull(manifest),
        current.stave.lifecycle,
      );
      yield* update(row, {
        disposition: decision.disposition,
        refusalCode: decision.code ?? null,
        refusalMessage: decision.message ?? null,
        ...(["kept", "not_stave", "destroyed"].includes(decision.disposition)
          ? { deleteIntentSequence: null }
          : {}),
      });
      if (decision.disposition !== "pending_destroy" && decision.disposition !== "pending_archive")
        return;
      if (row.deleteIntentSequence !== null) yield* deletion.drainThrough(row.deleteIntentSequence);
      const fresh = yield* repo.getByProjectId(row.projectId);
      if (
        Option.isSome(fresh) &&
        fresh.value.deleteIntentSequence === row.deleteIntentSequence &&
        fresh.value.disposition === decision.disposition
      )
        yield* execute(
          fresh.value,
          decision.disposition === "pending_destroy" ? "destroy" : "archive",
          false,
        );
    });
  const processLive = (
    project: Effect.Success<ReturnType<typeof snapshots.getShellSnapshot>>["projects"][number],
  ) =>
    Effect.gen(function* () {
      if (project.stave == null || project.stave.state !== "live") return;
      const current = yield* settings.getSettings;
      const policy = current.stave.lifecycle;
      const now = yield* nowIso;
      let row = yield* repo.ensure({
        projectId: project.id,
        workspaceRoot: project.workspaceRoot,
        spaceId: project.stave.spaceId,
        manifestCreatedAt: project.stave.createdAt ?? null,
        now,
      });
      if (
        row.deleteIntentSequence !== null ||
        (row.leaseUntil !== null && Date.parse(row.leaseUntil) > Date.parse(yield* nowIso)) ||
        ["archiving", "destroying", "restoring"].includes(row.disposition)
      )
        return;
      if (yield* repo.isScheduleResetRequested(project.id)) {
        yield* update(row, { disposition: "live" }, true);
        row = Option.getOrThrow(yield* repo.getByProjectId(project.id));
        if (yield* repo.isScheduleResetRequested(project.id)) return;
      }
      const anchors = yield* snapshots.listThreadLifecycleAnchorsByProjectId(project.id);
      const decision = resolveArchiveDeadline({
        anchors,
        row,
        graceDays: policy.onAllThreadsSettled === "archive" ? 0 : policy.archiveGraceDays,
        now,
      });
      if (decision === null || policy.onAllThreadsSettled === "nothing") {
        if (row.anchorAt !== null || row.disposition === "pending_archive")
          yield* update(row, { disposition: "live" }, true);
        return;
      }
      if (decision.kept || (row.disposition === "refused" && !decision.reset)) return;
      const deadline = policy.onAllThreadsSettled === "suggest" ? null : decision.deadlineAt;
      if (
        decision.reset ||
        row.disposition !== "pending_archive" ||
        row.archiveDeadlineAt !== deadline
      )
        yield* update(
          row,
          {
            disposition: "pending_archive",
            anchorAt: decision.anchorAt,
            scheduledAt: decision.scheduledAt,
            archiveDeadlineAt: deadline,
          },
          decision.reset,
        );
      if (deadline === null || Date.parse(deadline) > Date.parse(now)) return;
      if (!(yield* sagaReady(project))) return;
      const fresh = yield* repo.getByProjectId(project.id);
      if (Option.isSome(fresh)) yield* execute(fresh.value, "archive", true);
    });
  const safely = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Stave lifecycle candidate retained for review", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const observePolicy = (current: Effect.Success<typeof settings.getSettings>) =>
    repo.observePolicy({
      enabled: config.staveEnabled && current.stave.enabled,
      archiveMode: current.stave.lifecycle.onAllThreadsSettled,
    });
  const sweep = Effect.gen(function* () {
    yield* observePolicy(yield* settings.getSettings);
    yield* repo.releaseExpiredLeases(yield* nowIso);
    if (!(yield* enabled)) return;
    yield* safely(operations.reconcileIncomplete);
    for (const row of yield* repo.listPending()) {
      if (!(yield* enabled)) return;
      if (row.deleteIntentSequence !== null) yield* safely(processDeleted(row));
    }
    const snapshot = yield* snapshots.getShellSnapshot();
    for (const project of snapshot.projects) {
      if (!(yield* enabled)) return;
      yield* safely(processLive(project));
    }
    for (const row of yield* repo.listUnrefreshed()) yield* safely(refresh(row));
  }).pipe(safely, Effect.asVoid);
  const worker = yield* makeDrainableWorker(() => sweep);
  const start: StaveLifecycleService["Service"]["start"] = Effect.fn("StaveLifecycleService.start")(
    function* () {
      const changes = yield* settings.subscribeChanges;
      const initial = yield* settings.getSettings.pipe(Effect.orDie);
      yield* observePolicy(initial).pipe(Effect.orDie);
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue(undefined);
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
      );
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) =>
          event.type === "project.refreshed" ? Effect.void : worker.enqueue(undefined),
        ),
      );
      yield* forkParked(
        Stream.runForEach(changes, (current) =>
          observePolicy(current).pipe(Effect.andThen(worker.enqueue(undefined)), safely),
        ),
      );
    },
  );
  return { start, drain: worker.drain, sweep } satisfies StaveLifecycleService["Service"];
});
export const layer = Layer.effect(StaveLifecycleService, make);
