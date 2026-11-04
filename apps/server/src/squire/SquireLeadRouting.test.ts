/**
 * Lead task routing on the switch-on Squire layer over
 * a real orchestrator: forwarding a typed task as an item, `squire_route_task`
 * through delivery into the target's turn, the derived receipts, and the
 * Lead's `squire_propose_thread`.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  SquireCreateInput,
  type SquireId,
  ThreadId,
} from "@lecturn/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import * as SquireLeadReceipts from "./SquireLeadReceipts.ts";
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

const homeProject = ProjectId.make("billing-service");
const otherProject = ProjectId.make("observatory");
const tracked = ThreadId.make("thr_fix_invoice_rounding");
const decodeCreateInput = Schema.decodeSync(SquireCreateInput);

const need = <I, S>(tag: Context.Key<I, S>) =>
  Effect.map(Effect.serviceOption(tag), Option.getOrThrow);

interface Home {
  readonly squireId: SquireId;
  readonly homeThreadId: ThreadId;
  readonly role: "squire" | "lead";
}

interface Team {
  readonly lead: Home;
  readonly release: Home;
  readonly docs: Home;
}

const createThread = (threadId: ThreadId, projectId: ProjectId, title: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
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
    }),
  );

const createSquire = (requestId: string, name: string, projectId: ProjectId) =>
  Effect.flatMap(need(SquireService.SquireService), (service) =>
    service.create(
      decodeCreateInput({
        requestId,
        homeProjectId: projectId,
        providerInstanceId: scripted,
        modelSelection: scriptedModel,
        name,
        brief: "",
        grants: [{ kind: "project", targetId: projectId }],
        events: {},
        permissions: {},
        budgets: {},
      }),
    ),
  );

/** Release tracks `billing-service`, Docs tracks `observatory`, and the Lead oversees both. */
const withTeam = <A, E>(body: (team: Team) => Effect.Effect<A, E, Phase4Services | Scope.Scope>) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    return yield* Effect.gen(function* () {
      yield* seedProject(homeProject, initRepo(`${root}/billing-service`));
      yield* seedProject(otherProject, initRepo(`${root}/observatory`));
      yield* createThread(tracked, homeProject, "Fix invoice rounding");
      const release = yield* createSquire("release", "Release", homeProject);
      const docs = yield* createSquire("docs", "Docs", otherProject);
      const service = yield* need(SquireService.SquireService);
      const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
      const home = (row: typeof release, role: Home["role"]): Home => ({
        squireId: row.id,
        homeThreadId: row.homeThreadId!,
        role,
      });
      return yield* body({
        lead: home(lead, "lead"),
        release: home(release, "squire"),
        docs: home(docs, "squire"),
      });
    }).pipe(Effect.scoped, Effect.provide(phase4Layer(baseDir)), Effect.orDie);
  }).pipe(Effect.scoped);

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

let runCounter = 0;
/**
 * A home-thread run whose message id carries `origin`, as delivery would;
 * `user` has none. It is let end, so the next run is the thread's latest.
 */
const homeRun = (home: Home, origin: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const key = `${origin}-${++runCounter}`;
    const messageId = MessageId.make(
      origin === "user" ? `message:user:${key}` : `message:squire:${origin}:${key}`,
    );
    yield* withSquireDispatchOrigin(
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`test:routing:${key}`),
        threadId: home.homeThreadId,
        messageId,
        text: "Go.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: origin === "user" ? "user" : "agent",
        creationSource: "server",
      }),
    );
    let afterSequence = 0;
    for (;;) {
      yield* worker.drain();
      const projection = yield* orchestrator.getThreadProjection(home.homeThreadId);
      const run = projection.runs.find((entry) => entry.userMessageId === messageId);
      if (run !== undefined && TERMINAL.has(run.status)) return;
      const next = yield* orchestrator
        .streamStoredEventsFrom({
          threadId: home.homeThreadId,
          afterSequence,
          eventType: "run.updated",
        })
        .pipe(Stream.runHead);
      afterSequence = Option.getOrThrow(next).sequence;
    }
  });

const call = (home: Home, name: string, args: unknown) =>
  Effect.flatMap(need(SquireTools.SquireTools), (tools) =>
    tools.call(
      { squireId: home.squireId, role: home.role, threadId: home.homeThreadId },
      name,
      args,
    ),
  );

const structured = (result: SquireTools.SquireToolResult) =>
  result.structuredContent as Record<string, unknown>;

const setPermissions = (
  squireId: SquireId,
  permissions: { steer?: string; createThread?: string; notify?: string },
) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    yield* repository.updateSquire({
      id: squireId,
      patch: {
        permissions_json: JSON.stringify({
          steer: "recommend",
          createThread: "recommend",
          notify: "on",
          ...permissions,
        }),
      },
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

const routedEvents = (squireId: SquireId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository
      .listEventsByStatus({
        squireId,
        statuses: ["deferred", "pending", "batched", "delivered", "dropped"],
      })
      .pipe(Effect.map((rows) => rows.filter((row) => row.kind === "routed-task"))),
  );

const receipts = SquireLeadReceipts.list({});

/** Delivers the target's ready batch and returns the message it dispatched. */
const deliver = (home: Home) =>
  Effect.gen(function* () {
    const delivery = yield* need(SquireDelivery.SquireDelivery);
    yield* delivery.drain;
    yield* delivery.deliverReady(home.squireId);
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
      home.homeThreadId,
    );
    return projection.messages.filter((message) => message.id.startsWith("message:squire:"));
  });

const steerArgs = {
  threadId: tracked,
  reason: "The user asked to rerun the e2e suite.",
  steer: "Rerun api-e2e and report the first failure.",
};

const routeArgs = (team: Team) => ({
  toSquireId: team.release.squireId,
  text: "Check whether the v2.5 release notes mention the rounding fix.",
  reason: "Release owns billing-service.",
});

describe("Lead routing", () => {
  it.effect("a typed steer becomes one item owned by the thread's Squire, with a receipt", () =>
    withTeam((team) =>
      Effect.gen(function* () {
        yield* homeRun(team.lead, "user");
        const result = yield* call(team.lead, "squire_recommend_steer", steerArgs);
        assert.isFalse(result.isError, result.text);
        assert.strictEqual(structured(result).ownerSquireId, team.release.squireId);

        const repository = yield* SquireRepository.SquireRepository;
        const cards = yield* repository.listCards({ targetThreadId: tracked });
        assert.lengthOf(cards, 1);
        assert.strictEqual(cards[0]!.squire_id, team.lead.squireId);
        assert.strictEqual(cards[0]!.owner_squire_id, team.release.squireId);
        // A Lead item never wakes the Lead.
        assert.lengthOf(
          yield* repository.listEventsByStatus({
            squireId: team.lead.squireId,
            statuses: ["pending", "batched", "delivered"],
          }),
          0,
        );

        const { receipts: list } = yield* receipts;
        assert.lengthOf(list, 1);
        assert.strictEqual(list[0]!.toSquireId, team.release.squireId);
        assert.strictEqual(list[0]!.status, "acted");
        assert.deepStrictEqual(list[0]!.items, [
          { cardId: cards[0]!.id, kind: "steer", status: "open" },
        ]);
        // No routed-task event: the Squire's turn is not needed for an item.
        assert.lengthOf(yield* routedEvents(team.release.squireId), 0);
      }),
    ),
  );

  it.effect(
    "a routed task is one event, delivered from the Lead, whose item names it and whose receipt follows it",
    () =>
      withTeam((team) =>
        Effect.gen(function* () {
          yield* homeRun(team.lead, "user");
          const routed = yield* call(team.lead, "squire_route_task", routeArgs(team));
          assert.isFalse(routed.isError, routed.text);
          assert.include(routed.text, "Sent to Release");
          const taskId = structured(routed).taskId as string;
          // A retry of the same call is the stored result, not a second task.
          const again = yield* call(team.lead, "squire_route_task", routeArgs(team));
          assert.deepStrictEqual(again, routed);
          const events = yield* routedEvents(team.release.squireId);
          assert.lengthOf(events, 1);
          assert.strictEqual(events[0]!.state_key, taskId);

          const before = (yield* receipts).receipts;
          assert.deepStrictEqual(
            before.map((receipt) => [receipt.taskId, receipt.status, receipt.items.length]),
            [[taskId, "sent", 0]],
          );

          const messages = yield* deliver(team.release);
          assert.lengthOf(messages, 1);
          assert.strictEqual(messages[0]!.senderThreadId, team.lead.homeThreadId);
          assert.include(messages[0]!.text, "release notes");

          // Release acts in the routed turn: its item records the task.
          const card = yield* call(team.release, "squire_recommend_steer", steerArgs);
          assert.isFalse(card.isError, card.text);
          const repository = yield* SquireRepository.SquireRepository;
          const raised = yield* repository.listCards({ squireId: team.release.squireId });
          assert.lengthOf(raised, 1);
          assert.strictEqual(raised[0]!.routed_task_id, taskId);

          const acted = (yield* receipts).receipts[0]!;
          assert.strictEqual(acted.status, "acted");
          assert.deepStrictEqual(acted.items, [
            { cardId: raised[0]!.id, kind: "steer", status: "open" },
          ]);

          // The receipt follows the item without a Lead turn.
          yield* repository.updateCard({
            id: raised[0]!.id,
            fromStatuses: ["open"],
            patch: { status: "dismissed", resolution: "dismissed" },
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          });
          assert.strictEqual((yield* receipts).receipts[0]!.items[0]!.status, "dismissed");

          // A routed-task turn cannot route further, and a Squire never routes.
          const further = yield* call(team.release, "squire_route_task", {
            ...routeArgs(team),
            toSquireId: team.docs.squireId,
          });
          assert.isTrue(further.isError);
          assert.lengthOf(yield* routedEvents(team.docs.squireId), 0);
        }),
      ),
  );

  it.effect("a quiet routed turn reads as no action, with its reason", () =>
    withTeam((team) =>
      Effect.gen(function* () {
        yield* homeRun(team.lead, "user");
        const routed = yield* call(team.lead, "squire_route_task", routeArgs(team));
        yield* deliver(team.release);
        const quiet = yield* call(team.release, "squire_stay_quiet", {
          reason: "The notes already cover it.",
        });
        assert.isFalse(quiet.isError);
        const [receipt] = (yield* receipts).receipts;
        assert.strictEqual(receipt!.taskId, structured(routed).taskId);
        assert.strictEqual(receipt!.status, "quiet");
        assert.strictEqual(receipt!.quietReason, "The notes already cover it.");
        assert.lengthOf(receipt!.items, 0);
      }),
    ),
  );

  it.effect(
    "route_task is refused outside a user turn, from a Squire, and toward a paused Squire",
    () =>
      withTeam((team) =>
        Effect.gen(function* () {
          yield* homeRun(team.lead, "event");
          const fromEvent = yield* call(team.lead, "squire_route_task", routeArgs(team));
          assert.isTrue(fromEvent.isError);
          assert.include(fromEvent.text, "turn the user's message started");

          yield* homeRun(team.release, "event");
          const fromSquire = yield* call(team.release, "squire_route_task", routeArgs(team));
          assert.isTrue(fromSquire.isError);
          assert.include(fromSquire.text, "not a tool a Squire can use");

          yield* homeRun(team.lead, "user");
          const service = yield* need(SquireService.SquireService);
          yield* service.setStatus({
            requestId: "pause-docs",
            squireId: team.docs.squireId,
            status: "paused",
          });
          const toPaused = yield* call(team.lead, "squire_route_task", {
            ...routeArgs(team),
            toSquireId: team.docs.squireId,
          });
          assert.isTrue(toPaused.isError);
          assert.include(toPaused.text, "Docs is paused");
          assert.deepStrictEqual(structured(toPaused), { outcome: "refused", reason: "paused" });

          for (const home of [team.release, team.docs]) {
            assert.lengthOf(yield* routedEvents(home.squireId), 0);
          }
          assert.lengthOf((yield* receipts).receipts, 0);
        }),
      ),
  );

  it.effect("the Lead's propose_thread is always a proposal owned by the named Squire", () =>
    withTeam((team) =>
      Effect.gen(function* () {
        yield* setPermissions(team.lead.squireId, { createThread: "auto" });
        yield* setPermissions(team.release.squireId, { createThread: "auto" });
        yield* homeRun(team.lead, "user");
        const proposal = {
          provider: "claudeAgent",
          firstPrompt: "Add a CHANGELOG entry for the rounding fix.",
          reason: "The user asked for it.",
          squireId: team.release.squireId,
        };
        const made = yield* call(team.lead, "squire_propose_thread", {
          ...proposal,
          project: "billing-service",
        });
        assert.isFalse(made.isError, made.text);
        const repository = yield* SquireRepository.SquireRepository;
        const cards = yield* repository.listCards({ squireId: team.lead.squireId });
        assert.lengthOf(cards, 1);
        assert.strictEqual(cards[0]!.kind, "proposal");
        assert.strictEqual(cards[0]!.status, "open");
        assert.isNull(cards[0]!.intent_json);
        assert.strictEqual(cards[0]!.owner_squire_id, team.release.squireId);

        // Outside the named Squire's grants.
        const outside = yield* call(team.lead, "squire_propose_thread", {
          ...proposal,
          project: "observatory",
        });
        assert.isTrue(outside.isError);
        assert.include(outside.text, "not in Release's scope");

        // Off when either the Lead's or the owner's Create thread is Off.
        yield* setPermissions(team.release.squireId, { createThread: "off" });
        const ownerOff = yield* call(team.lead, "squire_propose_thread", {
          ...proposal,
          project: "billing-service",
          firstPrompt: "Tag the release.",
        });
        assert.isTrue(ownerOff.isError);
        assert.include(ownerOff.text, "Create thread is Off for Release");

        yield* setPermissions(team.release.squireId, { createThread: "recommend" });
        yield* setPermissions(team.lead.squireId, { createThread: "off" });
        const leadOff = yield* call(team.lead, "squire_propose_thread", {
          ...proposal,
          project: "billing-service",
          firstPrompt: "Bump the version.",
        });
        assert.isTrue(leadOff.isError);
        assert.include(leadOff.text, "Create thread is Off");
        assert.lengthOf(yield* repository.listCards({ squireId: team.lead.squireId }), 1);
      }),
    ),
  );
});
