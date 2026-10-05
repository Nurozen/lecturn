import {
  ModelSelection,
  ThreadDecisionError,
  type ProjectId,
  type ThreadId,
  type DecisionWriterInput,
} from "@lecturn/contracts";
import { decisionFingerprint } from "@lecturn/shared/decisionEvidence";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderWorkAdmission } from "../provider/ProviderWorkAdmission.ts";
import { DecisionWriterAvailability } from "./DecisionService.ts";

export const WriterBinding = Schema.Struct({
  projectId: Schema.String,
  threadId: Schema.String,
  cwd: Schema.String,
  modelSelection: Schema.toType(ModelSelection),
  fingerprint: Schema.String,
});
export type WriterBinding = typeof WriterBinding.Type;
const fail = (code: ThreadDecisionError["code"], message: string) =>
  new ThreadDecisionError({ code, message });
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSelection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toType(ModelSelection)),
);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* ProviderInstanceRegistry;
  const admission = yield* ProviderWorkAdmission;
  // Status reads may inspect configuration, but never launch provider processes.
  // Only work admission populates this short-lived verification cache.
  const supportCache = new WeakMap<
    object,
    Map<
      string,
      {
        readonly expiresAt: number;
        readonly supported: boolean;
        readonly reason: string | null;
      }
    >
  >();
  const rememberSupport = (
    instance: object,
    fingerprint: string,
    supported: boolean,
    reason: string | null,
  ) =>
    Effect.gen(function* () {
      const entries = supportCache.get(instance) ?? new Map();
      entries.set(fingerprint, {
        supported,
        reason,
        expiresAt: (yield* Clock.currentTimeMillis) + 300_000,
      });
      if (entries.size > 64) entries.delete(entries.keys().next().value!);
      supportCache.set(instance, entries);
    });
  const resolve = Effect.fn("Decisions.writer.resolve")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
  ) {
    const rows = yield* sql<{
      model_selection_json: string;
      cwd: string;
    }>`SELECT t.model_selection_json, COALESCE(t.worktree_path, p.workspace_root) AS cwd
      FROM projection_threads t JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.thread_id = ${threadId} AND t.project_id = ${projectId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND t.archived_at IS NULL`.pipe(
      Effect.mapError(() =>
        fail("unavailable", "The decision writer configuration could not be read."),
      ),
    );
    const row = rows[0];
    if (!row) return yield* fail("not-found", "The source thread is no longer active.");
    const modelSelection = yield* decodeSelection(row.model_selection_json).pipe(
      Effect.mapError(() =>
        fail("unsupported", "This thread has no explicit writer configuration."),
      ),
    );
    const instance = yield* registry.getInstance(modelSelection.instanceId);
    if (
      !instance?.enabled ||
      !instance.textGeneration.checkDecisionWriter ||
      !instance.textGeneration.generateDecisionNotes
    )
      return yield* fail(
        "unsupported",
        "The thread's provider does not support isolated Decisions writing.",
      );
    if (!instance.configurationFingerprint)
      return yield* fail(
        "unsupported",
        "The thread's effective writer configuration could not be verified.",
      );
    const auth = yield* encode((yield* instance.snapshot.getSnapshot).auth).pipe(
      Effect.mapError(() => fail("unavailable", "The writer account could not be verified.")),
    );
    const selection = yield* encode(modelSelection).pipe(
      Effect.mapError(() => fail("unsupported", "The writer model could not be verified.")),
    );
    const binding: WriterBinding = {
      projectId,
      threadId,
      cwd: row.cwd,
      modelSelection,
      fingerprint: decisionFingerprint([
        instance.configurationFingerprint,
        instance.continuationIdentity,
        row.cwd,
        selection,
        auth,
      ]),
    };
    return { binding, instance };
  });
  const capture = Effect.fn("Decisions.writer.capture")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
  ) {
    const { binding, instance } = yield* resolve(projectId, threadId);
    const support = yield* instance.textGeneration.checkDecisionWriter!({
      cwd: binding.cwd,
      modelSelection: binding.modelSelection,
    }).pipe(
      Effect.mapError(() =>
        fail("unsupported", "The thread's writer configuration could not be verified."),
      ),
      Effect.tapError((error) =>
        rememberSupport(instance, binding.fingerprint, false, error.message),
      ),
    );
    yield* rememberSupport(
      instance,
      binding.fingerprint,
      support.supported,
      support.reason ?? null,
    );
    if (!support.supported)
      return yield* fail("unsupported", support.reason ?? "The thread's writer is unavailable.");
    return binding;
  });
  const validate = Effect.fn("Decisions.writer.validate")(function* (binding: WriterBinding) {
    const current = yield* resolve(binding.projectId as ProjectId, binding.threadId as ThreadId);
    if (current.binding.fingerprint !== binding.fingerprint)
      return yield* fail(
        "conflict",
        "The thread's provider, model, options, or account changed. Retry Decisions with its current configuration.",
      );
    return current.instance;
  });
  const write = Effect.fn("Decisions.writer.write")(function* (
    binding: WriterBinding,
    input: Omit<DecisionWriterInput, "modelSelection">,
    repairFeedback?: string,
  ) {
    const instance = yield* validate(binding);
    return yield* admission.runWriter(
      binding.modelSelection.instanceId,
      Effect.gen(function* () {
        const result = yield* instance.textGeneration.generateDecisionNotes!({
          ...input,
          modelSelection: binding.modelSelection,
          cwd: binding.cwd,
          ...(repairFeedback ? { repairFeedback } : {}),
        }).pipe(
          Effect.mapError(() =>
            fail("unavailable", "The connected writer could not finish the decision note."),
          ),
        );
        yield* validate(binding);
        return result;
      }),
    );
  });
  const check = Effect.fn("Decisions.writer.check")(function* (
    projectId: ProjectId,
    threadId?: ThreadId,
  ) {
    if (!threadId)
      return {
        supported: true,
        reason: "Each thread's connected writer is verified before processing.",
      };
    return yield* Effect.gen(function* () {
      const { binding, instance } = yield* resolve(projectId, threadId);
      const cached = supportCache.get(instance)?.get(binding.fingerprint);
      if (cached && cached.expiresAt > (yield* Clock.currentTimeMillis))
        return { supported: cached.supported, reason: cached.reason };
      return {
        supported: true,
        reason: "The thread's configured writer will be verified before processing.",
      };
    }).pipe(Effect.catch((error) => Effect.succeed({ supported: false, reason: error.message })));
  });
  return {
    capture,
    validate: (binding: WriterBinding) => validate(binding).pipe(Effect.asVoid),
    write,
    check,
  };
});
export class DecisionWriterBinding extends Context.Service<
  DecisionWriterBinding,
  Effect.Success<typeof make>
>()("lecturn/threadDecisions/DecisionWriterBinding") {}
export const layer = Layer.effect(DecisionWriterBinding, make);
export const availabilityLayer = Layer.effect(
  DecisionWriterAvailability,
  Effect.gen(function* () {
    const binding = yield* DecisionWriterBinding;
    return { check: binding.check };
  }),
);
