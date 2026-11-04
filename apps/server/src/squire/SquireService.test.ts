// @effect-diagnostics nodeBuiltinImport:off - Fixture repos are built and inspected with synchronous fs, outside the code under test.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderInstanceId,
  SQUIRE_LEAD_COMPANION,
  SquireCardId,
  SquireCreateInput,
  type SquireError,
  SquireId,
  SquireUpdateInput,
  ThreadId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRules from "./SquireRules.ts";
import * as SquireService from "./SquireService.ts";
import {
  claude,
  codex,
  cursor,
  initRepo,
  isOwnRepository,
  lecturnRefs,
  markedThreads,
  scripted,
  scriptedB,
  scriptedBModel,
  scriptedModel,
  seedProject,
  serverLayer,
  tempRoot,
  workspacePath,
  ALL_INSTANCES,
  type HarnessOptions,
  instanceOf,
} from "./testkit/lifecycleHarness.ts";

const homeProject = ProjectId.make("project-home");

const decodeCreateInput = Schema.decodeSync(SquireCreateInput);
const decodeUpdateInput = Schema.decodeSync(SquireUpdateInput);

const createInput = (
  requestId: string,
  overrides: Partial<typeof SquireCreateInput.Encoded> = {},
): typeof SquireCreateInput.Type =>
  decodeCreateInput({
    requestId,
    homeProjectId: homeProject,
    providerInstanceId: scripted,
    modelSelection: scriptedModel,
    name: "Release",
    brief: "Watch the release",
    grants: [],
    events: {},
    permissions: {},
    budgets: {},
    ...overrides,
  });

const updateInput = (
  input: Omit<typeof SquireUpdateInput.Encoded, "requestId"> & { readonly requestId?: string },
) => decodeUpdateInput({ requestId: "update", ...input });

const codeOf = <A>(effect: Effect.Effect<A, SquireError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

const userThreadCreate = (threadId: ThreadId) =>
  ({
    type: "thread.create",
    commandId: CommandId.make(`${threadId}:create`),
    threadId,
    projectId: homeProject,
    title: "Fix the build",
    modelSelection: scriptedModel,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  }) as const;

/** One server over a fresh Lecturn home with a Git-backed home project. */
const withServer = <A, E, R>(
  body: (home: {
    readonly baseDir: string;
    readonly projectRoot: string;
  }) => Effect.Effect<A, E, R>,
  options: HarnessOptions & { readonly project?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    const projectRoot = initRepo(NodePath.join(root, "home-project"));
    return yield* Effect.gen(function* () {
      if (options.project !== false) yield* seedProject(homeProject, projectRoot);
      return yield* body({ baseDir, projectRoot });
    }).pipe(Effect.provide(serverLayer(baseDir, options)));
  }).pipe(Effect.scoped);

describe("SquireService", () => {
  it.live(
    "creates a home thread in the scratch repo, and its runs leave the home project alone",
    () =>
      withServer(({ baseDir, projectRoot }) =>
        Effect.gen(function* () {
          const service = yield* SquireService.SquireService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;

          const squire = yield* service.create(createInput("create-1"));
          assert.equal(squire.lifecycle, "ready");
          // Brass reads as the Lead's gold, so even the first Squire avoids it.
          assert.notInclude(["gold", "brass"], squire.companion.palette);
          const again = yield* service.create(createInput("create-1"));
          assert.equal(again.id, squire.id);
          assert.lengthOf(yield* service.list, 1);

          const scratch = workspacePath(baseDir, squire.id);
          assert.isTrue(isOwnRepository(scratch));
          const shell = (yield* projections.getThreadShell(squire.homeThreadId!))!;
          assert.equal(shell.title, "Squire · Release");
          assert.deepEqual(shell.squire, { squireId: squire.id, role: "home" });
          assert.equal(shell.worktreePath, scratch);
          assert.isNull(shell.branch);
          assert.equal(shell.projectId, homeProject);
          assert.isNotNull(shell.autoSettleDisabledAt ?? null);
          assert.lengthOf((yield* markedThreads(squire.id)).live, 1);

          // A user may talk to the home thread; the turn checkpoints into the scratch repo.
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("message:home"),
            threadId: squire.homeThreadId!,
            messageId: MessageId.make("message:home"),
            text: 'Hi.\n\n```scripted\n[{ "assistantText": "Noted." }]\n```\n',
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const persisted = (status: string) =>
            orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                (stored: OrchestrationV2StoredEvent) =>
                  stored.event.type === "run.updated" && stored.event.payload.status === status,
              ),
              Stream.runHead,
            );
          yield* worker.drain();
          yield* persisted("waiting");
          yield* worker.drain();
          yield* persisted("completed");
          assert.equal(lecturnRefs(projectRoot), "");
          assert.include(lecturnRefs(scratch), "refs/lecturn/");
        }),
      ),
  );

  it.live("gives three Squires without a companion three distinct looks, none gold", () =>
    withServer(() =>
      Effect.gen(function* () {
        const service = yield* SquireService.SquireService;
        const companions = [];
        for (const requestId of ["a", "b", "c"]) {
          companions.push((yield* service.create(createInput(requestId))).companion);
        }
        // Appearance and hood first, then palette, then equipment.
        assert.equal(new Set(companions.map((c) => `${c.appearance}/${c.hood}`)).size, 3);
        assert.equal(new Set(companions.map((c) => c.palette)).size, 3);
        assert.equal(new Set(companions.map((c) => c.equipment)).size, 3);
        assert.isFalse(companions.some((c) => c.palette === "gold"));
        // The Lead's equipment is its own, even before the Lead exists.
        assert.isFalse(companions.some((c) => c.equipment === SQUIRE_LEAD_COMPANION.equipment));

        const squire = yield* service.create(createInput("d"));
        assert.equal(
          yield* codeOf(
            service.update(
              updateInput({
                squireId: squire.id,
                expectedRevision: squire.revision,
                companion: { palette: "gold" },
              }),
            ),
          ),
          "invalid_request",
        );
      }),
    ),
  );

  it.live("keeps one Lead per environment, in gold, and refuses to delete it", () =>
    withServer(
      ({ projectRoot }) =>
        Effect.gen(function* () {
          const service = yield* SquireService.SquireService;
          const repository = yield* SquireRepository.SquireRepository;
          const projects = yield* ProjectionStore.ProjectionStoreV2;
          assert.isTrue(Option.isNone(yield* service.ensureLead({ requestId: "lead-0" })));

          yield* seedProject(homeProject, projectRoot);
          const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead-1" }));
          assert.equal(lead.role, "lead");
          assert.equal(lead.lifecycle, "ready");
          assert.equal(lead.homeProjectId, homeProject);
          assert.equal(lead.providerInstanceId, scripted);
          assert.equal(lead.companion.palette, "gold");
          assert.equal(lead.companion.equipment, SQUIRE_LEAD_COMPANION.equipment);
          assert.equal(lead.permissions.manageSquires, "recommend");
          assert.isNotNull(yield* projects.getThreadShell(lead.homeThreadId!));

          const second = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead-2" }));
          assert.equal(second.id, lead.id);
          const leads = (yield* repository.listSquires).filter((row) => row.role === "lead");
          assert.lengthOf(leads, 1);
          // The partial unique index is what makes ensureLead race-safe.
          const row = Option.getOrThrow(yield* repository.getSquire(lead.id));
          const duplicate = yield* repository
            .createSquire({
              ...row,
              id: SquireId.make("squire-second-lead"),
              create_request_id: null,
            })
            .pipe(Effect.flip);
          assert.equal(duplicate._tag, "PersistenceSqlError");

          assert.equal(
            yield* codeOf(service.delete({ requestId: "delete-lead", squireId: lead.id })),
            "permission_denied",
          );
          assert.isTrue(Option.isSome(yield* service.get(lead.id)));
          // The Lead keeps gold even when an update asks otherwise.
          const kept = yield* service.update(
            updateInput({
              squireId: lead.id,
              expectedRevision: lead.revision,
              companion: { palette: "rose", equipment: "lance" },
            }),
          );
          assert.equal(kept.companion.palette, "gold");
          assert.equal(kept.companion.equipment, "lance");
        }),
      { project: false, defaultModelSelection: scriptedModel },
    ),
  );

  it.live("waits for a provider when the default is unsupported, then makes one home thread", () =>
    withServer(
      ({ baseDir }) =>
        Effect.gen(function* () {
          const service = yield* SquireService.SquireService;
          const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
          assert.equal(lead.lifecycle, "needs_provider");
          assert.isNull(lead.homeThreadId);
          assert.isNull(lead.providerInstanceId);
          assert.isFalse(NodeFS.existsSync(workspacePath(baseDir, lead.id)));
          assert.deepEqual(yield* markedThreads(lead.id), { live: [], archived: [] });
          assert.equal(
            yield* SquireService.needsProviderReason,
            SquireService.CHOOSE_LEAD_PROVIDER,
          );

          assert.equal(
            yield* codeOf(
              service.update(
                updateInput({
                  squireId: lead.id,
                  expectedRevision: lead.revision,
                  providerInstanceId: cursor,
                }),
              ),
            ),
            "provider_unsupported",
          );
          const ready = yield* service.update(
            updateInput({
              squireId: lead.id,
              expectedRevision: lead.revision,
              providerInstanceId: scripted,
              modelSelection: scriptedModel,
            }),
          );
          assert.equal(ready.lifecycle, "ready");
          assert.equal(ready.providerInstanceId, scripted);
          const threads = yield* markedThreads(lead.id);
          assert.lengthOf(threads.live, 1);
          assert.lengthOf(threads.archived, 0);
          assert.equal(threads.live[0]!.id, ready.homeThreadId);
          assert.isTrue(isOwnRepository(workspacePath(baseDir, lead.id)));
        }),
      { defaultModelSelection: { instanceId: cursor, model: "auto" } },
    ),
  );

  it.live("leaves the Lead waiting with no supported provider at all", () =>
    withServer(
      () =>
        Effect.gen(function* () {
          const service = yield* SquireService.SquireService;
          const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
          assert.equal(lead.lifecycle, "needs_provider");
          assert.equal(
            yield* SquireService.needsProviderReason,
            SquireService.NO_SUPPORTED_PROVIDER,
          );
          assert.equal(
            yield* codeOf(
              service.update(
                updateInput({
                  squireId: lead.id,
                  expectedRevision: lead.revision,
                  providerInstanceId: scripted,
                  modelSelection: scriptedModel,
                }),
              ),
            ),
            "provider_unsupported",
          );
          const after = Option.getOrThrow(yield* service.get(lead.id));
          assert.equal(after.lifecycle, "needs_provider");
          assert.deepEqual(yield* markedThreads(lead.id), { live: [], archived: [] });
        }),
      {
        defaultModelSelection: scriptedModel,
        instances: ALL_INSTANCES.filter((instance) => instance.instanceId !== codex),
        testProviders: false,
        managedMcpConfig: true,
      },
    ),
  );

  it.live(
    "refuses unsupported and managed-config instances on create, update, and provider change",
    () =>
      Effect.gen(function* () {
        yield* withServer(
          () =>
            Effect.gen(function* () {
              const service = yield* SquireService.SquireService;
              assert.isTrue((yield* service.squireSupport(codex)).supported);
              assert.isTrue((yield* service.squireSupport(claude)).supported);
              assert.isTrue((yield* service.squireSupport(scripted)).supported);
              const unsupported = yield* service.squireSupport(cursor);
              assert.isFalse(unsupported.supported);
              assert.include(unsupported.reason, "not supported as a Squire provider");
              assert.isTrue((yield* service.probeSupport(codex)).supported);
              assert.isTrue((yield* service.probeSupport(claude)).supported);
              const noProbe = yield* service.probeSupport(cursor);
              assert.isFalse(noProbe.supported);
              assert.include(noProbe.reason, "Ask is not available");

              assert.equal(
                yield* codeOf(
                  service.create(
                    createInput("cursor", {
                      providerInstanceId: cursor,
                      modelSelection: { instanceId: cursor, model: "auto" },
                    }),
                  ),
                ),
                "provider_unsupported",
              );
              assert.lengthOf(yield* service.list, 0);

              const squire = yield* service.create(createInput("ok"));
              assert.equal(
                yield* codeOf(
                  service.update(
                    updateInput({
                      squireId: squire.id,
                      expectedRevision: squire.revision,
                      providerInstanceId: cursor,
                    }),
                  ),
                ),
                "provider_unsupported",
              );
              assert.equal(
                yield* codeOf(
                  service.update(
                    updateInput({
                      squireId: squire.id,
                      expectedRevision: squire.revision,
                      modelSelection: { instanceId: cursor, model: "auto" },
                    }),
                  ),
                ),
                "provider_unsupported",
              );
              const unchanged = Option.getOrThrow(yield* service.get(squire.id));
              assert.equal(unchanged.providerInstanceId, scripted);
              assert.equal(unchanged.revision, squire.revision);
            }),
          { defaultModelSelection: scriptedModel },
        );

        yield* withServer(
          () =>
            Effect.gen(function* () {
              const service = yield* SquireService.SquireService;
              const managed = yield* service.squireSupport(claude);
              assert.isFalse(managed.supported);
              assert.include(managed.reason, "managed MCP configuration");
              const managedProbe = yield* service.probeSupport(claude);
              assert.isFalse(managedProbe.supported);
              assert.include(managedProbe.reason, "managed MCP configuration");
              assert.isTrue((yield* service.probeSupport(codex)).supported);
              assert.isTrue((yield* service.squireSupport(codex)).supported);
              assert.isFalse((yield* service.squireSupport(scripted)).supported);
              assert.equal(
                yield* codeOf(
                  service.create(
                    createInput("claude", {
                      providerInstanceId: claude,
                      modelSelection: { instanceId: claude, model: "claude-opus-5-5" },
                    }),
                  ),
                ),
                "provider_unsupported",
              );
              assert.lengthOf(yield* service.list, 0);
            }),
          { managedMcpConfig: true, testProviders: false },
        );
      }),
  );

  it.live("gives every 12.2 driver its own decision and a reason the picker can show", () => {
    const drivers = ["githubCopilot", "grok", "antigravity", "opencode", "cursor"] as const;
    const instances = drivers.map((driver) =>
      instanceOf(ProviderInstanceId.make(`rollout-${driver}`), driver),
    );
    return withServer(
      () =>
        Effect.gen(function* () {
          const service = yield* SquireService.SquireService;
          const { instances: support } = yield* service.providerSupport;
          for (const driver of drivers) {
            const row = support.find((entry) => entry.instanceId === `rollout-${driver}`);
            assert.isDefined(row, driver);
            if (row?.supported === false) {
              // A bare "not supported" leaves the user guessing; the picker shows why.
              assert.match(
                row.reason ?? "",
                /not supported as a Squire provider\. \S.+\.$/,
                driver,
              );
              assert.notInclude(row.reason ?? "", "PENDING", driver);
            }
          }
        }),
      { defaultModelSelection: scriptedModel, instances: [...ALL_INSTANCES, ...instances] },
    );
  });

  it.live("refuses an instance whose adapter reports a Squire login gap, in its words", () => {
    const reason = "A Squire can use only a Codex sign-in saved as a file.";
    return withServer(
      () =>
        Effect.gen(function* () {
          const service = yield* SquireService.SquireService;
          assert.deepEqual(yield* service.squireSupport(codex), { supported: false, reason });
          assert.deepEqual(yield* service.probeSupport(codex), { supported: false, reason });
          const refused = yield* service
            .create(
              createInput("codex", {
                providerInstanceId: codex,
                modelSelection: { instanceId: codex, model: "scripted" },
              }),
            )
            .pipe(Effect.flip);
          assert.equal(refused.code, "provider_unsupported");
          assert.equal(refused.message, reason);
          assert.lengthOf(yield* service.list, 0);
        }),
      {
        defaultModelSelection: scriptedModel,
        instances: ALL_INSTANCES.map((instance) =>
          instance.instanceId === codex
            ? {
                ...instance,
                orchestrationAdapter: {
                  ...instance.orchestrationAdapter,
                  squireReadiness: Effect.succeed(reason),
                },
              }
            : instance,
        ),
      },
    );
  });

  it.live("renames and switches provider through the home thread, guarded by revision", () =>
    withServer(() =>
      Effect.gen(function* () {
        const service = yield* SquireService.SquireService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const squire = yield* service.create(createInput("create"));
        const renamed = yield* service.update(
          updateInput({
            requestId: "rename",
            squireId: squire.id,
            expectedRevision: squire.revision,
            name: "Shipping",
            providerInstanceId: scriptedB,
            modelSelection: scriptedBModel,
          }),
        );
        assert.equal(renamed.name, "Shipping");
        assert.equal(renamed.providerInstanceId, scriptedB);
        const shell = (yield* projections.getThreadShell(squire.homeThreadId!))!;
        assert.equal(shell.title, "Squire · Shipping");
        assert.deepEqual(shell.modelSelection, scriptedBModel);

        assert.equal(
          yield* codeOf(
            service.update(
              updateInput({ squireId: squire.id, expectedRevision: squire.revision, brief: "x" }),
            ),
          ),
          "revision_conflict",
        );
      }),
    ),
  );

  it.live("pause drops queued event rows and turns held cards into open ones the Lead sees", () =>
    withServer(
      () =>
        Effect.gen(function* () {
          const service = yield* SquireService.SquireService;
          const repository = yield* SquireRepository.SquireRepository;
          const sql = yield* SqlClient.SqlClient;
          const squire = yield* service.create(createInput("create"));
          const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
          const leadRows = sql<{ readonly kind: string; readonly state_key: string }>`
          SELECT kind, state_key FROM squire_event WHERE squire_id = ${lead.id}
            AND kind LIKE 'item-%'`;
          const now = squire.createdAt;
          const event = (stateKey: string, status: "deferred" | "pending") => ({
            squire_id: squire.id,
            thread_id: null,
            kind: "turn-finished",
            state_key: stateKey,
            payload_json: null,
            status,
            defer_reason: status === "deferred" ? ("threshold" as const) : null,
            not_before: now,
            batch_id: null,
            created_at: now,
          });
          yield* repository.insertEvent(event("deferred", "deferred"));
          yield* repository.insertEvent(event("pending", "pending"));
          yield* repository.insertCard({
            id: SquireCardId.make("card-held"),
            squire_id: squire.id,
            owner_squire_id: squire.id,
            kind: "steer",
            status: "held",
            target_thread_id: ThreadId.make("thread-user"),
            project_id: null,
            title: "Rerun",
            why: "CI failed",
            payload_json: "{}",
            evidence_json: "{}",
            trigger_json: "{}",
            intent_json: null,
            origin: "event",
            steer_kind: null,
            routed_task_id: null,
            rule_id: null,
            finding_key: null,
            escalate_at: null,
            opened_at: null,
            executes_at: now,
            attempt: 0,
            command_id: null,
            execution_key: null,
            dedupe_key: null,
            replaced_count: 0,
            ask_json: null,
            resolution: null,
            created_at: now,
            updated_at: now,
          });

          const paused = yield* service.setStatus({
            requestId: "pause",
            squireId: squire.id,
            status: "paused",
          });
          assert.equal(paused.status, "paused");
          // Dropped rows keep their dedupe key, so the same event never re-queues.
          // A pending row goes too: delivered on resume, it would be an event the
          // paused Squire accepted.
          const rows = yield* sql<{ readonly state_key: string; readonly status: string }>`
          SELECT state_key, status FROM squire_event WHERE squire_id = ${squire.id}
          ORDER BY state_key`;
          assert.deepEqual(
            rows.map((row) => [row.state_key, row.status]),
            [
              ["deferred", "dropped"],
              ["pending", "dropped"],
            ],
          );
          const card = Option.getOrThrow(yield* repository.getCard(SquireCardId.make("card-held")));
          assert.equal(card.status, "open");
          assert.isNull(card.executes_at);
          // The new recommendation is a decision item, so the Lead hears of it.
          assert.deepEqual(
            (yield* leadRows).map((row) => [row.kind, row.state_key]),
            [["item-raised", "card-held:raised"]],
          );

          const resumed = yield* service.setStatus({
            requestId: "resume",
            squireId: squire.id,
            status: "active",
          });
          assert.equal(resumed.status, "active");
          yield* service.setStatus({ requestId: "pause-2", squireId: squire.id, status: "paused" });
          assert.lengthOf(yield* leadRows, 1);
        }),
      { defaultModelSelection: scriptedModel },
    ),
  );

  it.live("a retried voice note is one event, and a paused Squire or the Lead takes none", () =>
    withServer(
      () =>
        Effect.gen(function* () {
          const service = yield* SquireService.SquireService;
          const sql = yield* SqlClient.SqlClient;
          const squire = yield* service.create(createInput("create"));
          const note = {
            requestId: "voice-1",
            squireId: squire.id,
            transcript: "Tell Release to rerun CI",
            speakerVerified: false,
            source: "dictation" as const,
          };
          const first = yield* service.voiceNote(note);
          const retried = yield* service.voiceNote(note);
          assert.equal(retried.voiceNoteId, first.voiceNoteId);
          const rows = () =>
            sql<{ readonly state_key: string; readonly payload_json: string }>`
              SELECT state_key, payload_json FROM squire_event
              WHERE squire_id = ${squire.id} AND kind = 'voice-note'`;
          const [row, ...others] = yield* rows();
          assert.lengthOf(others, 0);
          assert.equal(row!.state_key, first.voiceNoteId);
          assert.deepEqual(JSON.parse(row!.payload_json), {
            type: "voice-note",
            voiceNoteId: first.voiceNoteId,
            transcript: "Tell Release to rerun CI",
            speakerVerified: false,
            source: "dictation",
          });

          yield* service.setStatus({ requestId: "pause", squireId: squire.id, status: "paused" });
          // A paused Squire takes no new note, but a retry still gets its id back.
          assert.equal(
            yield* codeOf(service.voiceNote({ ...note, requestId: "voice-2" })),
            "invalid_request",
          );
          assert.equal((yield* service.voiceNote(note)).voiceNoteId, first.voiceNoteId);
          assert.lengthOf(yield* rows(), 1);

          const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
          assert.equal(
            yield* codeOf(service.voiceNote({ ...note, squireId: lead.id })),
            "invalid_request",
          );
        }),
      { defaultModelSelection: scriptedModel },
    ),
  );

  it.live("tracks and untracks threads, never a Squire's, with exclusions under containers", () =>
    withServer(() =>
      Effect.gen(function* () {
        const service = yield* SquireService.SquireService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const userThread = ThreadId.make("thread-user");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("thread-user:create"),
          threadId: userThread,
          projectId: homeProject,
          title: "Fix the build",
          modelSelection: scriptedModel,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const squire = yield* service.create(createInput("one"));
        const other = yield* service.create(createInput("two"));

        const track = (kind: "thread" | "project", targetId: string, requestId: string = kind) =>
          service.track({ requestId, squireId: squire.id, grant: { kind, targetId } });
        assert.equal(yield* codeOf(track("thread", other.homeThreadId!)), "out_of_scope");
        assert.equal(yield* codeOf(track("thread", "thread-missing")), "not_found");

        const tracked = yield* track("thread", userThread);
        assert.deepEqual(
          tracked.grants.map((grant) => [grant.kind, grant.targetId, grant.origin]),
          [["thread", userThread, "granted"]],
        );
        assert.isAbove(tracked.revision, squire.revision);

        // Without a covering container, untracking leaves nothing behind.
        const untracked = yield* service.untrack({
          requestId: "untrack",
          squireId: squire.id,
          grant: { kind: "thread", targetId: userThread },
        });
        assert.lengthOf(untracked.grants, 0);

        yield* track("project", homeProject);
        const excluded = yield* service.untrack({
          requestId: "untrack-covered",
          squireId: squire.id,
          grant: { kind: "thread", targetId: userThread },
        });
        assert.sameDeepMembers(
          excluded.grants.map((grant) => [grant.kind, grant.targetId]),
          [
            ["project", homeProject],
            ["exclusion", userThread],
          ],
        );
        const retracked = yield* track("thread", userThread, "retrack");
        assert.sameDeepMembers(
          retracked.grants.map((grant) => [grant.kind, grant.targetId]),
          [
            ["project", homeProject],
            ["thread", userThread],
          ],
        );
        // Creating with a marked thread in scope is refused too.
        assert.equal(
          yield* codeOf(
            service.create(
              createInput("three", { grants: [{ kind: "thread", targetId: other.homeThreadId! }] }),
            ),
          ),
          "out_of_scope",
        );
      }),
    ),
  );

  it.live("untracking excludes a thread only when a Stave grant covers its project", () =>
    withServer(
      () =>
        Effect.gen(function* () {
          const service = yield* SquireService.SquireService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const userThread = ThreadId.make("thread-user");
          yield* orchestrator.dispatch(userThreadCreate(userThread));
          const squire = yield* service.create(createInput("stave"));
          const grant = (kind: "thread" | "staveSpace", targetId: string, requestId: string) =>
            service.track({ requestId, squireId: squire.id, grant: { kind, targetId } });
          const untrackThread = (requestId: string) =>
            service.untrack({
              requestId,
              squireId: squire.id,
              grant: { kind: "thread", targetId: userThread },
            });

          // A space the home project is not in covers nothing here.
          yield* grant("staveSpace", "space-elsewhere", "elsewhere");
          yield* grant("thread", userThread, "thread-1");
          const uncovered = yield* untrackThread("untrack-1");
          assert.deepEqual(
            uncovered.grants.map((entry) => [entry.kind, entry.targetId]),
            [["staveSpace", "space-elsewhere"]],
          );

          yield* grant("staveSpace", "space-home", "home");
          yield* grant("thread", userThread, "thread-2");
          const covered = yield* untrackThread("untrack-2");
          assert.sameDeepMembers(
            covered.grants.map((entry) => [entry.kind, entry.targetId]),
            [
              ["staveSpace", "space-elsewhere"],
              ["staveSpace", "space-home"],
              ["exclusion", userThread],
            ],
          );
        }),
      {
        staveSpaces: [
          { spaceId: "space-home", projectIds: [homeProject] },
          { spaceId: "space-elsewhere", projectIds: [ProjectId.make("project-elsewhere")] },
        ],
      },
    ),
  );

  it.live(
    "untracking drops the thread's queued events and outdates its cards; delete retires all",
    () =>
      withServer(
        () =>
          Effect.gen(function* () {
            const service = yield* SquireService.SquireService;
            const repository = yield* SquireRepository.SquireRepository;
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const sql = yield* SqlClient.SqlClient;
            const dropped = ThreadId.make("thread-dropped");
            const kept = ThreadId.make("thread-kept");
            yield* orchestrator.dispatch(userThreadCreate(dropped));
            yield* orchestrator.dispatch(userThreadCreate(kept));
            const squire = yield* service.create(
              createInput("scoped", {
                grants: [
                  { kind: "thread", targetId: dropped },
                  { kind: "thread", targetId: kept },
                ],
              }),
            );
            const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
            const now = squire.createdAt;
            for (const threadId of [dropped, kept]) {
              yield* repository.insertEvent({
                squire_id: squire.id,
                thread_id: threadId,
                kind: "turn-finished",
                state_key: `run-${threadId}`,
                payload_json: null,
                status: "pending",
                defer_reason: null,
                not_before: now,
                batch_id: null,
                created_at: now,
              });
              yield* repository.insertCard({
                id: SquireCardId.make(`card-${threadId}`),
                squire_id: squire.id,
                owner_squire_id: squire.id,
                kind: "steer",
                status: "open",
                target_thread_id: threadId,
                project_id: homeProject,
                title: "Rerun",
                why: "CI failed",
                payload_json: "{}",
                evidence_json: "{}",
                trigger_json: "{}",
                intent_json: null,
                origin: "event",
                steer_kind: null,
                routed_task_id: null,
                rule_id: null,
                finding_key: null,
                escalate_at: null,
                opened_at: now,
                executes_at: null,
                attempt: 0,
                command_id: null,
                execution_key: null,
                dedupe_key: null,
                replaced_count: 0,
                ask_json: null,
                resolution: null,
                created_at: now,
                updated_at: now,
              });
            }
            const eventStatus = (threadId: ThreadId) =>
              sql<{ readonly status: string }>`
            SELECT status FROM squire_event WHERE squire_id = ${squire.id} AND thread_id = ${threadId}`.pipe(
                Effect.map((rows) => rows.map((row) => row.status)),
              );
            const cardStatus = (threadId: ThreadId) =>
              repository
                .getCard(SquireCardId.make(`card-${threadId}`))
                .pipe(Effect.map((card) => Option.getOrThrow(card).status));
            const leadResolved = sql<{ readonly state_key: string }>`
          SELECT state_key FROM squire_event WHERE squire_id = ${lead.id} AND kind = 'item-resolved'
          ORDER BY id`.pipe(Effect.map((rows) => rows.map((row) => row.state_key)));

            yield* service.untrack({
              requestId: "untrack",
              squireId: squire.id,
              grant: { kind: "thread", targetId: dropped },
            });
            assert.deepEqual(yield* eventStatus(dropped), ["dropped"]);
            assert.equal(yield* cardStatus(dropped), "outdated");
            assert.deepEqual(yield* eventStatus(kept), ["pending"]);
            assert.equal(yield* cardStatus(kept), "open");
            assert.deepEqual(yield* leadResolved, [`card-${dropped}:resolved`]);

            // A delete takes the rows away; the Lead still hears the open card resolved.
            yield* service.delete({ requestId: "delete", squireId: squire.id });
            assert.deepEqual(yield* leadResolved, [
              `card-${dropped}:resolved`,
              `card-${kept}:resolved`,
            ]);
          }),
        { defaultModelSelection: scriptedModel },
      ),
  );

  it.live("a grant change disables rules that leave scope and restores ones that return", () =>
    withServer(() =>
      Effect.gen(function* () {
        const service = yield* SquireService.SquireService;
        const rules = yield* SquireRules.SquireRules;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const userThread = ThreadId.make("thread-user");
        yield* orchestrator.dispatch(userThreadCreate(userThread));
        const squire = yield* service.create(
          createInput("rules", { grants: [{ kind: "project", targetId: homeProject }] }),
        );
        const projectRule = yield* rules.create({
          requestId: "rule-project",
          squireId: squire.id,
          effect: "allow",
          actionClass: "createThread",
          targetKind: "project",
          targetId: homeProject,
        });
        const statuses = rules
          .list(squire.id)
          .pipe(Effect.map((list) => list.map((rule) => [rule.id, rule.status])));

        const narrowed = yield* service.update(
          updateInput({ squireId: squire.id, expectedRevision: squire.revision, grants: [] }),
        );
        assert.deepEqual(yield* statuses, [[projectRule.id, "disabled"]]);
        yield* service.update(
          updateInput({
            requestId: "update-2",
            squireId: squire.id,
            expectedRevision: narrowed.revision,
            grants: [{ kind: "project", targetId: homeProject }],
          }),
        );
        assert.deepEqual(yield* statuses, [[projectRule.id, "active"]]);

        // Untracking the thread under the project grant excludes it, which
        // takes a thread rule out of scope; tracking it again brings it back.
        const threadRule = yield* rules.create({
          requestId: "rule-thread",
          squireId: squire.id,
          effect: "allow",
          actionClass: "steer",
          steerKind: "rebase",
          targetKind: "thread",
          targetId: userThread,
        });
        yield* service.untrack({
          requestId: "untrack",
          squireId: squire.id,
          grant: { kind: "thread", targetId: userThread },
        });
        assert.sameDeepMembers(yield* statuses, [
          [projectRule.id, "active"],
          [threadRule.id, "disabled"],
        ]);
        yield* service.track({
          requestId: "track",
          squireId: squire.id,
          grant: { kind: "thread", targetId: userThread },
        });
        assert.sameDeepMembers(yield* statuses, [
          [projectRule.id, "active"],
          [threadRule.id, "active"],
        ]);
      }),
    ),
  );
});
