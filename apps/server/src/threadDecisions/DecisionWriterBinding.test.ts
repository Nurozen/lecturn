import { assert, it } from "@effect/vitest";
import {
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@lecturn/contracts";
import { Effect, Layer, Result, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { make as makeAdmission, ProviderWorkAdmission } from "../provider/ProviderWorkAdmission.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../provider/providerMaintenance.ts";
import { make } from "./DecisionWriterBinding.ts";

const projectId = ProjectId.make("binding-project");
const threadId = ThreadId.make("binding-thread");
const instanceId = ProviderInstanceId.make("codex");
const driverKind = ProviderDriverKind.make("codex");
const encodeSelection = Schema.encodeEffect(Schema.fromJsonString(Schema.toType(ModelSelection)));
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR REPLACE INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'QA','/tmp/binding','[]','now','now')`;
  const selection = yield* encodeSelection({ instanceId, model: "selected-model", options: [] });
  yield* sql`INSERT OR REPLACE INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,runtime_mode,interaction_mode) VALUES (${threadId},${projectId},'QA',${selection},'now','now','full-access','default')`;
  const unavailable = yield* buildUnavailableProviderSnapshot({
    driverKind,
    instanceId,
    displayName: undefined,
    reason: "fixture",
  });
  let email = "member@example.test";
  let preflightCalls = 0;
  let supported = true;
  const snapshot = Effect.sync(() => ({
    ...unavailable,
    auth: { status: "authenticated" as const, email },
  }));
  let instance: ProviderInstance = {
    instanceId,
    driverKind,
    displayName: undefined,
    enabled: true,
    configurationFingerprint: "effective-config",
    continuationIdentity: { driverKind, continuationKey: "codex:home:/tmp/binding-account" },
    snapshot: {
      maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
        provider: driverKind,
        packageName: null,
      }),
      getSnapshot: snapshot,
      refresh: snapshot,
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {
      generateCommitMessage: () => Effect.die("unused"),
      generatePrContent: () => Effect.die("unused"),
      generateBranchName: () => Effect.die("unused"),
      generateThreadTitle: () => Effect.die("unused"),
      generateWorkflowSummary: () => Effect.die("unused"),
      checkDecisionWriter: () =>
        Effect.sync(() => {
          preflightCalls++;
          return { supported, reason: supported ? null : "This configured writer is unavailable." };
        }),
      generateDecisionNotes: () => Effect.die("unused"),
    },
  };
  const admission = yield* makeAdmission;
  const registry = Layer.mock(ProviderInstanceRegistry)({
    getInstance: () => Effect.sync(() => instance),
  });
  const service = () =>
    make.pipe(Effect.provide(registry), Effect.provideService(ProviderWorkAdmission, admission));
  return {
    service,
    sql,
    preflightCalls: () => preflightCalls,
    setSupported: (next: boolean) => {
      supported = next;
    },
    restartInstance: () => {
      instance = { ...instance };
    },
    changeConfig: () => {
      instance = { ...instance, configurationFingerprint: "changed-config" };
    },
    changeAccount: () => {
      email = "other@example.test";
    },
    omitConfig: () => {
      const { configurationFingerprint: _, ...rest } = instance;
      instance = rest;
    },
  };
});
it.layer(SqlitePersistenceMemory)("Decision writer binding", (it) => {
  it.effect(
    "retains unchanged bindings after process reconstruction and rejects effective configuration drift",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.service();
        const saved = yield* first.capture(projectId, threadId);
        f.restartInstance();
        const restarted = yield* f.service();
        yield* restarted.validate(saved);
        assert.equal(
          (yield* restarted.capture(projectId, threadId)).fingerprint,
          saved.fingerprint,
        );
        f.changeConfig();
        assert.isTrue(Result.isFailure(yield* restarted.validate(saved).pipe(Effect.result)));
      }),
  );
  it.effect(
    "rejects account/model drift and instances without an effective configuration identity",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const writer = yield* f.service();
        const saved = yield* writer.capture(projectId, threadId);
        f.changeAccount();
        assert.isTrue(Result.isFailure(yield* writer.validate(saved).pipe(Effect.result)));
        const current = yield* writer.capture(projectId, threadId);
        const changed = yield* encodeSelection({ instanceId, model: "another-model", options: [] });
        yield* f.sql`UPDATE projection_threads SET model_selection_json = ${changed} WHERE thread_id = ${threadId}`;
        assert.isTrue(Result.isFailure(yield* writer.validate(current).pipe(Effect.result)));
        f.omitConfig();
        assert.isTrue(
          Result.isFailure(yield* writer.capture(projectId, threadId).pipe(Effect.result)),
        );
      }),
  );
  it.effect(
    "keeps status reads process-free and invalidates verified support on identity or configuration changes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const writer = yield* f.service();
        const initial = yield* writer.check(projectId, threadId);
        assert.isTrue(initial.supported);
        assert.include(initial.reason!, "will be verified");
        yield* writer.check(projectId, threadId);
        assert.equal(f.preflightCalls(), 0);
        yield* writer.capture(projectId, threadId);
        assert.deepEqual(yield* writer.check(projectId, threadId), {
          supported: true,
          reason: null,
        });
        assert.equal(f.preflightCalls(), 1);
        f.restartInstance();
        assert.include((yield* writer.check(projectId, threadId)).reason!, "will be verified");
        yield* writer.capture(projectId, threadId);
        f.changeAccount();
        assert.include((yield* writer.check(projectId, threadId)).reason!, "will be verified");
        yield* writer.capture(projectId, threadId);
        f.changeConfig();
        assert.include((yield* writer.check(projectId, threadId)).reason!, "will be verified");
        yield* writer.capture(projectId, threadId);
        const changed = yield* encodeSelection({ instanceId, model: "another-model", options: [] });
        yield* f.sql`UPDATE projection_threads SET model_selection_json = ${changed} WHERE thread_id = ${threadId}`;
        assert.include((yield* writer.check(projectId, threadId)).reason!, "will be verified");
        assert.equal(f.preflightCalls(), 4);
      }),
  );
  it.effect(
    "exposes failed preflight without repeating it on reads and expires old verification",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const writer = yield* f.service();
        f.setSupported(false);
        assert.isTrue(
          Result.isFailure(yield* writer.capture(projectId, threadId).pipe(Effect.result)),
        );
        assert.deepEqual(yield* writer.check(projectId, threadId), {
          supported: false,
          reason: "This configured writer is unavailable.",
        });
        yield* writer.check(projectId, threadId);
        assert.equal(f.preflightCalls(), 1);
        yield* TestClock.adjust("301 seconds");
        assert.include((yield* writer.check(projectId, threadId)).reason!, "will be verified");
        assert.equal(f.preflightCalls(), 1);
        f.setSupported(true);
        yield* writer.capture(projectId, threadId);
        assert.deepEqual(yield* writer.check(projectId, threadId), {
          supported: true,
          reason: null,
        });
        assert.equal(f.preflightCalls(), 2);
      }),
  );
});
