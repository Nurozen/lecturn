/**
 * Phase 7b fixture over the real switch-on `layerSquire` (phase4Harness):
 * two projects, one tracked thread each, two Squires and the Lead.
 *
 * - Release: project grant on `billing-service` (covers `thr_fix_invoice_rounding`).
 * - Research: project grant on `web-app` (covers `thr_currency_formatter`).
 * - The Lead, homed in `billing-service`.
 */
import {
  CommandId,
  ProjectId,
  SquireCreateInput,
  type SquireId,
  type SquireRole,
  ThreadId,
} from "@lecturn/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as SquireDelivery from "../SquireDelivery.ts";
import * as SquireService from "../SquireService.ts";
import * as SquireTools from "../SquireTools.ts";
import { initRepo, scripted, scriptedModel, seedProject, tempRoot } from "./lifecycleHarness.ts";
import { type Phase4Options, type Phase4Services, phase4Layer } from "./phase4Harness.ts";

export const billing = ProjectId.make("billing-service");
const webApp = ProjectId.make("web-app");
export const invoiceThread = ThreadId.make("thr_fix_invoice_rounding");
export const currencyThread = ThreadId.make("thr_currency_formatter");

const decodeCreateInput = Schema.decodeSync(SquireCreateInput);

export const need = <I, S>(tag: Context.Key<I, S>) =>
  Effect.map(Effect.serviceOption(tag), Option.getOrThrow);

export interface RoomCast {
  readonly release: { readonly squireId: SquireId; readonly homeThreadId: ThreadId };
  readonly research: { readonly squireId: SquireId; readonly homeThreadId: ThreadId };
  readonly lead: { readonly squireId: SquireId; readonly homeThreadId: ThreadId };
}

const createThread = (threadId: ThreadId, projectId: ProjectId, title: string) =>
  Effect.gen(function* () {
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId,
      title,
      modelSelection: scriptedModel,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

export interface RoomCastOptions extends Phase4Options {
  /** Permissions for both Squires (decoded with the contract defaults). */
  readonly squirePermissions?: Record<string, unknown>;
  /** The Lead's Manage Squires level; recommend by default. */
  readonly leadManageSquires?: "off" | "recommend" | "auto";
}

/** Runs `body` with the cast created, inside the real Squire stack. */
export const withRoomCast = <A, E>(
  body: (cast: RoomCast) => Effect.Effect<A, E, Phase4Services | Scope.Scope>,
  options: RoomCastOptions = {},
) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    return yield* Effect.gen(function* () {
      yield* seedProject(billing, initRepo(`${root}/billing-service`));
      yield* seedProject(webApp, initRepo(`${root}/web-app`));
      yield* createThread(invoiceThread, billing, "Fix invoice rounding");
      yield* createThread(currencyThread, webApp, "Currency formatter");
      const service = yield* need(SquireService.SquireService);
      const make = (requestId: string, name: string, projectId: ProjectId) =>
        service.create(
          decodeCreateInput({
            requestId,
            homeProjectId: billing,
            providerInstanceId: scripted,
            modelSelection: scriptedModel,
            name,
            brief: `${name} brief`,
            grants: [{ kind: "project", targetId: projectId }],
            events: {},
            permissions: options.squirePermissions ?? {},
            budgets: {},
          }),
        );
      const release = yield* make("release", "Release", billing);
      const research = yield* make("research", "Research", webApp);
      const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
      const leadRow = Option.getOrThrow(yield* service.get(lead.id));
      if (options.leadManageSquires !== undefined) {
        yield* service.update({
          requestId: "lead-manage",
          squireId: lead.id,
          expectedRevision: leadRow.revision,
          permissions: { ...leadRow.permissions, manageSquires: options.leadManageSquires },
        });
      }
      return yield* body({
        release: { squireId: release.id, homeThreadId: release.homeThreadId! },
        research: { squireId: research.id, homeThreadId: research.homeThreadId! },
        lead: { squireId: lead.id, homeThreadId: lead.homeThreadId! },
      });
    }).pipe(Effect.scoped, Effect.provide(phase4Layer(baseDir, options)), Effect.orDie);
  }).pipe(Effect.scoped);

/** A tool call as `who`, in its home thread's current run (or a user turn when idle). */
export const callTool = (
  who: { readonly squireId: SquireId; readonly homeThreadId: ThreadId },
  role: SquireRole,
  tool: string,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const tools = yield* need(SquireTools.SquireTools);
    return yield* tools.call(
      { squireId: who.squireId, role, threadId: who.homeThreadId },
      tool,
      args,
    );
  });

/** Delivers whatever is ready for the Squire and drains the effect worker. */
export const deliver = (squireId: SquireId) =>
  Effect.gen(function* () {
    const delivery = yield* need(SquireDelivery.SquireDelivery);
    yield* delivery.deliverReady(squireId);
    yield* delivery.drain;
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  });
