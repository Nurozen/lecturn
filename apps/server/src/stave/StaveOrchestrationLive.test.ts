/**
 * V2 reads behind StaveOrchestration and StaveProjectShells (re-expressed from
 * the V1 ProjectionSnapshotQuery Stave cases).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, ProjectId, ThreadId } from "@lecturn/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { StaveLifecycleRepositoryLive } from "../persistence/Layers/StaveLifecycleRepository.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { StaveOrchestration } from "./StaveOrchestration.ts";
import * as StaveOrchestrationLive from "./StaveOrchestrationLive.ts";
import * as StaveProjectShells from "./StaveProjectShells.ts";
import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const LATER = "2026-01-02T00:00:00.000Z";

const layer = StaveOrchestrationLive.layer.pipe(
  Layer.provideMerge(StaveProjectShells.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      ProjectStore.layer,
      StaveLifecycleRepositoryLive,
      Layer.mock(StaveWorkspaceReader)({
        load: (root) =>
          Effect.succeed(
            root === "/space"
              ? Option.some({
                  spaceId: "space",
                  isSaga: false,
                  state: "live" as const,
                  repos: [],
                  memories: [],
                })
              : Option.none(),
          ),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
      Layer.mock(OrchestrationEventStore)({}),
    ),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const insertThread = (input: {
  readonly id: string;
  readonly projectId: string;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
  readonly settledAt?: string | null;
  readonly relationship?: "fork" | "subagent" | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = yield* toJson({
      createdAt: NOW,
      settledAt: input.settledAt ?? null,
      unsettledAt: null,
      settledOverride: null,
      lineage: {
        rootThreadId: input.id,
        parentThreadId: input.relationship ? "parent" : null,
        relationshipToParent: input.relationship ?? null,
      },
    });
    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, archived_at, deleted_at, payload_json)
      VALUES (${input.id}, ${input.projectId}, ${input.id}, 'codex', 'full-access', 'default', ${NOW}, ${LATER}, ${input.archivedAt ?? null}, ${input.deletedAt ?? null}, ${payload})`;
  });

const insertMessage = (input: {
  readonly id: string;
  readonly threadId: string;
  readonly runId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  readonly streaming?: boolean;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${input.id}, ${input.threadId}, ${input.runId}, NULL, ${input.role}, ${input.streaming ? 1 : 0}, ${input.createdAt}, ${input.createdAt}, ${yield* toJson({ text: input.text })})`;
  });

it.layer(layer)("StaveOrchestrationLive reads", (it) => {
  it.effect("returns every app thread lifecycle anchor, including deleted and archived rows", () =>
    Effect.gen(function* () {
      for (const id of ["active", "archived", "deleted"])
        yield* insertThread({
          id,
          projectId: "anchor-project",
          settledAt: NOW,
          archivedAt: id === "archived" ? NOW : null,
          deletedAt: id === "deleted" ? NOW : null,
        });
      yield* insertThread({ id: "forked", projectId: "anchor-project", relationship: "fork" });
      // Provider subagent threads are not user activity episodes.
      yield* insertThread({
        id: "subagent",
        projectId: "anchor-project",
        relationship: "subagent",
      });
      const orchestration = yield* StaveOrchestration;
      const rows = yield* orchestration.listThreadLifecycleAnchorsByProjectId(
        ProjectId.make("anchor-project"),
      );
      assert.deepEqual(
        rows.map((row) => row.threadId),
        ["active", "archived", "deleted", "forked"],
      );
      assert.equal(rows[0]?.createdAt, NOW);
      assert.equal(rows[0]?.settledAt, NOW);
      assert.equal(rows[0]?.updatedAt, LATER);
      assert.equal(rows[1]?.archivedAt, NOW);
      assert.equal(rows[2]?.deletedAt, NOW);
      assert.isNull(rows[3]?.settledAt);
    }),
  );

  it.effect("pairs the last three completed user turns before a boundary message", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = "inference-thread";
      for (const [ordinal, status] of [
        [1, "completed"],
        [2, "completed"],
        [3, "failed"],
        [4, "completed"],
        [5, "completed"],
        [6, "completed"],
      ] as const) {
        const runId = `run-${ordinal}`;
        const at = `2026-01-01T00:0${ordinal}:00.000Z`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
          VALUES (${runId}, ${threadId}, ${ordinal}, 'codex', NULL, ${status}, ${at}, ${`2026-01-01T00:0${ordinal}:30.000Z`}, ${yield* toJson({ userMessageId: `question-${ordinal}` })})`;
        yield* insertMessage({
          id: `question-${ordinal}`,
          threadId,
          runId,
          role: "user",
          text: `Question ${ordinal}`,
          createdAt: at,
        });
        yield* insertMessage({
          id: `answer-${ordinal}-a`,
          threadId,
          runId,
          role: "assistant",
          text: `Answer ${ordinal}`,
          createdAt: `2026-01-01T00:0${ordinal}:10.000Z`,
        });
        yield* insertMessage({
          id: `answer-${ordinal}-b`,
          threadId,
          runId,
          role: "assistant",
          text: "",
          createdAt: `2026-01-01T00:0${ordinal}:20.000Z`,
        });
      }
      const orchestration = yield* StaveOrchestration;
      const before = yield* orchestration.getInferenceTurnPairs({
        threadId: ThreadId.make(threadId),
        beforeMessageId: MessageId.make("question-6"),
      });
      assert.deepEqual(before, [
        { question: "Question 2", response: "Answer 2" },
        { question: "Question 4", response: "Answer 4" },
        { question: "Question 5", response: "Answer 5" },
      ]);
      const latest = yield* orchestration.getInferenceTurnPairs({
        threadId: ThreadId.make(threadId),
      });
      assert.deepEqual(
        latest.map((pair) => pair.question),
        ["Question 4", "Question 5", "Question 6"],
      );
    }),
  );

  it.effect("lists live provider sessions with their workspace", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [id, status, cwd] of [
        ["running", "running", "/space/repo"],
        ["ready", "ready", "/space"],
        ["stopped", "stopped", "/space"],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
          (provider_session_id, thread_id, provider, status, model, updated_at, payload_json)
          VALUES (${id}, ${`thread-${id}`}, 'codex', ${status}, NULL, ${NOW}, ${yield* toJson({ cwd })})`;
      }
      const orchestration = yield* StaveOrchestration;
      const sessions = yield* orchestration.listSessions();
      assert.deepEqual(
        sessions
          .map((session) => [session.providerSessionId, session.cwd, session.active])
          .toSorted(),
        [
          ["ready", "/space", false],
          ["running", "/space/repo", true],
        ],
      );
    }),
  );

  it.effect("derives Stave fields and the lifecycle notice on every project read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('notice','Notice','/space','[]',${NOW},${NOW})`;
      yield* sql`INSERT INTO stave_project_lifecycle (project_id,workspace_root,disposition,archive_deadline_at,updated_at) VALUES ('notice','/space','pending_archive',${LATER},${NOW})`;
      const orchestration = yield* StaveOrchestration;
      const shell = Option.getOrThrow(
        yield* orchestration.getProjectShellById(ProjectId.make("notice")),
      );
      const byRoot = Option.getOrThrow(
        yield* orchestration.getActiveProjectByWorkspaceRoot("/space"),
      );
      assert.deepEqual(shell.notice, { kind: "archive_scheduled", at: LATER });
      assert.equal(shell.stave?.spaceId, "space");
      assert.deepEqual(byRoot.notice, shell.notice);
      yield* sql`UPDATE stave_project_lifecycle SET disposition = 'refused', refusal_code = 'nested_project', refusal_message = 'Nested project' WHERE project_id = 'notice'`;
      assert.deepEqual(
        Option.getOrThrow(yield* orchestration.getProjectShellById(ProjectId.make("notice")))
          .notice,
        { kind: "refused", at: NOW, code: "nested_project", message: "Nested project" },
      );
      yield* sql`UPDATE stave_project_lifecycle SET disposition = 'pending_archive', archive_deadline_at = NULL WHERE project_id = 'notice'`;
      assert.deepEqual(
        Option.getOrThrow(yield* orchestration.getProjectShellById(ProjectId.make("notice")))
          .notice,
        {
          kind: "archive_scheduled",
          code: "archive_suggested",
          message: "All threads are settled. Archive this space when ready.",
        },
      );
    }),
  );
});
