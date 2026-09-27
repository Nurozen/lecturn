import { assert, it } from "@effect/vitest";
import {
  ContextualPreparation,
  ContextualPacket,
  ContextualDeliveryReceipt,
  EnvironmentId,
  ProjectId,
  ThreadId,
  MessageId,
  TurnId,
} from "@lecturn/contracts";
import { Effect, Result } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make } from "./ContextualRepository.ts";
import { make as makeSettings } from "./ContextualSettings.ts";

const projectId = ProjectId.make("contextual-project");
const threadId = ThreadId.make("contextual-thread");
const now = "2026-09-25T00:00:00.000Z";
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "contextual_preparations",
    "contextual_turn_queue",
    "contextual_packets",
    "contextual_receipts",
    "contextual_supply",
    "contextual_project_settings",
    "contextual_thread_settings",
    "contextual_host_state",
    "contextual_lineage",
    "contextual_outbox",
  ])
    yield* sql`DELETE FROM ${sql(table)}`;
  yield* sql`INSERT OR REPLACE INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'QA','/tmp/contextual','[]',${now},${now})`;
  yield* sql`INSERT OR REPLACE INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,runtime_mode,interaction_mode) VALUES (${threadId},${projectId},'QA','{}',${now},${now},'full-access','default')`;
  const settings = yield* makeSettings;
  yield* settings.updateProject({
    projectId,
    defaultEnabled: false,
    sourceIds: [`decisions:${projectId}`],
    expectedRevision: 0,
  });
  yield* settings.updateThread({
    threadId,
    enabled: true,
    sourceIds: [`decisions:${projectId}`],
    expectedRevision: 0,
  });
  const task = {
    environmentId: EnvironmentId.make("env"),
    projectId,
    threadId,
    submissionId: "submission",
    messageId: MessageId.make("message"),
    turnId: null,
    providerInstanceId: "provider",
    providerContextEpoch: "initial",
    taskFingerprint: "fingerprint",
    knownContextFingerprint: "known",
    threadSettingsRevision: 1,
    projectSettingsRevision: 1,
    sourceScopeRevision: 0,
    threadExclusionRevision: 0,
    fundingGeneration: 0,
    purgeGeneration: 0,
    newestMessage: "Build storage",
    projectDescription: "Synthetic",
    explicitReferences: [],
    recentContext: "",
    trigger: "submission" as const,
  };
  const preparation = ContextualPreparation.make({
    id: "prep",
    task,
    revision: 0,
    state: "requested",
    packetId: null,
    dispatchId: null,
    conflictIds: [],
    attemptsUsed: 0,
    comparisonPairsChecked: 0,
    coverage: { complete: true, missingAntecedents: false, truncated: false, unexaminedCount: 0 },
    updatedAt: now,
  });
  const packet = ContextualPacket.make({
    id: "packet",
    preparationId: "prep",
    task,
    groups: [
      {
        candidateId: "candidate",
        occurrenceId: "occurrence",
        guidanceId: "guidance",
        contentFingerprint: "content",
        recordRevision: 1,
        evidence: [
          {
            id: "evidence",
            sourceId: "slack-source",
            sourceKind: "slack",
            occurrenceId: "occurrence",
            sourceRevision: 1,
            sourceHash: "hash",
            canonicalVersion: "v1",
            coordinateSystem: "utf16",
            quote: "Use Postgres.",
            start: 0,
            end: 13,
            prefix: "",
            suffix: "",
            author: "Synthetic",
            occurredAt: now,
            observedAt: now,
            sourceUrl: null,
            availability: "available",
            lineageIds: [],
            locator: {
              sourceKind: "slack",
              workspaceId: "workspace",
              channelId: "channel",
              messageTs: "1720000000.123456",
              threadTs: null,
            },
          },
        ],
        attribution: null,
        derivedSummary: null,
        reasons: ["constraint"],
      },
    ],
    tokenCount: 30,
    tokenCounting: "conservative-bound",
    payloadRef: "packet",
    createdAt: now,
    resolutionIds: [],
    purpose: "new-context",
  });
  const receipt = ContextualDeliveryReceipt.make({
    id: "receipt",
    preparationId: "prep",
    packetId: "packet",
    dispatchId: "dispatch",
    threadId,
    submissionId: "submission",
    turnId: TurnId.make("turn"),
    providerInstanceId: "provider",
    providerContextEpoch: "initial",
    providerReceiptId: "native",
    disposition: "fresh",
    acceptance: "accepted",
    evidenceIncluded: true,
    suppliedEvidenceIds: ["evidence"],
    receivedAt: now,
  });
  return { sql, settings, repo: yield* make, preparation, packet, receipt };
});
const ready = Effect.gen(function* () {
  const f = yield* fixture;
  let p = yield* f.repo.create(f.preparation, "synthetic-continuation");
  p = yield* f.repo.update({ ...p, state: "retrieving", revision: 1 }, 0);
  p = yield* f.repo.update({ ...p, state: "evaluating", revision: 2, attemptsUsed: 1 }, 1);
  yield* f.repo.putPacket(f.packet);
  p = yield* f.repo.update({ ...p, state: "prepared", packetId: f.packet.id, revision: 3 }, 2);
  return { ...f, preparation: p };
});

it.layer(SqlitePersistenceMemory)("Contextual durable delivery", (it) => {
  it.effect("does not mark supply until a matching native acceptance receipt", () =>
    Effect.gen(function* () {
      const f = yield* ready;
      assert.isFalse(yield* f.repo.supplied(threadId, "guidance", "content", "initial"));
      assert.isTrue(Result.isFailure(yield* f.repo.receipt(f.receipt).pipe(Effect.result)));
      yield* f.repo.update(
        { ...f.preparation, state: "dispatching", dispatchId: "dispatch", revision: 4 },
        3,
      );
      yield* f.repo.receipt(f.receipt);
      yield* f.repo.receipt(f.receipt);
      assert.isTrue(yield* f.repo.supplied(threadId, "guidance", "content", "initial"));
      assert.equal((yield* f.repo.get("prep")).state, "delivered");
      assert.equal(
        (yield* f.repo.disclosures(threadId))[0]?.packet?.groups[0]?.evidence[0]?.quote,
        "Use Postgres.",
      );
    }),
  );
  it.effect("preserves unknown-delivery suppression without claiming accepted evidence", () =>
    Effect.gen(function* () {
      const f = yield* ready;
      yield* f.repo.update(
        { ...f.preparation, state: "dispatching", dispatchId: "dispatch", revision: 4 },
        3,
      );
      yield* f.repo.receipt({
        ...f.receipt,
        acceptance: "unknown",
        turnId: null,
        providerReceiptId: null,
        suppliedEvidenceIds: [],
      });
      assert.isTrue(yield* f.repo.supplied(threadId, "guidance", "content", "initial"));
      assert.equal((yield* f.repo.get("prep")).state, "delivery-unknown");
      assert.equal((yield* f.repo.disclosures(threadId))[0]?.receipt.suppliedEvidenceIds.length, 0);
      yield* f.repo.receipt(f.receipt);
      assert.equal((yield* f.repo.get("prep")).state, "delivered");
      assert.equal((yield* f.repo.disclosures(threadId)).length, 1);
    }),
  );
  it.effect(
    "toggle cycles invalidate admitted work even when the requested state returns to on",
    () =>
      Effect.gen(function* () {
        const f = yield* ready;
        yield* f.settings.updateThread({
          threadId,
          expectedRevision: 1,
          enabled: false,
          sourceIds: [],
        });
        yield* f.settings.updateThread({
          threadId,
          expectedRevision: 2,
          enabled: true,
          sourceIds: [`decisions:${projectId}`],
        });
        assert.isTrue(
          Result.isFailure(
            yield* f.repo
              .update(
                { ...f.preparation, state: "dispatching", dispatchId: "dispatch", revision: 4 },
                3,
              )
              .pipe(Effect.result),
          ),
        );
        assert.isTrue(
          Result.isFailure(
            yield* f.repo
              .update(
                {
                  ...f.preparation,
                  task: { ...f.preparation.task, threadSettingsRevision: 3 },
                  state: "dispatching",
                  dispatchId: "dispatch",
                  revision: 4,
                },
                3,
              )
              .pipe(Effect.result),
          ),
        );
      }),
  );
  it.effect("persists a conflict hold and rejects a timeout-shaped failure transition", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let p = yield* f.repo.create(f.preparation, "continuation");
      p = yield* f.repo.update({ ...p, state: "retrieving", revision: 1 }, 0);
      p = yield* f.repo.update({ ...p, state: "evaluating", revision: 2 }, 1);
      p = yield* f.repo.update({ ...p, state: "checking-conflicts", revision: 3 }, 2);
      p = yield* f.repo.update(
        { ...p, state: "awaiting-conflict-review", conflictIds: ["conflict"], revision: 4 },
        3,
      );
      const restarted = yield* make;
      assert.equal((yield* restarted.get(p.id)).state, "awaiting-conflict-review");
      assert.isTrue(
        Result.isFailure(
          yield* restarted.update({ ...p, state: "failed", revision: 5 }, 4).pipe(Effect.result),
        ),
      );
      yield* restarted.update({ ...p, state: "skipped", revision: 5 }, 4);
      assert.equal((yield* restarted.get(p.id)).state, "skipped");
    }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual inherited disclosure", (it) => {
  it.effect("refuses cancellation after durable dispatch admission", () =>
    Effect.gen(function* () {
      const f = yield* ready;
      yield* f.sql`INSERT INTO contextual_turn_queue(event_id,sequence,thread_id,preparation_id,dispatch_id,state,created_at,updated_at) VALUES('dispatch-admitted',1,${threadId},${f.preparation.id},'dispatch','dispatching',${now},${now})`;
      assert.isTrue(
        Result.isFailure(
          yield* f.repo
            .update({ ...f.preparation, state: "canceled", revision: 4 }, 3)
            .pipe(Effect.result),
        ),
      );
      assert.equal((yield* f.repo.get(f.preparation.id)).state, "prepared");
    }),
  );
  it.effect("preserves the original native receipt and child message navigation after purge", () =>
    Effect.gen(function* () {
      const f = yield* ready;
      yield* f.repo.update(
        { ...f.preparation, state: "dispatching", dispatchId: "dispatch", revision: 4 },
        3,
      );
      yield* f.repo.receipt(f.receipt);
      const child = ThreadId.make("child");
      yield* f.sql`INSERT OR REPLACE INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,runtime_mode,interaction_mode) VALUES(${child},${projectId},'Child','{}',${now},${now},'full-access','default')`;
      yield* f.sql`INSERT OR REPLACE INTO contextual_inherited_disclosures(thread_id,message_id,origin_thread_id,receipt_id,packet_id) VALUES(${child},'child-message',${threadId},'receipt','packet')`;
      const read = yield* f.repo.disclosures(child, undefined, 50, MessageId.make("child-message"));
      assert.equal(read.length, 1);
      assert.equal(read[0]?.receipt.threadId, threadId);
      assert.equal(read[0]?.messageId, "child-message");
      assert.equal(read[0]?.inherited?.originThreadId, threadId);
      yield* f.sql`UPDATE contextual_packets SET packet_json=NULL,payload_bytes=0,retention='forgotten' WHERE id='packet'`;
      const forgotten = yield* f.repo.disclosures(child);
      assert.equal(forgotten[0]?.retention, "forgotten");
      assert.isNull(forgotten[0]?.packet);
      assert.equal(forgotten[0]?.messageId, "child-message");
    }),
  );
});
