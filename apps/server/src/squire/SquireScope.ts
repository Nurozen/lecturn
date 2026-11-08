import {
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type SquireGrantKind,
  type SquireId,
  type SquireRuleTargetKind,
  ThreadId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import * as SquireContainers from "./SquireContainers.ts";
import type { SquirePolicyTarget } from "./squirePolicy.ts";
import * as SquireRepository from "./SquireRepository.ts";
import { isSquireThread } from "./squireThread.ts";

export type SquireScopeError = PersistenceSqlError | ProjectionStore.ProjectionStoreV2Error;

type Grant = { readonly kind: SquireGrantKind; readonly targetId: string };
type ThreadTarget = SquirePolicyTarget & { readonly threadId: ThreadId };
type ContainerTarget = Omit<ThreadTarget, "threadId">;

const usesStave = (grants: ReadonlyArray<Grant>) =>
  grants.some((grant) => grant.kind === "staveSpace" || grant.kind === "staveSaga");

/** A project, Stave space, or saga grant holding the target's project. */
const containerCovers = (grant: Grant, target: ContainerTarget): boolean => {
  switch (grant.kind) {
    case "project":
      return grant.targetId === target.projectId;
    case "staveSpace":
      return grant.targetId === target.staveSpaceId;
    case "staveSaga":
      return grant.targetId === target.staveSagaId;
    case "thread":
    case "exclusion":
      return false;
  }
};

/** An exclusion on the thread beats every container grant. */
const grantsCover = (grants: ReadonlyArray<Grant>, target: ThreadTarget): boolean => {
  if (grants.some((grant) => grant.kind === "exclusion" && grant.targetId === target.threadId)) {
    return false;
  }
  return grants.some(
    (grant) =>
      (grant.kind === "thread" && grant.targetId === target.threadId) ||
      containerCovers(grant, target),
  );
};

interface IndexedSquire {
  readonly id: SquireId;
  readonly grants: ReadonlyArray<Grant>;
}

interface GrantIndex {
  readonly generation: number;
  /** Earliest-created first, the tie-break order of `squirePolicy.autoHolder`. */
  readonly squires: ReadonlyArray<IndexedSquire>;
}

export class SquireScope extends Context.Service<
  SquireScope,
  {
    /** Squires tracking the thread, earliest-created first so callers can pick the Auto holder. */
    readonly trackersOf: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<SquireId>, SquireScopeError>;
    readonly isTracked: (
      squireId: SquireId,
      threadId: ThreadId,
    ) => Effect.Effect<boolean, SquireScopeError>;
    /**
     * Squires whose project, Stave space, or saga grant holds the project,
     * earliest-created first. Thread grants and exclusions name threads, not
     * the project, so they neither add nor remove cover here.
     */
    readonly projectCoverersOf: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<SquireId>, SquireScopeError>;
    /**
     * The thread and the containers rules can name; None for a thread no
     * Squire may track (missing, deleted, archived, settled, or a Squire thread).
     */
    readonly targetOf: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ThreadTarget>, SquireScopeError>;
    /**
     * A rule's thread target must be tracked, a container target must be one
     * of the Squire's own grants. Reads grants uncached, so a caller inside a
     * repository transaction sees its own uncommitted grant writes.
     */
    readonly ruleTargetInScope: (input: {
      readonly squireId: SquireId;
      readonly targetKind: SquireRuleTargetKind;
      readonly targetId: string;
    }) => Effect.Effect<boolean, SquireScopeError>;
  }
>()("lecturn/squire/SquireScope") {}

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const containers = yield* SquireContainers.SquireContainers;
  const cached = yield* Ref.make<Option.Option<GrantIndex>>(Option.none());

  const toGrants = (rows: ReadonlyArray<SquireRepository.SquireGrantRow>) =>
    rows.map((row): Grant => ({ kind: row.kind, targetId: row.target_id }));

  // Grants change rarely and are read on every reactor event; any committed
  // repository change bumps the generation and drops the index.
  const loadIndex = Effect.gen(function* () {
    const generation = yield* repository.changeGeneration;
    const current = yield* Ref.get(cached);
    if (Option.isSome(current) && current.value.generation === generation) return current.value;
    // Creation order: `listSquires` breaks a created_at tie by rowid, and the
    // stable sort keeps it, so tie-breaks downstream never fall to random ids.
    const rows = (yield* repository.listSquires)
      .filter((row) => row.role === "squire" && row.lifecycle !== "deleting")
      .toSorted((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const squires = yield* Effect.forEach(rows, (row) =>
      repository
        .listGrants(row.id)
        .pipe(Effect.map((grants): IndexedSquire => ({ id: row.id, grants: toGrants(grants) }))),
    );
    const index: GrantIndex = { generation, squires };
    yield* Ref.set(cached, Option.some(index));
    return index;
  });

  // Shells are read fresh: settle, archive, or delete must untrack before the next decision.
  // Even a thread grant does not reach a settled thread: nothing reads, reports on, or steers it until it is
  // unsettled, and then its grants apply again.
  const trackableShell = (threadId: ThreadId) =>
    projections
      .getThreadShell(threadId)
      .pipe(
        Effect.map((shell): OrchestrationV2ThreadShell | null =>
          shell === null ||
          shell.archivedAt !== null ||
          shell.settledAt !== null ||
          isSquireThread(shell)
            ? null
            : shell,
        ),
      );

  const containersOf = Effect.fn("SquireScope.containersOf")(function* (
    projectId: ProjectId,
    withStave: boolean,
  ) {
    const stave = withStave
      ? yield* containers.ofProject(projectId)
      : { status: "unknown" as const };
    return {
      projectId,
      staveSpaceId: stave.status === "known" ? stave.spaceId : null,
      staveSagaId: stave.status === "known" ? stave.sagaId : null,
    } satisfies ContainerTarget;
  });

  const toTarget = (shell: OrchestrationV2ThreadShell, withStave: boolean) =>
    containersOf(shell.projectId, withStave).pipe(
      Effect.map((target): ThreadTarget => ({ threadId: shell.id, ...target })),
    );

  const trackersOf: SquireScope["Service"]["trackersOf"] = Effect.fn("SquireScope.trackersOf")(
    function* (threadId) {
      const shell = yield* trackableShell(threadId);
      if (shell === null) return [];
      const { squires } = yield* loadIndex;
      const target = yield* toTarget(
        shell,
        squires.some((squire) => usesStave(squire.grants)),
      );
      return squires.filter((squire) => grantsCover(squire.grants, target)).map(({ id }) => id);
    },
  );

  const isTracked: SquireScope["Service"]["isTracked"] = Effect.fn("SquireScope.isTracked")(
    function* (squireId, threadId) {
      const shell = yield* trackableShell(threadId);
      if (shell === null) return false;
      const squire = (yield* loadIndex).squires.find((candidate) => candidate.id === squireId);
      if (squire === undefined) return false;
      return grantsCover(squire.grants, yield* toTarget(shell, usesStave(squire.grants)));
    },
  );

  const projectCoverersOf: SquireScope["Service"]["projectCoverersOf"] = Effect.fn(
    "SquireScope.projectCoverersOf",
  )(function* (projectId) {
    const { squires } = yield* loadIndex;
    const target = yield* containersOf(
      projectId,
      squires.some((squire) => usesStave(squire.grants)),
    );
    return squires
      .filter((squire) => squire.grants.some((grant) => containerCovers(grant, target)))
      .map(({ id }) => id);
  });

  const targetOf: SquireScope["Service"]["targetOf"] = Effect.fn("SquireScope.targetOf")(
    function* (threadId) {
      const shell = yield* trackableShell(threadId);
      return shell === null ? Option.none() : Option.some(yield* toTarget(shell, true));
    },
  );

  const ruleTargetInScope: SquireScope["Service"]["ruleTargetInScope"] = Effect.fn(
    "SquireScope.ruleTargetInScope",
  )(function* ({ squireId, targetKind, targetId }) {
    const squire = yield* repository.getSquire(squireId);
    if (Option.isNone(squire) || squire.value.role !== "squire") return false;
    const grants = toGrants(yield* repository.listGrants(squireId));
    if (targetKind !== "thread") {
      return grants.some((grant) => grant.kind === targetKind && grant.targetId === targetId);
    }
    const shell = yield* trackableShell(ThreadId.make(targetId));
    return shell !== null && grantsCover(grants, yield* toTarget(shell, usesStave(grants)));
  });

  return SquireScope.of({
    trackersOf,
    isTracked,
    projectCoverersOf,
    targetOf,
    ruleTargetInScope,
  });
});

export const layer = Layer.effect(SquireScope, make);
