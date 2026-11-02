import {
  DEFAULT_LEAD_MESSAGES_PER_DAY,
  DEFAULT_LEAD_SQUIRE_PERMISSIONS,
  DEFAULT_SQUIRE_BUDGETS,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  Squire,
  SquireBudgets,
  SquireCompanion,
  type SquireCreateInput,
  type SquireDeleteInput,
  type SquireDeleteResult,
  SquireDigest,
  SquireError,
  SquireEvent,
  SquireEventToggles,
  type SquireGrantInput,
  SquireId,
  type SquireLeadEnsureInput,
  SquirePermissions,
  type SquireProviderSupportResult,
  type SquireSetStatusInput,
  SquireSweepSettings,
  type SquireTrackInput,
  type SquireUntrackInput,
  type SquireUpdateInput,
  squireDistinctCompanion,
  SQUIRE_LEAD_COMPANION,
  SquireVoiceNoteId,
  type SquireVoiceNoteInput,
  type SquireVoiceNoteResult,
  ThreadId,
} from "@lecturn/contracts";
import * as HostProcess from "@lecturn/shared/HostProcess";
import { resolveProjectSettings } from "@lecturn/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { hasClaudeManagedMcpConfig } from "../provider/Drivers/ClaudeHome.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SquireLifecycle from "./SquireLifecycle.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRules from "./SquireRules.ts";
import * as SquireScope from "./SquireScope.ts";
import { writeLeadItemEvent } from "./squireLeadItems.ts";
import { isSquireThread } from "./squireThread.ts";
import { touchUserActivity } from "./squireUserActivity.ts";

/** Whether an instance may run a Squire home thread or a probe (D10, D25, A5.9). */
export interface SquireSupport {
  readonly supported: boolean;
  /** User-facing; set when unsupported. */
  readonly reason?: string;
}

export class SquireService extends Context.Service<
  SquireService,
  {
    readonly list: Effect.Effect<ReadonlyArray<Squire>, SquireError>;
    readonly get: (squireId: SquireId) => Effect.Effect<Option.Option<Squire>, SquireError>;
    readonly create: (input: typeof SquireCreateInput.Type) => Effect.Effect<Squire, SquireError>;
    readonly update: (input: typeof SquireUpdateInput.Type) => Effect.Effect<Squire, SquireError>;
    readonly setStatus: (
      input: typeof SquireSetStatusInput.Type,
    ) => Effect.Effect<Squire, SquireError>;
    readonly delete: (
      input: typeof SquireDeleteInput.Type,
    ) => Effect.Effect<typeof SquireDeleteResult.Type, SquireError>;
    readonly track: (input: typeof SquireTrackInput.Type) => Effect.Effect<Squire, SquireError>;
    readonly untrack: (input: typeof SquireUntrackInput.Type) => Effect.Effect<Squire, SquireError>;
    /** D7: creates the Lead when absent on an environment with a project; a no-op after. */
    readonly ensureLead: (
      input: typeof SquireLeadEnsureInput.Type,
    ) => Effect.Effect<Option.Option<Squire>, SquireError>;
    /**
     * D33, P12: queues one voice-note event; a retry of the same request
     * finds its row and returns the same id.
     */
    readonly voiceNote: (
      input: typeof SquireVoiceNoteInput.Type,
    ) => Effect.Effect<typeof SquireVoiceNoteResult.Type, SquireError>;
    readonly squireSupport: (instanceId: ProviderInstanceId) => Effect.Effect<SquireSupport>;
    /** D25: whether "Ask about this" may fork a thread running on this instance. */
    readonly probeSupport: (instanceId: ProviderInstanceId) => Effect.Effect<SquireSupport>;
    /** `squire.providerSupport`: every instance, for the setup sheet's provider picker. */
    readonly providerSupport: Effect.Effect<typeof SquireProviderSupportResult.Type>;
  }
>()("lecturn/squire/SquireService") {}

// P16.2: so sidebar rows tell apart at a glance; see `squireDistinctCompanion`.
const nextDefaultCompanion = (taken: ReadonlyArray<SquireCompanion>): SquireCompanion =>
  squireDistinctCompanion(taken);

// The client draws the Lead's crest from its role, so the record only keeps gold.
/**
 * P4.2, D10, D25: the decision per driver. A driver is on only after its MCP
 * isolation and deny-runtime tests pass on start, resume, and fork and a live
 * smoke shows it (12.2); one that cannot drop its own tools stays off with a
 * reason the picker shows. Pi, Muse, and the ACP registry are never on. The
 * scripted driver exists only for tests (D44g).
 */
const DRIVER_SUPPORT: Readonly<
  Record<string, { readonly squire: boolean; readonly probe: boolean; readonly reason?: string }>
> = {
  codex: { squire: true, probe: true },
  claudeAgent: { squire: true, probe: true },
  githubCopilot: {
    squire: false,
    probe: false,
    reason:
      "GitHub Copilot uses its own file and command tools, which Lecturn can't turn off, so a Squire on it could act outside Lecturn.",
  },
  // The adapter's `squireReadiness` refuses Grok versions not verified live.
  grok: { squire: true, probe: true },
  antigravity: {
    squire: false,
    probe: false,
    reason:
      "Antigravity uses its own tools, skills, and helper agents, which Lecturn can't turn off, so a Squire on it could act outside Lecturn.",
  },
  // OpenCode 2 also refuses through its adapter's `squireReadiness` (shared server).
  opencode: {
    squire: false,
    probe: false,
    reason: "Squires on OpenCode haven't been checked with a signed-in model provider yet.",
  },
  cursor: {
    squire: false,
    probe: false,
    reason: "Squires on Cursor haven't been verified to stay inside Lecturn yet.",
  },
};

const LEAD_NAME = "Lead";
const DEFAULT_EVENTS = Schema.decodeSync(SquireEventToggles)({});
const DEFAULT_LEAD_SWEEP = Schema.decodeSync(SquireSweepSettings)({});

export const CHOOSE_LEAD_PROVIDER = "Choose a provider for the Lead";
export const NO_SUPPORTED_PROVIDER = "No supported provider";

const encodeModel = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const encodeEvents = Schema.encodeSync(Schema.fromJsonString(SquireEventToggles));
const encodePermissions = Schema.encodeSync(Schema.fromJsonString(SquirePermissions));
const encodeBudgets = Schema.encodeSync(Schema.fromJsonString(SquireBudgets));
const encodeCompanion = Schema.encodeSync(Schema.fromJsonString(SquireCompanion));
const encodeDigest = Schema.encodeSync(Schema.fromJsonString(SquireDigest));
const encodeSweep = Schema.encodeSync(Schema.fromJsonString(SquireSweepSettings));
const decodeModel = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const decodeCompanion = Schema.decodeUnknownEffect(Schema.fromJsonString(SquireCompanion));
const decodeSquire = Schema.decodeUnknownEffect(Squire);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const parseJson = (text: string | null) =>
  text === null ? Effect.succeed(null) : decodeJson(text);
const sameModel = Schema.toEquivalence(ModelSelection);
const encodeEventJson = Schema.encodeSync(Schema.fromJsonString(SquireEvent));

/** The event key: a retried request carries the same id, so it lands on the same row. */
const voiceNoteIdFor = (requestId: string) => SquireVoiceNoteId.make(`vn_${requestId}`);

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const lifecycle = yield* SquireLifecycle.SquireLifecycle;
  const policyLock = yield* SquirePolicyLock.SquirePolicyLock;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scope = yield* SquireScope.SquireScope;
  const rules = yield* SquireRules.SquireRules;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* HostProcess.Environment;
  const { withPolicyLock } = policyLock;
  const orSquireError = SquireLifecycle.orSquireError;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const toSquire = (row: SquireRepository.SquireRow) =>
    Effect.gen(function* () {
      const grants = yield* repository.listGrants(row.id);
      return yield* decodeSquire({
        id: row.id,
        role: row.role,
        name: row.name,
        lifecycle: row.lifecycle,
        status: row.status,
        homeProjectId: row.home_project_id,
        homeThreadId: row.home_thread_id,
        providerInstanceId: row.provider_instance_id,
        modelSelection: yield* parseJson(row.model_selection_json),
        summaryModelSelection: yield* parseJson(row.summary_model_selection_json),
        brief: row.brief,
        grants: grants.map((grant) => ({
          kind: grant.kind,
          targetId: grant.target_id,
          origin: grant.origin,
          createdAt: grant.created_at,
        })),
        events: yield* parseJson(row.events_json),
        permissions: yield* parseJson(row.permissions_json),
        budgets: yield* parseJson(row.budgets_json),
        undoWindowSeconds: row.undo_window_seconds,
        companion: yield* parseJson(row.companion_json),
        digest: yield* parseJson(row.digest_json),
        sweep: yield* parseJson(row.sweep_json),
        onboardedAt: row.onboarded_at,
        ...(row.timezone ? { timezone: row.timezone } : {}),
        automationPausedAt: row.automation_paused_at,
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }).pipe(orSquireError("read the Squire"));

  /** Not found while deleting too: the Squire is already on its way out. */
  const requireRow = (squireId: SquireId) =>
    repository.getSquire(squireId).pipe(
      orSquireError("read the Squire"),
      Effect.flatMap((row) =>
        Option.isNone(row) || row.value.lifecycle === "deleting"
          ? Effect.fail(
              new SquireError({ code: "not_found", message: "This Squire no longer exists." }),
            )
          : Effect.succeed(row.value),
      ),
    );

  const conflict = Effect.fail(
    new SquireError({
      code: "revision_conflict",
      message: "This Squire changed. Reload and try again.",
    }),
  );

  const driverSupport = (instanceId: ProviderInstanceId, use: "squire" | "probe") =>
    Effect.gen(function* () {
      const instance = yield* providers.getInstance(instanceId);
      if (instance === undefined) {
        return { supported: false, reason: "This provider is not configured." };
      }
      const label = instance.displayName ?? instanceId;
      if (!instance.enabled) return { supported: false, reason: `${label} is turned off.` };
      const driver: string = instance.driverKind;
      const decision =
        driver === "scripted"
          ? environment.LECTURN_TEST_PROVIDERS === "1"
          : DRIVER_SUPPORT[driver]?.[use] === true;
      if (!decision) {
        return {
          supported: false,
          reason:
            use === "squire"
              ? [`${label} is not supported as a Squire provider.`, DRIVER_SUPPORT[driver]?.reason]
                  .filter((part) => part !== undefined)
                  .join(" ")
              : `Ask is not available for ${label}.`,
        };
      }
      // A managed managed-mcp.json makes Claude refuse --strict-mcp-config and
      // drop Lecturn's server while keeping the managed ones (A5.9).
      if (
        driver === "claudeAgent" &&
        (yield* hasClaudeManagedMcpConfig().pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        ))
      ) {
        return {
          supported: false,
          reason: `${label} uses a managed MCP configuration on this machine, so a ${
            use === "squire" ? "Squire" : "probe"
          } cannot isolate its tools.`,
        };
      }
      const gap = yield* instance.orchestrationAdapter?.squireReadiness ?? Effect.succeed(null);
      if (gap !== null) return { supported: false, reason: gap };
      return { supported: true };
    });
  const squireSupport: SquireService["Service"]["squireSupport"] = (instanceId) =>
    driverSupport(instanceId, "squire");
  const probeSupport: SquireService["Service"]["probeSupport"] = (instanceId) =>
    driverSupport(instanceId, "probe");

  const requireSupported = (instanceId: ProviderInstanceId) =>
    squireSupport(instanceId).pipe(
      Effect.flatMap((support) =>
        support.supported
          ? Effect.void
          : Effect.fail(
              new SquireError({
                code: "provider_unsupported",
                message: support.reason ?? "This provider is not supported as a Squire provider.",
              }),
            ),
      ),
    );

  const defaultModelFor = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const instance = yield* providers.getInstance(instanceId);
      const models = instance === undefined ? [] : (yield* instance.snapshot.getSnapshot).models;
      const model = models.find((candidate) => candidate.isDefault) ?? models[0];
      if (model === undefined)
        return yield* new SquireError({ code: "invalid_request", message: "Choose a model." });
      return { instanceId, model: model.slug } satisfies ModelSelection;
    });

  /** The provider and model a create or update asks for, checked against D10. */
  const resolveModel = (
    instanceId: ProviderInstanceId,
    modelSelection: ModelSelection | undefined,
  ) =>
    Effect.gen(function* () {
      if (modelSelection !== undefined && modelSelection.instanceId !== instanceId) {
        return yield* new SquireError({
          code: "invalid_request",
          message: "The model belongs to a different provider.",
        });
      }
      yield* requireSupported(instanceId);
      return modelSelection ?? (yield* defaultModelFor(instanceId));
    });

  const requireProject = (projectId: ProjectId) =>
    projects.get(projectId).pipe(
      orSquireError("read the project"),
      Effect.flatMap((project) =>
        Effect.fromOption(
          project,
          () =>
            new SquireError({ code: "not_found", message: "The home project no longer exists." }),
        ),
      ),
    );

  const threadShell = (targetId: string) =>
    projections.getThreadShell(ThreadId.make(targetId)).pipe(orSquireError("read the thread"));

  // P1.4: a Squire never tracks a Squire thread.
  const validateGrant = (grant: SquireGrantInput) =>
    Effect.gen(function* () {
      if (grant.kind === "thread") {
        const shell = yield* threadShell(grant.targetId);
        if (shell === null)
          return yield* new SquireError({
            code: "not_found",
            message: "That thread no longer exists.",
          });
        if (isSquireThread(shell)) {
          return yield* new SquireError({
            code: "out_of_scope",
            message: "A Squire cannot track a Squire's thread.",
          });
        }
      } else if (grant.kind === "project") {
        yield* requireProject(ProjectId.make(grant.targetId));
      }
    });

  const validatePermissions = (
    role: SquireRepository.SquireRow["role"],
    permissions: SquirePermissions,
  ) =>
    role !== "lead" && permissions.manageSquires !== undefined
      ? Effect.fail(
          new SquireError({
            code: "invalid_request",
            message: "Only the Lead has Manage Squires.",
          }),
        )
      : Effect.void;

  const takenCompanions = (exclude?: SquireId) =>
    repository.listSquires.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows.filter((row) => row.id !== exclude),
          (row) => decodeCompanion(row.companion_json),
        ),
      ),
    );

  const grantRow = (squireId: SquireId, grant: SquireGrantInput, createdAt: string) => ({
    squire_id: squireId,
    kind: grant.kind,
    target_id: grant.targetId,
    origin: "granted" as const,
    created_at: createdAt,
  });

  const settle = (squireId: SquireId) =>
    lifecycle.drive(squireId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new SquireError({ code: "not_found", message: "This Squire no longer exists." }),
            ),
          onSome: toSquire,
        }),
      ),
    );

  const list: SquireService["Service"]["list"] = repository.listSquires.pipe(
    orSquireError("list Squires"),
    Effect.flatMap((rows) =>
      Effect.forEach(
        rows.filter((row) => row.lifecycle !== "deleting"),
        toSquire,
      ),
    ),
  );

  const get: SquireService["Service"]["get"] = (squireId) =>
    repository.getSquire(squireId).pipe(
      orSquireError("read the Squire"),
      Effect.flatMap((row) =>
        Option.isNone(row) || row.value.lifecycle === "deleting"
          ? Effect.succeedNone
          : Effect.asSome(toSquire(row.value)),
      ),
    );

  const create: SquireService["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* repository
        .getSquireByCreateRequestId(input.requestId)
        .pipe(orSquireError("read the Squire"));
      if (Option.isSome(existing)) return yield* settle(existing.value.id);

      yield* requireProject(input.homeProjectId);
      const modelSelection = yield* resolveModel(input.providerInstanceId, input.modelSelection);
      yield* validatePermissions("squire", input.permissions);
      for (const grant of input.grants) {
        if (grant.kind === "exclusion") continue;
        yield* validateGrant(grant);
      }

      const squireId = SquireId.make(`squire-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`);
      // Under the policy lock so two creates never pick the same default companion.
      const inserted = yield* withPolicyLock(
        Effect.gen(function* () {
          const now = yield* nowIso;
          const companion = input.companion ?? nextDefaultCompanion(yield* takenCompanions());
          const row: SquireRepository.SquireRow = {
            id: squireId,
            role: "squire",
            name: input.name,
            lifecycle: "creating",
            home_generation: 1,
            home_thread_id: SquireLifecycle.homeThreadIdFor(squireId, 1),
            home_project_id: input.homeProjectId,
            provider_instance_id: input.providerInstanceId,
            model_selection_json: encodeModel(modelSelection),
            summary_model_selection_json:
              input.summaryModelSelection === undefined || input.summaryModelSelection === null
                ? null
                : encodeModel(input.summaryModelSelection),
            brief: input.brief,
            status: "active",
            events_json: encodeEvents(input.events),
            permissions_json: encodePermissions(input.permissions),
            budgets_json: encodeBudgets(input.budgets),
            undo_window_seconds: input.undoWindowSeconds,
            digest_json: null,
            digest_last_date: null,
            onboarded_at: null,
            sweep_json: null,
            user_active_at: null,
            inactivity_prompted_at: null,
            automation_paused_at: null,
            companion_json: encodeCompanion(companion),
            revision: 0,
            create_request_id: input.requestId,
            created_at: now,
            updated_at: now,
          };
          return yield* repository.transaction(
            Effect.gen(function* () {
              yield* repository.createSquire(row);
              for (const grant of input.grants) {
                yield* repository.insertGrant(grantRow(squireId, grant, now));
              }
              return squireId;
            }),
          );
        }),
      ).pipe(
        // A concurrent retry of the same request won the UNIQUE create_request_id.
        Effect.catch((cause) =>
          repository
            .getSquireByCreateRequestId(input.requestId)
            .pipe(
              Effect.flatMap((winner) =>
                Option.isSome(winner) ? Effect.succeed(winner.value.id) : Effect.fail(cause),
              ),
            ),
        ),
        orSquireError("create the Squire"),
      );

      return yield* settle(inserted).pipe(
        // A create that cannot finish leaves nothing behind; a retry starts over.
        Effect.tapError(() =>
          Effect.gen(function* () {
            yield* repository.updateSquire({
              id: inserted,
              patch: { lifecycle: "deleting" },
              updatedAt: yield* nowIso,
            });
            yield* lifecycle.drive(inserted);
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not roll back a failed Squire create", { cause }),
            ),
          ),
        ),
      );
    });

  const update: SquireService["Service"]["update"] = (input) =>
    withPolicyLock(
      Effect.gen(function* () {
        const row = yield* requireRow(input.squireId);
        if (row.revision !== input.expectedRevision) return yield* conflict;
        const isLead = row.role === "lead";

        if (
          !isLead &&
          (input.digest !== undefined || input.sweep !== undefined || input.timezone !== undefined)
        ) {
          return yield* new SquireError({
            code: "invalid_request",
            message: "Only the Lead has a digest, a timezone, and a sweep.",
          });
        }
        if (input.timezone !== undefined && Option.isNone(DateTime.zoneMakeNamed(input.timezone))) {
          return yield* new SquireError({
            code: "invalid_request",
            message: `Unknown timezone "${input.timezone}".`,
          });
        }
        if (isLead && input.grants !== undefined) {
          return yield* new SquireError({
            code: "invalid_request",
            message: "The Lead has no access scope.",
          });
        }
        if (!isLead && input.companion?.palette === "gold") {
          return yield* new SquireError({
            code: "invalid_request",
            message: "Gold is reserved for the Lead.",
          });
        }
        if (input.permissions !== undefined)
          yield* validatePermissions(row.role, input.permissions);
        for (const grant of input.grants ?? []) {
          if (grant.kind === "exclusion") continue;
          yield* validateGrant(grant);
        }

        const currentModel =
          row.model_selection_json === null
            ? null
            : yield* decodeModel(row.model_selection_json).pipe(orSquireError("read the Squire"));
        const targetInstance =
          input.providerInstanceId ??
          input.modelSelection?.instanceId ??
          (row.provider_instance_id === null
            ? null
            : ProviderInstanceId.make(row.provider_instance_id));
        const providerChanged = targetInstance !== row.provider_instance_id;
        const modelChanged =
          providerChanged ||
          (input.modelSelection !== undefined &&
            (currentModel === null || !sameModel(input.modelSelection, currentModel)));
        let modelSelection = currentModel;
        if (modelChanged && targetInstance !== null) {
          if (row.lifecycle !== "ready" && row.lifecycle !== "needs_provider") {
            return yield* new SquireError({
              code: "invalid_request",
              message: "This Squire is still being set up. Try again.",
            });
          }
          modelSelection = yield* resolveModel(
            targetInstance,
            input.modelSelection ??
              (providerChanged || currentModel === null ? undefined : currentModel),
          );
        }

        const name = input.name ?? row.name;
        // D7: choosing a supported provider gives a waiting Lead its one home thread.
        const leavesNeedsProvider = row.lifecycle === "needs_provider" && modelSelection !== null;
        const generation = leavesNeedsProvider ? row.home_generation + 1 : row.home_generation;
        if (row.lifecycle === "ready" && row.home_thread_id !== null && modelSelection !== null) {
          // The thread changes first, so a refused switch leaves the record as it was.
          yield* lifecycle.syncHome({
            squireId: row.id,
            threadId: row.home_thread_id,
            name,
            modelSelection,
            key: `update:${input.requestId}`,
          });
        }

        const companion =
          input.companion === undefined
            ? undefined
            : isLead
              ? { ...input.companion, palette: "gold" as const }
              : input.companion;
        const permissions =
          input.permissions === undefined
            ? undefined
            : isLead
              ? {
                  ...input.permissions,
                  manageSquires: input.permissions.manageSquires ?? ("recommend" as const),
                }
              : input.permissions;
        const now = yield* nowIso;
        const updated = yield* repository
          .transaction(
            Effect.gen(function* () {
              const next = yield* repository.updateSquire({
                id: row.id,
                expectedRevision: input.expectedRevision,
                updatedAt: now,
                patch: {
                  name,
                  ...(input.brief === undefined ? {} : { brief: input.brief }),
                  ...(modelChanged && modelSelection !== null
                    ? {
                        provider_instance_id: modelSelection.instanceId,
                        model_selection_json: encodeModel(modelSelection),
                      }
                    : {}),
                  ...(leavesNeedsProvider
                    ? {
                        lifecycle: "creating" as const,
                        home_generation: generation,
                        home_thread_id: SquireLifecycle.homeThreadIdFor(row.id, generation),
                      }
                    : {}),
                  ...(input.summaryModelSelection === undefined
                    ? {}
                    : {
                        summary_model_selection_json:
                          input.summaryModelSelection === null
                            ? null
                            : encodeModel(input.summaryModelSelection),
                      }),
                  ...(input.events === undefined
                    ? {}
                    : { events_json: encodeEvents(input.events) }),
                  ...(permissions === undefined
                    ? {}
                    : { permissions_json: encodePermissions(permissions) }),
                  ...(input.budgets === undefined
                    ? {}
                    : { budgets_json: encodeBudgets(input.budgets) }),
                  ...(input.undoWindowSeconds === undefined
                    ? {}
                    : { undo_window_seconds: input.undoWindowSeconds }),
                  ...(companion === undefined
                    ? {}
                    : { companion_json: encodeCompanion(companion) }),
                  ...(input.digest === undefined
                    ? {}
                    : { digest_json: input.digest === null ? null : encodeDigest(input.digest) }),
                  ...(input.sweep === undefined ? {} : { sweep_json: encodeSweep(input.sweep) }),
                  ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
                },
              });
              if (Option.isNone(next) || input.grants === undefined) return next;
              const wanted = new Set(
                input.grants.map((grant) => `${grant.kind}\u0000${grant.targetId}`),
              );
              for (const grant of yield* repository.listGrants(row.id)) {
                if (!wanted.has(`${grant.kind}\u0000${grant.target_id}`)) {
                  yield* repository.deleteGrant({
                    squireId: row.id,
                    kind: grant.kind,
                    targetId: grant.target_id,
                  });
                }
              }
              // Existing grants keep their origin (a Squire-created thread stays labeled).
              for (const grant of input.grants) {
                yield* repository.insertGrant(grantRow(row.id, grant, now));
              }
              yield* rules.disableOutOfScope(row.id);
              return next;
            }),
          )
          .pipe(orSquireError("update the Squire"));
        if (Option.isNone(updated)) return yield* conflict;
        return updated.value;
      }),
    ).pipe(
      Effect.flatMap((row) => (row.lifecycle === "creating" ? settle(row.id) : toSquire(row))),
    );

  const setStatus: SquireService["Service"]["setStatus"] = (input) =>
    withPolicyLock(
      Effect.gen(function* () {
        const row = yield* requireRow(input.squireId);
        if (row.status === input.status) return row;
        const now = yield* nowIso;
        const updated = yield* repository
          .transaction(
            Effect.gen(function* () {
              // D34: a paused Squire accepts no events and its holds become
              // recommendations it no longer executes.
              if (input.status === "paused") {
                yield* repository.dropDeferredEvents(row.id);
                const opened = yield* repository.openHeldCards({
                  squireId: row.id,
                  updatedAt: now,
                });
                // P17.5: a hold turned recommendation is a decision item the Lead
                // now has to see; the delivery clock wakes it on the new row.
                for (const cardId of opened) {
                  const card = yield* repository.getCard(cardId);
                  if (Option.isSome(card)) {
                    yield* writeLeadItemEvent(repository, {
                      transition: "raised",
                      card: card.value,
                      now,
                    });
                  }
                }
              }
              return yield* repository.updateSquire({
                id: row.id,
                patch: { status: input.status },
                updatedAt: now,
              });
            }),
          )
          .pipe(orSquireError("change the Squire's status"));
        if (Option.isNone(updated))
          return yield* new SquireError({
            code: "not_found",
            message: "This Squire no longer exists.",
          });
        return updated.value;
      }),
    ).pipe(Effect.flatMap(toSquire));

  const deleteSquire: SquireService["Service"]["delete"] = (input) =>
    Effect.gen(function* () {
      yield* withPolicyLock(
        Effect.gen(function* () {
          const row = yield* repository
            .getSquire(input.squireId)
            .pipe(orSquireError("read the Squire"));
          // A retry after the delete finished.
          if (Option.isNone(row)) return;
          if (row.value.role === "lead") {
            return yield* new SquireError({
              code: "permission_denied",
              message: "The Lead cannot be deleted.",
            });
          }
          if (row.value.lifecycle === "deleting") return;
          yield* repository
            .updateSquire({
              id: row.value.id,
              patch: { lifecycle: "deleting" },
              updatedAt: yield* nowIso,
            })
            .pipe(orSquireError("delete the Squire"));
        }),
      );
      yield* lifecycle.drive(input.squireId);
      return { squireId: input.squireId };
    });

  const scopedRow = (squireId: SquireId, grant: SquireGrantInput) =>
    Effect.gen(function* () {
      const row = yield* requireRow(squireId);
      if (row.role === "lead")
        return yield* new SquireError({
          code: "invalid_request",
          message: "The Lead has no access scope.",
        });
      if (grant.kind === "exclusion") {
        return yield* new SquireError({
          code: "invalid_request",
          message: "Track or untrack the thread itself.",
        });
      }
      return row;
    });

  const bumpRevision = (squireId: SquireId, updatedAt: string) =>
    repository.updateSquire({ id: squireId, patch: {}, updatedAt });

  const track: SquireService["Service"]["track"] = (input) =>
    withPolicyLock(
      Effect.gen(function* () {
        const row = yield* scopedRow(input.squireId, input.grant);
        yield* validateGrant(input.grant);
        const now = yield* nowIso;
        return yield* repository
          .transaction(
            Effect.gen(function* () {
              if (input.grant.kind === "thread") {
                yield* repository.deleteGrant({
                  squireId: row.id,
                  kind: "exclusion",
                  targetId: input.grant.targetId,
                });
              }
              yield* repository.insertGrant(grantRow(row.id, input.grant, now));
              yield* rules.disableOutOfScope(row.id);
              return yield* bumpRevision(row.id, now);
            }),
          )
          .pipe(orSquireError("track the thread"));
      }),
    ).pipe(
      Effect.flatMap((row) =>
        Option.isSome(row)
          ? toSquire(row.value)
          : Effect.fail(
              new SquireError({ code: "not_found", message: "This Squire no longer exists." }),
            ),
      ),
    );

  const untrack: SquireService["Service"]["untrack"] = (input) =>
    withPolicyLock(
      Effect.gen(function* () {
        const row = yield* scopedRow(input.squireId, input.grant);
        const now = yield* nowIso;
        return yield* repository
          .transaction(
            Effect.gen(function* () {
              yield* repository.deleteGrant({
                squireId: row.id,
                kind: input.grant.kind,
                targetId: input.grant.targetId,
              });
              // Read after the delete and uncached, so a thread still in scope is
              // one a project or Stave grant covers; only those need an exclusion.
              if (
                input.grant.kind === "thread" &&
                (yield* scope.ruleTargetInScope({
                  squireId: row.id,
                  targetKind: "thread",
                  targetId: input.grant.targetId,
                }))
              ) {
                yield* repository.insertGrant(
                  grantRow(row.id, { kind: "exclusion", targetId: input.grant.targetId }, now),
                );
              }
              yield* rules.disableOutOfScope(row.id);
              return yield* bumpRevision(row.id, now);
            }),
          )
          .pipe(orSquireError("untrack the thread"));
      }),
    ).pipe(
      Effect.flatMap((row) =>
        Option.isSome(row)
          ? toSquire(row.value)
          : Effect.fail(
              new SquireError({ code: "not_found", message: "This Squire no longer exists." }),
            ),
      ),
    );

  const ensureLead: SquireService["Service"]["ensureLead"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* repository.getLead.pipe(orSquireError("read the Lead"));
      if (Option.isSome(existing)) return Option.some(yield* toSquire(existing.value));
      const project = yield* lifecycle.homeProjectCandidate();
      if (Option.isNone(project)) return Option.none();

      // P17.1: the user's default provider, as a new thread in that project picks it.
      const settings = yield* serverSettings.getSettings.pipe(orSquireError("read settings"));
      const defaultModel = resolveProjectSettings(settings, project.value.projectId, project.value)
        .settings.defaultModelSelection;
      const supported =
        defaultModel !== null && (yield* squireSupport(defaultModel.instanceId)).supported;

      const squireId = SquireId.make(`squire-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`);
      const now = yield* nowIso;
      const row: SquireRepository.SquireRow = {
        id: squireId,
        role: "lead",
        name: LEAD_NAME,
        lifecycle: supported ? "creating" : "needs_provider",
        home_generation: supported ? 1 : 0,
        home_thread_id: supported ? SquireLifecycle.homeThreadIdFor(squireId, 1) : null,
        home_project_id: project.value.projectId,
        provider_instance_id: supported ? defaultModel.instanceId : null,
        model_selection_json: supported ? encodeModel(defaultModel) : null,
        summary_model_selection_json: null,
        brief: "",
        status: "active",
        events_json: encodeEvents(DEFAULT_EVENTS),
        permissions_json: encodePermissions(DEFAULT_LEAD_SQUIRE_PERMISSIONS),
        budgets_json: encodeBudgets({
          ...DEFAULT_SQUIRE_BUDGETS,
          messagesPerDay: DEFAULT_LEAD_MESSAGES_PER_DAY,
        }),
        undo_window_seconds: 10,
        digest_json: null,
        digest_last_date: null,
        onboarded_at: null,
        sweep_json: encodeSweep(DEFAULT_LEAD_SWEEP),
        user_active_at: null,
        inactivity_prompted_at: null,
        automation_paused_at: null,
        companion_json: encodeCompanion(SQUIRE_LEAD_COMPANION),
        revision: 0,
        create_request_id: `lead:${input.requestId}`,
        created_at: now,
        updated_at: now,
      };
      const leadId = yield* repository.createSquire(row).pipe(
        Effect.as(squireId),
        // The partial unique index admits one Lead; a concurrent ensure won.
        Effect.catch((cause) =>
          repository.getLead.pipe(
            Effect.flatMap((winner) =>
              Option.isSome(winner) ? Effect.succeed(winner.value.id) : Effect.fail(cause),
            ),
          ),
        ),
        orSquireError("create the Lead"),
      );
      return Option.some(yield* settle(leadId));
    });

  // Delivery sends a voice-note row alone with origin `voice`, so its turn only
  // recommends (P12.2); the clock wakes the Squire on the new row.
  const voiceNote: SquireService["Service"]["voiceNote"] = (input) =>
    Effect.gen(function* () {
      const voiceNoteId = voiceNoteIdFor(input.requestId);
      const row = yield* requireRow(input.squireId);
      if (row.role === "lead") {
        return yield* new SquireError({
          code: "invalid_request",
          message: "Voice notes go to a Squire, not the Lead.",
        });
      }
      const recorded = yield* repository
        .hasThreadlessEvent({ squireId: row.id, kind: "voice-note", stateKey: voiceNoteId })
        .pipe(orSquireError("read the voice note"));
      if (recorded) return { voiceNoteId };
      if (row.status !== "active") {
        return yield* new SquireError({
          code: "invalid_request",
          message: "This Squire is paused. Resume it to send a voice note.",
        });
      }
      const now = yield* nowIso;
      yield* repository
        .insertTriggerEvent({
          squire_id: row.id,
          thread_id: null,
          kind: "voice-note",
          state_key: voiceNoteId,
          payload_json: encodeEventJson({
            type: "voice-note",
            voiceNoteId,
            transcript: input.transcript,
            speakerVerified: input.speakerVerified,
            source: input.source,
          }),
          status: "pending",
          defer_reason: null,
          not_before: now,
          batch_id: null,
          created_at: now,
        })
        .pipe(orSquireError("queue the voice note"));
      return { voiceNoteId };
    });

  // P3.6: these are user RPCs; no server path calls them.
  const touched =
    <I, A, E, R>(method: (input: I) => Effect.Effect<A, E, R>) =>
    (input: I) =>
      method(input).pipe(
        Effect.tap(() => Effect.flatMap(nowIso, (now) => touchUserActivity(repository, now))),
      );

  return SquireService.of({
    list,
    get,
    create: touched(create),
    update: touched(update),
    setStatus: touched(setStatus),
    delete: touched(deleteSquire),
    track: touched(track),
    untrack: touched(untrack),
    ensureLead,
    voiceNote: touched(voiceNote),
    squireSupport,
    probeSupport,
    providerSupport: Effect.gen(function* () {
      const instances = yield* providers.listInstances;
      return {
        instances: yield* Effect.forEach(instances, (instance) =>
          squireSupport(instance.instanceId).pipe(
            Effect.map((support) => ({
              instanceId: instance.instanceId,
              supported: support.supported,
              reason: support.reason ?? null,
            })),
          ),
        ),
      };
    }),
  });
});

/**
 * D7: why a `needs_provider` Lead waits, shown with the provider picker
 * filtered to supported instances.
 */
export const needsProviderReason = Effect.gen(function* () {
  const service = yield* SquireService;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  for (const instance of yield* providers.listInstances) {
    if ((yield* service.squireSupport(instance.instanceId)).supported) return CHOOSE_LEAD_PROVIDER;
  }
  return NO_SUPPORTED_PROVIDER;
});

export const layer = Layer.effect(SquireService, make);
