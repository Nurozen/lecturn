/** Fresh saga merge observations keyed by project, independent of ordinary PR settlement. */
import type {
  OrchestrationProjectShell,
  ProjectId,
  StaveSagaMemberStatus,
  StaveSagaStatus,
} from "@lecturn/contracts";
import { Context, Effect, Layer } from "effect";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { StaveBinary } from "./StaveBinary.ts";
import { StaveCli } from "./StaveCli.ts";
import { sameManifestIncarnation } from "./StaveOperations.ts";

export function isMergedSagaMember(
  member: StaveSagaMemberStatus,
  notes: StaveSagaStatus["notes"],
): boolean {
  return (
    member.state === "live" &&
    member.repos.length > 0 &&
    member.repos.every((repo) => repo.baseHealth === "merged") &&
    !notes.some(
      (note) =>
        note.kind !== "suggestion" && (note.member === undefined || note.member === member.id),
    )
  );
}

export class StaveMergeSignal extends Context.Service<
  StaveMergeSignal,
  {
    readonly candidates: (
      projects: ReadonlyArray<OrchestrationProjectShell>,
    ) => Effect.Effect<ReadonlySet<ProjectId>>;
  }
>()("lecturn/stave/StaveMergeSignal") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const binary = yield* StaveBinary;
  const cli = yield* StaveCli;
  const candidates = Effect.fn("StaveMergeSignal.candidates")(
    function* (projects: ReadonlyArray<OrchestrationProjectShell>) {
      const result = new Set<ProjectId>();
      if (!config.staveEnabled) return result;
      const current = yield* settings.getSettings;
      if (!current.stave.enabled || !current.stave.lifecycle.settleOnSagaMerge) return result;
      const eligible = projects.filter(
        (project) =>
          project.stave?.state === "live" &&
          !project.stave.isSaga &&
          project.stave.createdAt !== undefined,
      );
      if (eligible.length === 0) return result;
      yield* binary.resolve;
      const rows = yield* cli.sagaList;
      if (rows.some((row) => row.error)) return result;
      for (const saga of rows.filter((row) => row.isSaga)) {
        const observed = yield* Effect.gen(function* () {
          const sagaId = saga.logicalId ?? saga.id;
          const coordinator = yield* cli.spaceStatus(sagaId);
          if (
            coordinator.spacePath !== saga.path ||
            coordinator.manifest.id !== sagaId ||
            coordinator.manifest.saga == null
          )
            return [];
          const status = yield* cli.sagaStatus(sagaId);
          if (status.sagaId !== sagaId) return [];
          const matches: ProjectId[] = [];
          for (const project of eligible) {
            const info = project.stave!;
            const member = status.members.find((member) => member.id === info.spaceId);
            const enrolled = coordinator.manifest.saga.members.find(
              (member) => member.id === info.spaceId,
            );
            if (
              member === undefined ||
              enrolled?.createdAt === undefined ||
              !sameManifestIncarnation(enrolled.createdAt, info.createdAt!) ||
              !isMergedSagaMember(member, status.notes)
            )
              continue;
            const disk = yield* cli.spaceStatus(info.spaceId);
            if (
              disk.spacePath === project.workspaceRoot &&
              disk.manifest.id === info.spaceId &&
              sameManifestIncarnation(disk.manifest.createdAt, info.createdAt!)
            )
              matches.push(project.id);
          }
          return matches;
        }).pipe(Effect.orElseSucceed(() => [] as ProjectId[]));
        for (const id of observed) result.add(id);
      }
      return result;
    },
    Effect.orElseSucceed(() => new Set<ProjectId>()),
  );
  return StaveMergeSignal.of({ candidates });
});
export const layer = Layer.effect(StaveMergeSignal, make);
