/**
 * Rooms fixture over the real switch-on `layerSquire`: Release grants `billing-service` (`thr_fix_invoice_rounding`),
 * Research grants `web-app` (`thr_currency_formatter`), and the Lead is homed in `billing-service`.
 */
import {
  CommandId,
  MessageId,
  ProjectId,
  SquireCreateInput,
  type SquireId,
  type SquireRole,
  SquireRoomId,
  ThreadId,
} from "@lecturn/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SquireDelivery from "../SquireDelivery.ts";
import * as SquireRepository from "../SquireRepository.ts";
import * as SquireRoomStore from "../SquireRoomStore.ts";
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

const createThread = Effect.fn("createThread")(function* (
  threadId: ThreadId,
  projectId: ProjectId,
  title: string,
) {
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
export const withRoomCast = Effect.fn("withRoomCast")(function* <A, E>(
  body: (cast: RoomCast) => Effect.Effect<A, E, Phase4Services | Scope.Scope>,
  options: RoomCastOptions = {},
) {
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
}, Effect.scoped);

let userTurns = 0;
/**
 * A run the user's own message starts on `who`'s home thread once any run
 * there has ended, so the tool calls that follow bind to it and act as `user`.
 */
export const userTurn = Effect.fn("userTurn")(function* (who: { readonly homeThreadId: ThreadId }) {
  const orchestrator = yield* need(Orchestrator.OrchestratorV2);
  const worker = yield* need(EffectWorker.OrchestrationEffectWorkerV2);
  const projections = yield* need(ProjectionStore.ProjectionStoreV2);
  let afterSequence = 0;
  for (;;) {
    yield* worker.drain();
    const shell = yield* projections.getThreadShell(who.homeThreadId);
    if (shell?.activityRunStatus == null) break;
    const next = yield* orchestrator
      .streamStoredEventsFrom({
        threadId: who.homeThreadId,
        afterSequence,
        eventType: "run.updated",
      })
      .pipe(Stream.runHead);
    afterSequence = Option.getOrThrow(next).sequence;
  }
  const key = `user-turn-${++userTurns}`;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`test:${key}`),
    threadId: who.homeThreadId,
    messageId: MessageId.make(`message:user:${key}`),
    text: "Go ahead.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
});

/**
 * A tool call as `who`, in its home thread's current run; with no run at all
 * the call's origin is `unknown`, so start one with `userTurn` first.
 */
export const callTool = Effect.fn("callTool")(function* (
  who: { readonly squireId: SquireId; readonly homeThreadId: ThreadId },
  role: SquireRole,
  tool: string,
  args: Record<string, unknown>,
) {
  const tools = yield* need(SquireTools.SquireTools);
  return yield* tools.call(
    { squireId: who.squireId, role, threadId: who.homeThreadId },
    tool,
    args,
  );
});

/** Delivers whatever is ready for the Squire and drains the effect worker. */
export const deliver = Effect.fn("deliver")(function* (squireId: SquireId) {
  const delivery = yield* need(SquireDelivery.SquireDelivery);
  yield* delivery.deliverReady(squireId);
  yield* delivery.drain;
  yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
});

const ROUTED_TO_NOBODY = '{"via":{"kind":"rule","rule":"none","match":""},"recipients":[]}';

/**
 * An open room of Release and Research holding one post by `author` at
 * `hop`, seeded straight into the store with every cursor at 0.
 */
export const seedBotPost = Effect.fn("seedBotPost")(function* (
  cast: RoomCast,
  input: { readonly author: SquireId; readonly hop: number; readonly body?: string },
) {
  const repository = yield* need(SquireRepository.SquireRepository);
  const store = yield* need(SquireRoomStore.SquireRoomStore);
  const now = DateTime.formatIso(yield* DateTime.now);
  const roomId = SquireRoomId.make("room:bot-post");
  yield* repository.transaction(
    Effect.gen(function* () {
      yield* store.insertRoom({
        id: roomId,
        topic: "Invoice rounding",
        about_json: "[]",
        status: "open",
        muted: 0,
        bot_messaging: "on",
        idle_ttl_seconds: 86_400,
        creator_kind: "user",
        proposal_event_id: null,
        last_post_at: now,
        closed_reason: null,
        create_request_id: "seed-bot-post",
        revision: 0,
        created_at: now,
        updated_at: now,
      });
      for (const member of [cast.release.squireId, cast.research.squireId]) {
        yield* store.addMember({
          room_id: roomId,
          member_kind: "squire",
          member_id: member,
          read_cursor: 0,
          user_seen_cursor: null,
        });
      }
      yield* store.insertPost({
        message_key: "seed-bot-post",
        room_id: roomId,
        author_kind: "squire",
        author_id: input.author,
        body: input.body ?? "Rerun the checks on Auto, it is safe.",
        reply_to: null,
        refs_json: "[]",
        hop: input.hop,
        routing_json: ROUTED_TO_NOBODY,
        rerouted_from: null,
        created_at: now,
      });
    }),
  );
  return roomId;
});
