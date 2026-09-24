import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, type DecisionFundingStatusResult } from "@lecturn/contracts";
import { Effect, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Repository from "./DecisionRepository.ts";
import * as Settings from "./DecisionSettingsRepository.ts";
import * as Jobs from "./DecisionJobRepository.ts";
import { DecisionCloudClient } from "./DecisionCloudClient.ts";
import { DecisionWriterAvailability, make } from "./DecisionService.ts";

const projectId = ProjectId.make("service-project");
it.layer(SqlitePersistenceMemory)("Decision service", (it) => {
  it.effect("new project settings inherit funding and remain readable after revoke and purge", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-01-01T00:00:00.000Z";
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'QA','/tmp/qa','[]',${at},${at})`;
      const settings = yield* Settings.make;
      const repo = yield* Repository.make;
      const jobs = yield* Jobs.make.pipe(
        Effect.provideService(Settings.DecisionSettingsRepository, settings),
      );
      let status: DecisionFundingStatusResult = {
        environmentId: EnvironmentId.make("env"),
        state: "active" as const,
        generation: 3,
        accountLabel: "Lecturn account",
        eligible: true,
        allowance: null,
        remoteRevocationPending: false,
      };
      const service = yield* make.pipe(
        Effect.provideService(Repository.DecisionRepository, repo),
        Effect.provideService(Settings.DecisionSettingsRepository, settings),
        Effect.provideService(Jobs.DecisionJobRepository, jobs),
        Effect.provideService(DecisionWriterAvailability, {
          check: () => Effect.succeed({ supported: true, reason: null }),
        }),
        Effect.provideService(DecisionCloudClient, {
          fundingStatus: Effect.sync(() => status),
          retryPendingRevocation: Effect.void,
          refreshFunding: Effect.void,
          subscribeFundingChanges: Effect.succeed(Stream.empty),
          funding: (input) =>
            Effect.sync(() => {
              if (input.operation === "challenge")
                return { status: { ...status, state: "pending" as const }, challenge: null };
              status = { ...status, state: "revoked", eligible: false, generation: 4 };
              return { status, challenge: null };
            }),
          evaluate: () => Effect.die("A settings read must never run Jev"),
        }),
      );
      const initial = yield* service.status({ projectId });
      assert.isFalse(initial.settings.enabled);
      assert.equal(
        initial.settings.fundingState,
        "active",
        "A new project's setup must see existing environment funding",
      );
      const enabled = yield* service.settings({
        operation: "update",
        projectId,
        expectedRevision: 0,
        enabled: true,
        description: "Storage choices",
      });
      assert.equal(enabled.settings.fundingState, "active");
      assert.isTrue(enabled.settings.enabled);
      const before = yield* service.status({ projectId });
      assert.equal(before.processing.state, "idle");
      assert.deepEqual(before.incompleteJobs, []);
      status = { ...status, state: "revoked", eligible: false };
      assert.equal((yield* service.status({ projectId })).processing.blockedReason, "unfunded");
      status = { ...status, state: "unavailable" };
      assert.equal((yield* service.status({ projectId })).processing.blockedReason, "error");
      status = { ...status, state: "active", eligible: false };
      assert.equal(
        (yield* service.status({ projectId })).processing.blockedReason,
        "access-expired",
      );
      status = { ...status, eligible: true };
      yield* service.funding({ operation: "challenge", expectedGeneration: 3 });
      const pendingApproval = yield* service.status({ projectId });
      assert.equal(pendingApproval.settings.fundingState, "active");
      assert.equal(pendingApproval.settings.cancellationEpoch, before.settings.cancellationEpoch);
      assert.equal(pendingApproval.projectRevision, before.projectRevision);
      yield* service.funding({ operation: "revoke", expectedGeneration: 3 });
      const revoked = yield* service.status({ projectId });
      assert.equal(revoked.processing.blockedReason, "unfunded");
      assert.deepEqual((yield* service.list({ projectId })).decisions, []);
      assert.isAbove(revoked.projectRevision, before.projectRevision);
      yield* service.settings({
        operation: "purge",
        projectId,
        expectedRevision: enabled.settings.revision,
      });
      assert.isFalse((yield* service.status({ projectId })).settings.enabled);
    }).pipe(Effect.scoped),
  );
});
