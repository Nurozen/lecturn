import { ProjectId, type SagaWorkbenchIdentity } from "@lecturn/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { layer, make } from "./SagaWorkbenchRepository.ts";
import { emptyWorkflow, SagaWorkbenchRepository } from "../Services/SagaWorkbenchRepository.ts";
const identity: SagaWorkbenchIdentity = {
  projectId: ProjectId.make("test"),
  workspaceRoot: "/space",
  spaceId: "space",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const saveInput = (revision: number, requestId: string) => ({
  identity,
  actorKey: "human:session",
  requestId,
  requestHash: `hash-${requestId}`,
  expectedRevision: revision,
  workflow: { ...emptyWorkflow(identity), revision: revision + 1, stage: "build" as const },
  activity: {
    revision: revision + 1,
    at: identity.createdAt,
    action: "stage",
    subject: "human",
    sessionId: "session",
    detail: "Build",
  },
});
it.layer(layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "Saga workbench persistence",
  (it) => {
    it.effect("persists across service reconstruction and isolates new incarnations", () =>
      Effect.gen(function* () {
        const repo = yield* SagaWorkbenchRepository;
        yield* repo.save(saveInput(0, "persist"));
        const restarted = yield* make;
        assert.equal((yield* restarted.get(identity)).stage, "build");
        assert.equal(
          (yield* restarted.get({ ...identity, createdAt: "2026-02-01T00:00:00.000Z" })).revision,
          0,
        );
      }),
    );
    it.effect("resolves archived history only for one exact project and incarnation", () =>
      Effect.gen(function* () {
        const repo = yield* SagaWorkbenchRepository;
        const historical = { ...identity, projectId: ProjectId.make("archived-history") };
        const input = {
          ...saveInput(0, "history"),
          identity: historical,
          workflow: { ...emptyWorkflow(historical), revision: 1, completedAt: identity.createdAt },
        };
        yield* repo.save(input);
        const archived = { ...historical, workspaceRoot: "/.archive/space" };
        assert.equal(
          (yield* repo.findIncarnation(archived))?.identity.workspaceRoot,
          historical.workspaceRoot,
        );
        assert.equal(
          yield* repo.findIncarnation({ ...archived, createdAt: "2026-03-01T00:00:00.000Z" }),
          null,
        );
        assert.equal(
          yield* repo.findIncarnation({ ...archived, projectId: ProjectId.make("unrelated") }),
          null,
        );
        yield* repo.save({
          ...input,
          identity: archived,
          requestId: "ambiguous",
          workflow: { ...input.workflow, identity: archived },
        });
        assert.equal(yield* repo.findIncarnation(archived), null);
      }),
    );
    it.effect("CAS refuses stale writes and request retries preserve one activity", () =>
      Effect.gen(function* () {
        const repo = yield* SagaWorkbenchRepository;
        const current = yield* repo.get(identity);
        const input = saveInput(current.revision, "retry");
        const first = yield* repo.save(input);
        assert.deepEqual(yield* repo.save(input), first);
        const result = yield* repo.save({ ...input, requestId: "stale" }).pipe(Effect.result);
        assert.equal(Result.isFailure(result) && result.failure.code, "conflict");
        const reused = yield* repo
          .receipt({ ...input, requestHash: "different" })
          .pipe(Effect.result);
        assert.equal(Result.isFailure(reused) && reused.failure.code, "conflict");
        assert.equal(
          (yield* repo.activity(identity)).filter((row) => row.revision === first.revision).length,
          1,
        );
      }),
    );
    it.effect("projection resets do not erase workflow rows; activity is bounded", () =>
      Effect.gen(function* () {
        const repo = yield* SagaWorkbenchRepository;
        const sql = yield* SqlClient.SqlClient;
        let revision = (yield* repo.get(identity)).revision;
        for (let i = 0; i < 205; i++) {
          yield* repo.save(saveInput(revision, `bounded-${i}`));
          revision++;
        }
        yield* sql`DELETE FROM projection_state`;
        assert.equal((yield* repo.get(identity)).revision, revision);
        assert.equal((yield* repo.activity(identity)).length, 200);
      }),
    );
  },
);
