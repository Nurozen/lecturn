/**
 * Lead assembly of the real switch-on `layerSquire` (through
 * phase4Harness): the feature layers register their Lead tools into the one
 * registry SquireTools reads, the sweep is visible to the tools, and the
 * Lead RPC seam delegates instead of refusing `not_available`.
 */
import { assert, describe, it } from "@effect/vitest";
import { CommandId, ProjectId, SquireCreateInput, SquireEvent, ThreadId } from "@lecturn/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquireLeadRpc from "./SquireLeadRpc.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireTools from "./SquireTools.ts";
import {
  initRepo,
  scripted,
  scriptedModel,
  seedProject,
  tempRoot,
} from "./testkit/lifecycleHarness.ts";
import { type Phase4Services, phase4Layer } from "./testkit/phase4Harness.ts";

const project = ProjectId.make("billing-service");
const tracked = ThreadId.make("thr_fix_invoice_rounding");
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SquireEvent));
const decodeCreateInput = Schema.decodeSync(SquireCreateInput);

const need = <I, S>(tag: Context.Key<I, S>) =>
  Effect.map(Effect.serviceOption(tag), Option.getOrThrow);

const PHASE7_LEAD_TOOLS = [
  "squire_list_tracked",
  "squire_get_summary",
  "squire_list_items",
  "squire_raise_overlap",
  "squire_propose_squire",
  "squire_pause",
  "squire_resume",
  "squire_rescope",
  "squire_forward_item",
  "squire_recommend_steer",
  "squire_send_steer",
  "squire_route_task",
  "squire_propose_thread",
  "squire_publish_showcase",
  "squire_notify",
  "squire_stay_quiet",
];

/** A Release Squire tracking one thread, and the Lead over it. */
const withLead = <A, E>(
  body: (lead: {
    readonly squireId: SquireRepository.SquireRow["id"];
    readonly homeThreadId: ThreadId;
  }) => Effect.Effect<A, E, Phase4Services | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    return yield* Effect.gen(function* () {
      yield* seedProject(project, initRepo(`${root}/billing-service`));
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${tracked}:create`),
        threadId: tracked,
        projectId: project,
        title: "Fix invoice rounding",
        modelSelection: scriptedModel,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const service = yield* need(SquireService.SquireService);
      yield* service.create(
        decodeCreateInput({
          requestId: "release",
          homeProjectId: project,
          providerInstanceId: scripted,
          modelSelection: scriptedModel,
          name: "Release",
          brief: "",
          grants: [{ kind: "project", targetId: project }],
          events: {},
          permissions: {},
          budgets: {},
        }),
      );
      const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
      return yield* body({ squireId: lead.id, homeThreadId: lead.homeThreadId! });
    }).pipe(Effect.scoped, Effect.provide(phase4Layer(baseDir)), Effect.orDie);
  }).pipe(Effect.scoped);

describe("layerSquire with Phase 7", () => {
  it.effect("lists every Phase 7 Lead tool from the shared registry", () =>
    withLead(() =>
      Effect.gen(function* () {
        const tools = yield* need(SquireTools.SquireTools);
        const listed = tools.definitions("lead").map((definition) => definition.name);
        for (const name of PHASE7_LEAD_TOOLS) assert.include(listed, name);
        assert.notInclude(listed, "squire_get_detail");
      }),
    ),
  );

  it.effect("admits a Lead sweep finding in a sweep turn", () =>
    withLead((lead) =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* repository.insertTriggerEvent({
          squire_id: lead.squireId,
          thread_id: null,
          kind: "sweep-due",
          state_key: "sweep:request-1",
          payload_json: encodeEvent({
            type: "sweep-due",
            sweepKey: "request-1",
            source: "request",
            candidates: [
              {
                threadId: tracked,
                kind: "idle-unmerged-pr",
                pullRequestNumber: 318,
                headSha: "abc123",
              },
            ],
          }),
          status: "pending",
          defer_reason: null,
          not_before: now,
          batch_id: null,
          created_at: now,
        });
        const delivery = yield* need(SquireDelivery.SquireDelivery);
        yield* delivery.deliverReady(lead.squireId);
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();

        const tools = yield* need(SquireTools.SquireTools);
        const result = yield* tools.call(
          { squireId: lead.squireId, role: "lead", threadId: lead.homeThreadId },
          "squire_recommend_steer",
          {
            threadId: tracked,
            reason: "Idle for a day with PR #318 open.",
            steer: "Rebase #318 onto main and rerun its checks.",
          },
        );
        assert.isFalse(result.isError, result.text);
        const [card] = yield* repository.listCards({ squireId: lead.squireId });
        assert.isDefined(card);
        assert.strictEqual(card!.origin, "sweep");
        assert.isNotNull(card!.finding_key);
      }),
    ),
  );

  it.effect("serves Lead open and sweep instead of not_available", () =>
    withLead(() =>
      Effect.gen(function* () {
        const rpc = yield* need(SquireLeadRpc.SquireLeadRpc);
        const opened = yield* Effect.result(rpc.open({ requestId: "open-1" }));
        assert.isTrue(opened._tag === "Success", JSON.stringify(opened));
        const swept = yield* Effect.result(rpc.sweep({ requestId: "sweep-1" }));
        assert.isTrue(swept._tag === "Success", JSON.stringify(swept));
      }),
    ),
  );
});
