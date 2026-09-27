import { assert, it } from "@effect/vitest";
import * as C from "@lecturn/contracts";
import { Deferred, Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerSettingsService, layerTest as settingsLayer } from "../serverSettings.ts";
import {
  TextGeneration,
  type ContextualSummaryGenerationInput,
} from "../textGeneration/TextGeneration.ts";
import { ContextualNotifications, make as makeNotifications } from "./ContextualNotifications.ts";
import { ContextualDisplaySummary, make } from "./ContextualDisplaySummary.ts";
import { make as makeRepository } from "./ContextualRepository.ts";
import { contextualPacketText } from "./ContextualPacketText.ts";
const at = "2026-09-25T00:00:00.000Z";
const threadId = C.ThreadId.make("summary-thread");
const projectId = C.ProjectId.make("summary-project");
const modelSelection = {
  instanceId: C.ProviderInstanceId.make("configured-instance"),
  model: "configured-model",
};
const quote = "The local cache uses SQLite and preserves original source evidence. ".repeat(12);
const packet: C.ContextualPacket = {
  id: "summary-packet",
  preparationId: "summary-preparation",
  payloadRef: "summary-payload",
  tokenCount: 1400,
  tokenCounting: "conservative-bound",
  createdAt: at,
  resolutionIds: [],
  purpose: "new-context",
  task: {
    environmentId: C.EnvironmentId.make("summary-env"),
    projectId,
    threadId,
    submissionId: "summary-submission",
    messageId: C.MessageId.make("summary-message"),
    turnId: null,
    providerInstanceId: "conversation-provider",
    providerContextEpoch: "epoch",
    taskFingerprint: "task",
    knownContextFingerprint: "known",
    threadSettingsRevision: 1,
    projectSettingsRevision: 1,
    sourceScopeRevision: 1,
    threadExclusionRevision: 0,
    fundingGeneration: 1,
    purgeGeneration: 1,
    newestMessage: "Build the cache",
    projectDescription: "",
    explicitReferences: [],
    recentContext: "",
    trigger: "submission",
  },
  groups: [
    {
      candidateId: "candidate",
      occurrenceId: "occurrence",
      guidanceId: "guidance",
      contentFingerprint: "content",
      recordRevision: 1,
      attribution: null,
      derivedSummary: null,
      reasons: ["decision"],
      evidence: [
        {
          id: "evidence",
          sourceId: "source",
          sourceKind: "slack",
          occurrenceId: "occurrence",
          sourceRevision: 1,
          sourceHash: "hash",
          canonicalVersion: "v1",
          coordinateSystem: "utf16",
          quote,
          start: 0,
          end: quote.length,
          prefix: "",
          suffix: "",
          author: "Synthetic",
          occurredAt: at,
          observedAt: at,
          sourceUrl: null,
          availability: "available",
          lineageIds: [],
          locator: {
            sourceKind: "slack",
            workspaceId: "workspace",
            channelId: "channel",
            messageTs: "1.1",
            threadTs: null,
          },
        },
      ],
    },
  ],
};
const receipt: C.ContextualDeliveryReceipt = {
  id: "summary-receipt",
  preparationId: packet.preparationId,
  packetId: packet.id,
  dispatchId: "dispatch",
  threadId,
  submissionId: packet.task.submissionId,
  turnId: C.TurnId.make("turn"),
  providerInstanceId: packet.task.providerInstanceId,
  providerContextEpoch: "epoch",
  providerReceiptId: "provider-receipt",
  disposition: "fresh",
  acceptance: "accepted",
  evidenceIncluded: true,
  suppliedEvidenceIds: ["evidence"],
  receivedAt: at,
};
const encodePacket = Schema.encodeSync(Schema.fromJsonString(C.ContextualPacket));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(C.ContextualDeliveryReceipt));
const encodePreparation = Schema.encodeSync(Schema.fromJsonString(C.ContextualPreparation));
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const body = encodePacket(packet);
const fixture = (
  generateContextualSummary: NonNullable<TextGeneration["Service"]["generateContextualSummary"]>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM contextual_packets`;
    yield* sql`DELETE FROM contextual_receipts`;
    yield* sql`INSERT OR REPLACE INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${projectId},'Synthetic','/tmp/never-read','[]',${at},${at})`;
    yield* sql`INSERT OR REPLACE INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,runtime_mode,interaction_mode) VALUES(${threadId},${projectId},'Synthetic','{}',${at},${at},'full-access','default')`;
    yield* sql`INSERT OR REPLACE INTO contextual_host_state(singleton,source_policy_json,source_revision,purge_generation,funding_generation,updated_at) VALUES(1,'{}',1,1,1,${at})`;
    yield* sql`INSERT OR REPLACE INTO contextual_project_settings(project_id,default_enabled,source_ids_json,revision,updated_at) VALUES(${projectId},1,'["source"]',1,${at})`;
    yield* sql`INSERT OR REPLACE INTO contextual_thread_settings(thread_id,project_id,enabled,source_ids_json,revision,updated_at) VALUES(${threadId},${projectId},1,'["source"]',1,${at})`;
    yield* sql`INSERT INTO contextual_packets(id,preparation_id,thread_id,packet_json,payload_bytes,created_at) VALUES(${packet.id},${packet.preparationId},${threadId},${body},${body.length},${at})`;
    yield* sql`INSERT INTO contextual_receipts VALUES(${receipt.id},${receipt.dispatchId},${threadId},${packet.id},${encodeReceipt(receipt)},${at})`;
    const notifications = yield* makeNotifications;
    const generator: TextGeneration["Service"] = {
      generateContextualSummary,
      generateCommitMessage: () => Effect.die("unused"),
      generatePrContent: () => Effect.die("unused"),
      generateBranchName: () => Effect.die("unused"),
      generateThreadTitle: () => Effect.die("unused"),
      generateWorkflowSummary: () => Effect.die("unused"),
    };
    const configured = yield* Effect.service(ServerSettingsService).pipe(
      Effect.provide(settingsLayer()),
    );
    const service = yield* make.pipe(
      Effect.provideService(TextGeneration, generator),
      Effect.provideService(ContextualNotifications, notifications),
      Effect.provideService(ServerSettingsService, {
        ...configured,
        getSettings: configured.getSettings.pipe(
          Effect.map((value) => ({ ...value, textGenerationModelSelection: modelSelection })),
        ),
      }),
    );
    return { sql, service, notifications };
  });
it.layer(SqlitePersistenceMemory)("Contextual display summaries", (it) => {
  it.effect(
    "runs asynchronously through the configured model without modifying the agent packet",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const calls: ContextualSummaryGenerationInput[] = [];
        const f = yield* fixture((input) =>
          Effect.gen(function* () {
            calls.push(input);
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(finish);
            return { text: "Your local cache uses SQLite, with original evidence preserved." };
          }),
        );
        const preparation: C.ContextualPreparation = {
          id: packet.preparationId,
          task: packet.task,
          revision: 0,
          state: "dispatching",
          packetId: packet.id,
          dispatchId: receipt.dispatchId,
          conflictIds: [],
          attemptsUsed: 1,
          comparisonPairsChecked: 0,
          coverage: {
            complete: true,
            missingAntecedents: false,
            truncated: false,
            unexaminedCount: 0,
          },
          updatedAt: at,
        };
        yield* f.sql`DELETE FROM contextual_preparations WHERE id=${preparation.id}`;
        yield* f.sql`DELETE FROM contextual_receipts WHERE id=${receipt.id}`;
        yield* f.sql`UPDATE contextual_thread_settings SET context_epoch='epoch' WHERE thread_id=${threadId}`;
        yield* f.sql`INSERT INTO contextual_preparations(id,thread_id,project_id,submission_id,message_id,state,revision,preparation_json,dispatch_id,created_at,updated_at) VALUES(${preparation.id},${threadId},${projectId},${packet.task.submissionId},${packet.task.messageId},'dispatching',0,${encodePreparation(preparation)},${receipt.dispatchId},${at},${at})`;
        const repository = yield* makeRepository.pipe(
          Effect.provideService(ContextualDisplaySummary, f.service),
        );
        yield* repository.receipt(receipt);
        yield* Deferred.await(started);
        assert.equal((yield* f.sql`SELECT * FROM contextual_display_summaries`).length, 0);
        yield* f.service.schedule(receipt);
        yield* Deferred.succeed(finish, undefined);
        yield* f.service.drain;
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0]?.modelSelection, modelSelection);
        assert.equal(calls[0]?.message, contextualPacketText(packet));
        assert.equal(calls[0]?.cwd, "/");
        assert.equal(
          (yield* f.sql<{ packet_json: string }>`SELECT packet_json FROM contextual_packets`)[0]
            ?.packet_json,
          body,
        );
        const disclosure = (yield* repository.disclosures(threadId))[0]!;
        assert.equal(disclosure.displaySummary?.state, "ready");
        assert.match(disclosure.displaySummary?.text ?? "", /SQLite/);
        const events = yield* f.sql<{
          kind: string;
          entity_id: string;
        }>`SELECT kind,entity_id FROM contextual_outbox WHERE kind='display-summary-ready'`;
        assert.equal(events.at(-1)?.entity_id, packet.id);
        assert.ok(!encodeUnknown(events).includes("SQLite"));
      }).pipe(Effect.scoped),
  );
  it.effect("does not generate for unknown, rejected, absent-evidence or short packets", () =>
    Effect.gen(function* () {
      let calls = 0;
      const f = yield* fixture(() =>
        Effect.sync(() => {
          calls++;
          return { text: "Summary" };
        }),
      );
      for (const acceptance of ["unknown", "rejected"] as const)
        yield* f.service.schedule({ ...receipt, acceptance });
      yield* f.service.schedule({ ...receipt, evidenceIncluded: false });
      const short = {
        ...packet,
        groups: packet.groups.map((group) => ({
          ...group,
          evidence: group.evidence.map((evidence) => ({
            ...evidence,
            quote: "Use SQLite",
            end: 10,
          })),
        })),
      };
      yield* f.sql`UPDATE contextual_packets SET packet_json=${encodePacket(short)}`;
      yield* f.service.schedule(receipt);
      yield* f.service.drain;
      assert.equal(calls, 0);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "forget, permission revocation, expiry and replacement invalidate in-flight writes",
    () =>
      Effect.gen(function* () {
        for (const mutation of ["forget", "permissions", "expired", "replace"] as const) {
          const started = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const f = yield* fixture(() =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as({ text: "Do not resurrect forgotten source text" }),
            ),
          );
          yield* f.service.schedule(receipt);
          yield* Deferred.await(started);
          if (mutation === "forget")
            yield* f.sql`UPDATE contextual_host_state SET purge_generation=purge_generation+1`;
          if (mutation === "permissions")
            yield* f.sql`UPDATE contextual_thread_settings SET enabled=0,revision=revision+1`;
          if (mutation === "expired")
            yield* f.sql`UPDATE contextual_packets SET packet_json=NULL,retention='expired'`;
          if (mutation === "replace")
            yield* f.sql`UPDATE contextual_packets SET packet_json=${body + " "}`;
          yield* Deferred.succeed(finish, undefined);
          yield* f.service.drain;
          assert.equal(
            (yield* f.sql`SELECT * FROM contextual_display_summaries`).length,
            0,
            mutation,
          );
        }
      }).pipe(Effect.scoped),
  );
  it.effect(
    "stored summaries are removed with source purge, permission changes and packet expiry",
    () =>
      Effect.gen(function* () {
        for (const mutation of [
          "purge",
          "delete",
          "expired",
          "source-policy",
          "project-policy",
        ] as const) {
          const f = yield* fixture(() => Effect.succeed({ text: "Source derived text" }));
          yield* f.service.schedule(receipt);
          yield* f.service.drain;
          assert.equal((yield* f.sql`SELECT * FROM contextual_display_summaries`).length, 1);
          if (mutation === "purge")
            yield* f.sql`UPDATE contextual_host_state SET purge_generation=purge_generation+1`;
          if (mutation === "delete") yield* f.sql`DELETE FROM contextual_packets`;
          if (mutation === "expired")
            yield* f.sql`UPDATE contextual_packets SET packet_json=NULL,retention='expired'`;
          if (mutation === "source-policy")
            yield* f.sql`UPDATE contextual_host_state SET source_revision=source_revision+1`;
          if (mutation === "project-policy")
            yield* f.sql`UPDATE contextual_project_settings SET revision=revision+1`;
          assert.equal(
            (yield* f.sql`SELECT * FROM contextual_display_summaries`).length,
            0,
            mutation,
          );
        }
      }).pipe(Effect.scoped),
  );
  it.effect("source invalidation cancels generation without waiting for model completion", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const canceled = yield* Deferred.make<void>();
      const f = yield* fixture(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(canceled, undefined)),
        ),
      );
      yield* f.service.schedule(receipt);
      yield* Deferred.await(started);
      yield* f.sql`UPDATE contextual_host_state SET purge_generation=purge_generation+1`;
      yield* f.notifications.publish;
      yield* Deferred.await(canceled);
      yield* f.service.drain;
      assert.equal((yield* f.sql`SELECT * FROM contextual_display_summaries`).length, 0);
    }).pipe(Effect.scoped),
  );
  it.effect("invalid or failed generation preserves the original disclosure", () =>
    Effect.gen(function* () {
      for (const generate of [
        () => Effect.succeed({ text: "x".repeat(601) }),
        () =>
          Effect.fail(
            new C.TextGenerationError({
              operation: "generateContextualSummary",
              detail: "synthetic unavailable",
            }),
          ),
      ]) {
        const f = yield* fixture(generate);
        yield* f.service.schedule(receipt);
        yield* f.service.drain;
        assert.equal((yield* f.sql`SELECT * FROM contextual_display_summaries`).length, 0);
        assert.equal(
          (yield* f.sql<{ packet_json: string }>`SELECT packet_json FROM contextual_packets`)[0]
            ?.packet_json,
          body,
        );
      }
    }).pipe(Effect.scoped),
  );
});
