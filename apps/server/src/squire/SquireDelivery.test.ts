import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  RunId,
  SQUIRE_CARD_OUTCOME_MAX_CHARS,
  SquireCardPayload,
  SquireCreateInput,
  SquireEvent,
  SquireId,
  type SquireParticipant,
  SquireRoomId,
  SquireRuleId,
  SquireTriggerId,
  SquireTurnSummary,
  SquireVoiceNoteId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
} from "@lecturn/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as LecturnOrchestrationHooks from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { STAVE_ADMISSION_WAIT } from "../stave/StaveOrchestrationHooks.ts";
import * as StaveSpaceLock from "../stave/StaveSpaceLock.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import { squireCardRowFields, squireFyiOutcome } from "./SquireItems.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRoomStore from "./SquireRoomStore.ts";
import * as SquireService from "./SquireService.ts";
import { SquireRunSource, layer as summariesLayer } from "./SquireSummaries.ts";
import { SquireEventPayloadJson } from "./squireEvents.ts";
import {
  ROOM_CONTEXT_LOG_KEY,
  advanceRoomCursors,
  collectRoomContext,
  encodeRoomContextWindows,
} from "./squireRoomContext.ts";
import { callTool, deliver, invoiceThread, need, withRoomCast } from "./testkit/roomHarness.ts";
import {
  initRepo,
  scripted,
  scriptedModel,
  seedProject,
  serverLayer,
  tempRoot,
} from "./testkit/lifecycleHarness.ts";
import { type Phase4Options, type Phase4Services, phase4Layer } from "./testkit/phase4Harness.ts";

const homeProject = ProjectId.make("project-home");
const tracked = ThreadId.make("thread-tracked");
const other = ThreadId.make("thread-other");
const NOW = "2026-11-01T10:00:00.000Z";

const encodeSummary = Schema.encodeSync(Schema.fromJsonString(SquireTurnSummary));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SquireEvent));
const decodeCreateInput = Schema.decodeSync(SquireCreateInput);
const decodeSummary = Schema.decodeSync(SquireTurnSummary);
const encodePayload = Schema.encodeSync(SquireEventPayloadJson);
const decodeCardPayload = Schema.decodeUnknownSync(Schema.fromJsonString(SquireCardPayload));

const testLayer = (baseDir: string) => {
  const server = serverLayer(baseDir, { defaultModelSelection: scriptedModel });
  // Delivery only reads stored summaries; it never generates one.
  const summaries = summariesLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(SquireRunSource)({}),
        Layer.mock(TextGeneration)({}),
        ServerSettings.layerTest(),
      ),
    ),
    Layer.provide(server),
  );
  return SquireDelivery.layer.pipe(
    Layer.provideMerge(summaries),
    Layer.provideMerge(SquireRoomStore.layer),
    Layer.provideMerge(server),
  );
};

const createInput = (
  requestId: string,
  name: string,
  grants: (typeof SquireCreateInput.Encoded)["grants"] = [],
) =>
  decodeCreateInput({
    requestId,
    homeProjectId: homeProject,
    providerInstanceId: scripted,
    modelSelection: scriptedModel,
    name,
    brief: `${name} brief: done means CI green.`,
    grants,
    events: {},
    permissions: {},
    budgets: {},
  });

const createThread = (threadId: ThreadId, title: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: homeProject,
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

type HomeServices = Layer.Success<ReturnType<typeof testLayer>>;
/** Runs `effect` on a fresh server over the home: a restart when one already ran. */
const onServer =
  (baseDir: string) =>
  <B, E2>(effect: Effect.Effect<B, E2, HomeServices>) =>
    Effect.provide(effect, testLayer(baseDir));

/** A fresh Lecturn home with a Release Squire tracking a project and excluding one thread. */
const withHome = <A, E>(
  body: (home: {
    readonly squireId: SquireId;
    readonly homeThreadId: ThreadId;
    readonly restart: ReturnType<typeof onServer>;
  }) => Effect.Effect<A, E, HomeServices>,
) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    const restart = onServer(baseDir);
    const squire = yield* restart(
      Effect.gen(function* () {
        yield* seedProject(homeProject, initRepo(`${root}/home-project`));
        yield* createThread(tracked, "Fix invoice rounding");
        yield* createThread(other, "Add EUR invoices");
        const service = yield* SquireService.SquireService;
        return yield* service.create(
          createInput("release", "Release", [
            { kind: "project", targetId: homeProject },
            { kind: "exclusion", targetId: other },
          ]),
        );
      }),
    );
    return yield* restart(
      body({ squireId: squire.id, homeThreadId: squire.homeThreadId!, restart }),
    );
  }).pipe(Effect.scoped);

const summaryOf = (threadId: ThreadId, runId: string, goal: string) =>
  decodeSummary({
    threadId,
    threadTitle: threadId === tracked ? "Fix invoice rounding" : "Add EUR invoices",
    project: "project-home",
    provider: "claudeAgent",
    turnId: RunId.make(runId),
    outcome: "finished",
    summaryStatus: "complete",
    goal,
    completed: [],
    remaining: [],
    blocked: [],
    pendingQuestion: null,
    suggestedNextStep: null,
    files: { entries: [], counts: { added: 0, modified: 0, deleted: 0 } },
    commands: [],
    pullRequest: null,
  });

const storeSummary = (
  threadId: ThreadId,
  runId: string,
  status: "complete" | "generating",
  goal = `Goal of ${runId}`,
) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository.insertSummary({
      thread_id: threadId,
      run_id: RunId.make(runId),
      stage: "terminal",
      status,
      summary_json: encodeSummary({
        ...summaryOf(threadId, runId, status === "complete" ? goal : ""),
        summaryStatus: status === "complete" ? "complete" : "partial",
      }),
      payer_squire_id: null,
      created_at: NOW,
      updated_at: NOW,
    }),
  );

let keyCounter = 0;
const insert = (row: Partial<SquireRepository.SquireEventRow> & { readonly kind: string }) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const full: Omit<SquireRepository.SquireEventRow, "id"> = {
      squire_id: SquireId.make("unset"),
      thread_id: null,
      state_key: `${row.kind}:${++keyCounter}`,
      payload_json: null,
      status: "pending",
      defer_reason: null,
      not_before: NOW,
      batch_id: null,
      created_at: NOW,
      ...row,
    };
    assert.isTrue(yield* repository.insertEvent(full));
  });

const turnFinished = (squireId: SquireId, threadId: ThreadId, runId: string) =>
  insert({
    squire_id: squireId,
    kind: "turn-finished",
    thread_id: threadId,
    state_key: runId,
    payload_json: encodePayload({
      outcome: "finished",
      runId: RunId.make(runId),
      pendingRequest: null,
      pullRequest: null,
    }),
  });

const threadless = (
  squireId: SquireId,
  event: SquireEvent & { readonly type: string },
  key: string,
) =>
  insert({
    squire_id: squireId,
    kind: event.type,
    state_key: key,
    payload_json: encodeEvent(event),
  });

const webhook = (squireId: SquireId, key: string) =>
  threadless(
    squireId,
    {
      type: "webhook-received",
      triggerId: SquireTriggerId.make("trigger-1"),
      deliveryId: key,
      instruction: "Look at the failing run",
      payloadExcerpt: '{"action":"completed"}',
    },
    key,
  );

const squireMessages = (homeThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(homeThreadId);
    return projection.messages.filter((message) => message.id.startsWith("message:squire:"));
  });

const statuses = (squireId: SquireId) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const rows = yield* repository.listEventsByStatus({
      squireId,
      statuses: ["pending", "batched", "delivered", "dropped"],
    });
    return rows.map((row) => `${row.kind}:${row.status}`);
  });

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

/** Lets the home-thread run the batch started end, then finalizes it as the reactor would. */
const finishRun = (
  squireId: SquireId,
  homeThreadId: ThreadId,
  message: OrchestrationV2ConversationMessage,
  options: { readonly report?: boolean } = {},
) =>
  Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const delivery = yield* SquireDelivery.SquireDelivery;
    const runOf = Effect.map(orchestrator.getThreadProjection(homeThreadId), (projection) =>
      projection.runs.find((entry) => entry.userMessageId === message.id),
    );
    let afterSequence = 0;
    // The scripted turn has no script for an event message, so the run fails: still a run end.
    for (;;) {
      yield* worker.drain();
      const run = yield* runOf;
      assert.isDefined(run);
      if (TERMINAL.has(run!.status)) break;
      const next = yield* orchestrator
        .streamStoredEventsFrom({ threadId: homeThreadId, afterSequence, eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (stored) => stored.event.type === "run.updated" && stored.event.payload.id === run!.id,
          ),
          Stream.runHead,
        );
      afterSequence = Option.getOrThrow(next).sequence;
    }
    const run = (yield* runOf)!;
    if (options.report === false) return run;
    yield* delivery.finalizeRun({ squireId, homeThreadId, runId: run.id, status: run.status });
    yield* delivery.drain;
    return run;
  });

const originOf = (message: OrchestrationV2ConversationMessage) =>
  Option.getOrThrow(SquireDelivery.parseSquireMessageId(message.id)).origin;

const ROOM = SquireRoomId.make("room-release");

/** An open room with the user and `members` as Squires, all cursors at 0. */
const seedRoom = (members: ReadonlyArray<SquireId>, room = ROOM, topic = "v2.5 release") =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const rooms = yield* SquireRoomStore.SquireRoomStore;
    yield* repository.transaction(
      Effect.gen(function* () {
        yield* rooms.insertRoom({
          id: room,
          topic,
          about_json: "[]",
          status: "open",
          muted: 0,
          bot_messaging: "on",
          idle_ttl_seconds: 86_400,
          creator_kind: "user",
          proposal_event_id: null,
          last_post_at: NOW,
          closed_reason: null,
          create_request_id: null,
          revision: 0,
          created_at: NOW,
          updated_at: NOW,
        });
        const member = (member_kind: "squire" | "user", member_id: string) =>
          rooms.addMember({
            room_id: room,
            member_kind,
            member_id,
            read_cursor: 0,
            user_seen_cursor: null,
          });
        yield* member("user", SquireRoomStore.USER_MEMBER_ID);
        for (const id of members) yield* member("squire", id);
      }),
    );
  });

let postCounter = 0;
const roomPost = (
  author: { readonly kind: "user" } | { readonly kind: "squire"; readonly id: SquireId },
  body: string,
  room = ROOM,
) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const rooms = yield* SquireRoomStore.SquireRoomStore;
    const id = yield* repository.transaction(
      rooms.insertPost({
        message_key: `post-${++postCounter}`,
        room_id: room,
        author_kind: author.kind,
        author_id: author.kind === "user" ? null : author.id,
        body,
        reply_to: null,
        refs_json: "[]",
        hop: 0,
        routing_json: '{"via":{"kind":"rule","rule":"none","match":""},"recipients":[]}',
        rerouted_from: null,
        created_at: NOW,
      }),
    );
    return Option.getOrThrow(id);
  });

const cursorOf = (squireId: SquireId, room = ROOM) =>
  Effect.gen(function* () {
    const rooms = yield* SquireRoomStore.SquireRoomStore;
    const members = yield* rooms.listMembers(room);
    return members.find((row) => row.member_kind === "squire" && row.member_id === squireId)
      ?.read_cursor;
  });

/** Crash between the batch transaction (as deliverNext writes it) and the dispatch. */
const batchWithoutDispatch = (squireId: SquireId) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const rooms = yield* SquireRoomStore.SquireRoomStore;
    const rows = yield* repository.listEventsByStatus({ squireId, statuses: ["pending"] });
    const batchId = SquireDelivery.batchIdFor({ id: squireId, home_generation: 1 }, rows);
    const blocks = yield* collectRoomContext(
      { repository, rooms },
      { squire: { id: squireId, role: "squire" }, batch: rows },
    );
    yield* repository.transaction(
      Effect.gen(function* () {
        yield* repository.markEventsBatched({ ids: rows.map((row) => row.id), batchId });
        yield* advanceRoomCursors(rooms, { squireId, role: "squire", blocks });
        yield* repository.insertActionLog({
          squire_id: squireId,
          kind: "event.received",
          room_id: null,
          post_id: null,
          trigger_id: null,
          task_id: null,
          thread_id: tracked,
          card_id: null,
          event_id: rows[0]!.id,
          run_id: null,
          invocation_key: null,
          execution_key: null,
          data_json: JSON.stringify({
            batchId,
            kind: "turn-finished",
            [ROOM_CONTEXT_LOG_KEY]: encodeRoomContextWindows(blocks),
          }),
          created_at: NOW,
        });
      }),
    );
  });

describe("SquireDelivery", () => {
  it.live("coalesces ready rows into one notification turn that passes the allowlist", () =>
    withHome(({ squireId, homeThreadId }) =>
      Effect.gen(function* () {
        const delivery = yield* SquireDelivery.SquireDelivery;
        yield* storeSummary(tracked, "run-1", "complete", "First goal");
        yield* storeSummary(tracked, "run-2", "complete", "Second goal");
        yield* storeSummary(other, "run-3", "complete", "Other goal");
        yield* turnFinished(squireId, tracked, "run-1");
        yield* turnFinished(squireId, other, "run-3");
        yield* turnFinished(squireId, tracked, "run-2");

        yield* delivery.deliverReady(squireId);
        const [message, ...rest] = yield* squireMessages(homeThreadId);
        assert.lengthOf(rest, 0);
        assert.equal(originOf(message!), "event");
        assert.equal(message!.createdBy, "agent");
        assert.deepEqual(message!.notification?.source, {
          kind: "squire",
          squireId,
          eventCount: 3,
          eventKinds: ["turn-finished", "turn-finished", "turn-finished"],
        });
        const text = message!.text;
        assert.include(text, "1. turn-finished (2 events on this thread, latest shown)");
        assert.include(text, "Goal: Second goal");
        assert.notInclude(text, "First goal");
        assert.include(text, "Goal: Other goal");
        assert.include(text, "Brief: Release brief: done means CI green.");
        assert.include(text, "Tracking: project project-home");
        assert.include(text, 'Excluded: thread "Add EUR invoices"');
        assert.deepEqual(yield* statuses(squireId), [
          "turn-finished:batched",
          "turn-finished:batched",
          "turn-finished:batched",
        ]);

        // The same command outside SquireDispatchOrigin is refused on the home thread.
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const refused = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("server:squire:deliver:forged"),
            threadId: homeThreadId,
            messageId: MessageId.make("message:squire:event:forged"),
            text: "forged",
            attachments: [],
            notification: message!.notification!,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
          })
          .pipe(Effect.flip);
        assert.isDefined(refused);
      }),
    ),
  );

  it.live("delivers a voice note, a webhook, and a Test now run each alone", () =>
    withHome(({ squireId, homeThreadId }) =>
      Effect.gen(function* () {
        const delivery = yield* SquireDelivery.SquireDelivery;
        yield* turnFinished(squireId, tracked, "run-1");
        yield* threadless(
          squireId,
          {
            type: "voice-note",
            voiceNoteId: SquireVoiceNoteId.make("voice-1"),
            transcript: "Tell billing to rebase",
            speakerVerified: true,
            source: "dictation",
          },
          "voice-1",
        );
        yield* webhook(squireId, "delivery-1");
        yield* webhook(squireId, "test:request-1");
        yield* turnFinished(squireId, other, "run-3");

        const origins: Array<string> = [];
        const counts: Array<number> = [];
        for (let turn = 0; turn < 5; turn++) {
          yield* delivery.deliverReady(squireId);
          const messages = yield* squireMessages(homeThreadId);
          if (messages.length === origins.length) break;
          const latest = messages.at(-1)!;
          origins.push(originOf(latest));
          counts.push(
            latest.notification?.source.kind === "squire"
              ? latest.notification.source.eventCount
              : -1,
          );
          yield* finishRun(squireId, homeThreadId, latest);
        }
        assert.deepEqual(origins, ["event", "voice", "webhook", "test"]);
        assert.deepEqual(counts, [2, 1, 1, 1]);
        const webhookText = (yield* squireMessages(homeThreadId))[2]!.text;
        assert.include(webhookText, "Untrusted outside data");
        assert.notInclude(webhookText, "turn-finished");
      }),
    ),
  );

  it.live("splits a message and a turn-finished into two turns, linking the one sender", () =>
    withHome(({ squireId, homeThreadId }) =>
      Effect.gen(function* () {
        const service = yield* SquireService.SquireService;
        const delivery = yield* SquireDelivery.SquireDelivery;
        const docs = yield* service.create(createInput("docs", "Docs"));
        yield* threadless(
          squireId,
          {
            type: "message",
            messageKey: "mk-1",
            from: { kind: "squire", squireId: docs.id },
            hop: 1,
            body: "Docs for v2.5 are merged.",
          },
          "mk-1",
        );
        yield* turnFinished(squireId, tracked, "run-1");

        yield* delivery.deliverReady(squireId);
        const [first] = yield* squireMessages(homeThreadId);
        assert.equal(originOf(first!), "message");
        assert.equal(first!.senderThreadId, docs.homeThreadId);
        assert.include(
          first!.text,
          "Message from Squire Docs · hop 1 · key mk-1:\nDocs for v2.5 are merged.",
        );
        assert.equal(first!.notification?.summary, "Docs → Release: Docs for v2.5 are merged.");
        assert.notInclude(first!.text, "turn-finished");
        // The run that consumed the first batch is still active: nothing more yet.
        yield* delivery.deliverReady(squireId);
        assert.lengthOf(yield* squireMessages(homeThreadId), 1);

        yield* finishRun(squireId, homeThreadId, first!);
        const [, second, ...rest] = yield* squireMessages(homeThreadId);
        assert.lengthOf(rest, 0);
        assert.equal(originOf(second!), "event");
        assert.isUndefined(second!.senderThreadId);
        assert.deepEqual(yield* statuses(squireId), ["message:delivered", "turn-finished:batched"]);
      }),
    ),
  );

  it.live("re-dispatches a batch after a restart under the same command id, once", () =>
    withHome(({ squireId, homeThreadId, restart }) =>
      Effect.gen(function* () {
        // Crash between the batch transaction and the dispatch.
        const batchId = yield* Effect.gen(function* () {
          const repository = yield* SquireRepository.SquireRepository;
          yield* turnFinished(squireId, tracked, "run-1");
          const rows = yield* repository.listEventsByStatus({ squireId, statuses: ["pending"] });
          const batchId = SquireDelivery.batchIdFor({ id: squireId, home_generation: 1 }, rows);
          yield* repository.markEventsBatched({ ids: rows.map((row) => row.id), batchId });
          return batchId;
        });
        for (let start = 0; start < 2; start++) {
          yield* restart(
            Effect.flatMap(SquireDelivery.SquireDelivery, (delivery) => delivery.redispatchBatched),
          );
        }
        const messages = yield* restart(squireMessages(homeThreadId));
        assert.lengthOf(messages, 1);
        assert.equal(messages[0]!.id, SquireDelivery.deliverMessageId("event", batchId));
        // A batch in flight holds back the next one across restarts too.
        yield* restart(
          Effect.gen(function* () {
            yield* turnFinished(squireId, other, "run-3");
            yield* (yield* SquireDelivery.SquireDelivery).deliverReady(squireId);
            assert.lengthOf(yield* squireMessages(homeThreadId), 1);
          }),
        );
      }),
    ),
  );

  it.live("drops a batch the orchestrator refused and delivers the next one", () =>
    withHome(({ squireId, homeThreadId }) =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const delivery = yield* SquireDelivery.SquireDelivery;
        yield* webhook(squireId, "delivery-1");
        yield* turnFinished(squireId, tracked, "run-1");
        const [first] = yield* repository.listEventsByStatus({ squireId, statuses: ["pending"] });
        const batchId = SquireDelivery.batchIdFor({ id: squireId, home_generation: 1 }, [first!]);
        // The command id already carries a rejected receipt: a create of an existing thread.
        yield* orchestrator
          .dispatch({
            type: "thread.create",
            commandId: SquireDelivery.deliverCommandId(batchId),
            threadId: tracked,
            projectId: homeProject,
            title: "again",
            modelSelection: scriptedModel,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip);

        yield* delivery.deliverReady(squireId);
        const messages = yield* squireMessages(homeThreadId);
        assert.deepEqual(messages.map(originOf), ["event"]);
        assert.deepEqual(yield* statuses(squireId), [
          "webhook-received:dropped",
          "turn-finished:batched",
        ]);
        const [logged] = yield* repository.listActionLog({
          squireId,
          kinds: ["notification.delivery"],
          limit: 10,
        });
        assert.include(logged!.data_json, '"outcome":"rejected"');
        assert.include(logged!.data_json, batchId);
        // A later wake does not try the refused batch again.
        yield* delivery.deliverReady(squireId);
        assert.lengthOf(yield* squireMessages(homeThreadId), 1);
      }),
    ),
  );

  it.live("delivers rows left pending by a restart exactly once", () =>
    withHome(({ squireId, homeThreadId, restart }) =>
      Effect.gen(function* () {
        yield* turnFinished(squireId, tracked, "run-1");
        for (let start = 0; start < 2; start++) {
          yield* restart(
            Effect.gen(function* () {
              const delivery = yield* SquireDelivery.SquireDelivery;
              yield* delivery.redispatchBatched;
              yield* delivery.wake(squireId);
              yield* delivery.drain;
            }),
          );
        }
        assert.lengthOf(yield* restart(squireMessages(homeThreadId)), 1);
      }),
    ),
  );

  it.live("finalizes a batch whose run end was never reported before delivering the next", () =>
    withHome(({ squireId, homeThreadId }) =>
      Effect.gen(function* () {
        const delivery = yield* SquireDelivery.SquireDelivery;
        yield* storeSummary(tracked, "run-1", "complete");
        yield* turnFinished(squireId, tracked, "run-1");
        yield* delivery.deliverReady(squireId);
        const [first] = yield* squireMessages(homeThreadId);
        yield* turnFinished(squireId, other, "run-3");
        // The run ends; no finalizeRun arrives.
        yield* finishRun(squireId, homeThreadId, first!, { report: false });
        yield* delivery.deliverReady(squireId);
        assert.lengthOf(yield* squireMessages(homeThreadId), 2);
        assert.deepEqual(yield* statuses(squireId), [
          "turn-finished:delivered",
          "turn-finished:batched",
        ]);
        const repository = yield* SquireRepository.SquireRepository;
        assert.lengthOf(yield* repository.listCards({ squireId, kinds: ["fyi"] }), 1);
      }),
    ),
  );

  it.live("renders an unsettled summary as partial", () =>
    withHome(({ squireId, homeThreadId }) =>
      Effect.gen(function* () {
        const delivery = yield* SquireDelivery.SquireDelivery;
        yield* storeSummary(tracked, "run-1", "generating");
        yield* turnFinished(squireId, tracked, "run-1");
        yield* turnFinished(squireId, other, "run-9");
        yield* delivery.deliverReady(squireId);
        const text = (yield* squireMessages(homeThreadId))[0]!.text;
        assert.include(
          text,
          "Fix invoice rounding · project-home · claudeAgent · finished · partial summary",
        );
        // No stored summary at all still delivers its deterministic header.
        assert.include(text, "Add EUR invoices · project-home · finished · partial summary");
      }),
    ),
  );

  it.live("quotes the event's evidence, bounded, so a steer can cite the failing assertion", () =>
    withHome(({ squireId, homeThreadId }) =>
      Effect.gen(function* () {
        const delivery = yield* SquireDelivery.SquireDelivery;
        yield* storeSummary(tracked, "run-1", "complete", "Fix rounding");
        const long = `AssertionError: expected ${"9".repeat(400)} to equal 0.1`;
        yield* insert({
          squire_id: squireId,
          kind: "turn-finished",
          thread_id: tracked,
          state_key: "run-1",
          payload_json: encodePayload({
            outcome: "error",
            runId: RunId.make("run-1"),
            pendingRequest: null,
            pullRequest: null,
            evidence: {
              errorLines: ["FAIL invoice.test.ts > rounds half up", long, "", "at a", "at b"],
              headBranch: "fix/rounding",
              diffStats: { insertions: 12, deletions: 3, files: 1 },
            },
          }),
        });
        // A thread with no stored summary quotes its evidence under the partial header.
        yield* insert({
          squire_id: squireId,
          kind: "turn-finished",
          thread_id: other,
          state_key: "run-9",
          payload_json: encodePayload({
            outcome: "error",
            runId: RunId.make("run-9"),
            pendingRequest: null,
            pullRequest: null,
            evidence: { errorLines: ["Expected 2 invoices, got 1"] },
          }),
        });
        yield* delivery.deliverReady(squireId);
        const text = (yield* squireMessages(homeThreadId))[0]!.text;
        assert.include(
          text,
          "Branch: fix/rounding\nDiff: +12 -3 in 1 file\nError output:\n  FAIL invoice.test.ts > rounds half up\n",
        );
        const quoted = text.split("\n").find((line) => line.startsWith("  AssertionError"))!;
        assert.isAtMost(quoted.length, 202);
        assert.isTrue(quoted.endsWith("…"));
        // A blank log line is skipped rather than quoted as an empty line.
        assert.include(text, `…\n  at a\n  at b`);
        assert.include(text, "Error output:\n  Expected 2 invoices, got 1");
      }),
    ),
  );

  it.live("names each thread's latest failing check in a voice note that names none", () =>
    withHome(({ squireId, homeThreadId }) =>
      Effect.gen(function* () {
        const delivery = yield* SquireDelivery.SquireDelivery;
        const failed = (threadId: ThreadId, key: string, job: string, errorLines: Array<string>) =>
          insert({
            squire_id: squireId,
            kind: "turn-finished",
            thread_id: threadId,
            state_key: key,
            status: "delivered",
            payload_json: encodePayload({
              outcome: "error",
              runId: RunId.make(key),
              pendingRequest: null,
              pullRequest: null,
              evidence: {
                errorLines,
                ciLog: {
                  status: "log",
                  headSha: "abc1234",
                  jobs: [{ name: job, url: null }],
                  truncated: false,
                },
              },
            }),
          });
        yield* failed(tracked, "run-1", "api-e2e", ["", "FAIL invoice.test.ts > rounds half up"]);
        yield* failed(other, "run-2", "lint", ["src/a.ts: unused import"]);
        // The other thread's checks passed later, so its old failure is not current.
        yield* insert({
          squire_id: squireId,
          kind: "pull-request-changed",
          thread_id: other,
          state_key: "pr-2",
          status: "delivered",
          payload_json: encodePayload({
            outcome: null,
            runId: null,
            pendingRequest: null,
            pullRequest: {
              host: "github.com",
              repository: "acme/billing",
              number: 7,
              url: "https://github.com/acme/billing/pull/7",
              headSha: "def5678",
              transition: "checks:passing",
              state: "open",
              title: "EUR invoices",
              headBranch: "eur",
              baseBranch: "main",
              checksState: "passing",
              reviewDecision: null,
              mergeability: null,
              threadSelfWatching: false,
            },
          }),
        });
        const voice = (key: string, transcript: string) =>
          threadless(
            squireId,
            {
              type: "voice-note",
              voiceNoteId: SquireVoiceNoteId.make(key),
              transcript,
              speakerVerified: true,
              source: "dictation",
            },
            key,
          );

        yield* voice("voice-1", "Tell the billing thread to rerun the suite and ping me.");
        yield* delivery.deliverReady(squireId);
        const first = (yield* squireMessages(homeThreadId)).at(-1)!;
        assert.include(
          first.text,
          `- "Fix invoice rounding" (${tracked}): api-e2e · FAIL invoice.test.ts > rounds half up`,
        );
        assert.notInclude(first.text, "lint");
        yield* finishRun(squireId, homeThreadId, first);

        // A note that names the job already gets nothing added.
        yield* voice("voice-2", "Tell billing to fix api-e2e.");
        yield* delivery.deliverReady(squireId);
        const second = (yield* squireMessages(homeThreadId)).at(-1)!;
        assert.notStrictEqual(second.id, first.id);
        assert.notInclude(second.text, "Latest failing check");
      }),
    ),
  );

  it.live("writes one FYI per delivered summary event, and none on a repeated finalize", () =>
    withHome(({ squireId, homeThreadId }) =>
      Effect.gen(function* () {
        const delivery = yield* SquireDelivery.SquireDelivery;
        const repository = yield* SquireRepository.SquireRepository;
        yield* storeSummary(tracked, "run-1", "complete");
        yield* turnFinished(squireId, tracked, "run-1");
        yield* delivery.deliverReady(squireId);
        const [message] = yield* squireMessages(homeThreadId);
        const run = yield* finishRun(squireId, homeThreadId, message!);
        yield* delivery.finalizeRun({ squireId, homeThreadId, runId: run.id, status: run.status });

        const cards = yield* repository.listCards({ squireId, kinds: ["fyi"] });
        assert.lengthOf(cards, 1);
        const card = cards[0]!;
        assert.equal(card.status, "open");
        assert.equal(card.target_thread_id, tracked);
        assert.deepEqual(decodeCardPayload(card.payload_json), {
          type: "fyi",
          source: "summary",
          text: "Fix invoice rounding: finished",
          threadId: tracked,
        });
        assert.include(card.trigger_json, '"runId":"run-1"');
        // The snapshot row carries the outcome, so the client never fetches the card for it.
        assert.equal(squireCardRowFields(card).outcome, "finished");
        const created = yield* repository.listActionLog({
          squireId,
          kinds: ["card.created"],
          limit: 10,
        });
        assert.lengthOf(created, 1);
        assert.equal(created[0]!.card_id, card.id);
        assert.isNotNull(created[0]!.event_id);
        assert.deepEqual(yield* statuses(squireId), ["turn-finished:delivered"]);
      }),
    ),
  );

  it("a summary FYI row's outcome drops the title prefix, fits the row, and adds nothing new", () => {
    const fyi = (text: string, source = "summary") =>
      JSON.stringify({ type: "fyi", source, text, threadId: null });
    const title = "Fix invoice rounding";
    assert.equal(
      squireFyiOutcome(title, fyi("Fix invoice rounding: checks passed\nmore")),
      "checks passed",
    );
    const long = squireFyiOutcome(
      title,
      fyi("Fix invoice rounding: required checks failed on the head after the review fixes"),
    )!;
    assert.isAtMost([...long].length, SQUIRE_CARD_OUTCOME_MAX_CHARS);
    assert.equal(long, "required checks failed on the head…");
    assert.isUndefined(squireFyiOutcome(title, fyi("Fix invoice rounding:")));
    assert.isUndefined(squireFyiOutcome(title, fyi(" fix  invoice rounding ")));
    assert.isUndefined(squireFyiOutcome(title, fyi("Staging is frozen", "notify")));
  });

  it.live("gives the Lead only its kinds and drops the rest", () =>
    withHome(() =>
      Effect.gen(function* () {
        const service = yield* SquireService.SquireService;
        const delivery = yield* SquireDelivery.SquireDelivery;
        const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
        yield* turnFinished(lead.id, tracked, "run-1");
        yield* webhook(lead.id, "delivery-1");
        yield* threadless(lead.id, { type: "digest-due", date: "2026-11-01" }, "2026-11-01");
        yield* delivery.deliverReady(lead.id);
        const [message, ...rest] = yield* squireMessages(lead.homeThreadId!);
        assert.lengthOf(rest, 0);
        assert.include(message!.text, "Digest due for 2026-11-01");
        assert.deepEqual(yield* statuses(lead.id), [
          "turn-finished:dropped",
          "webhook-received:dropped",
          "digest-due:batched",
        ]);
      }),
    ),
  );

  it("names a message batch's origin by who wrote it (D56)", () => {
    const row = (from: SquireParticipant): SquireRepository.SquireEventRow => ({
      id: 1,
      squire_id: SquireId.make("squire-release"),
      thread_id: null,
      kind: "message",
      state_key: "mk",
      payload_json: encodeEvent({ type: "message", messageKey: "mk", from, hop: 0, body: "b" }),
      status: "pending",
      defer_reason: null,
      not_before: NOW,
      batch_id: null,
      created_at: NOW,
    });
    const user = row({ kind: "user" });
    const lead = row({ kind: "lead", squireId: SquireId.make("squire-lead") });
    const squire = row({ kind: "squire", squireId: SquireId.make("squire-docs") });
    assert.equal(SquireDelivery.batchOrigin([user, user]), "room");
    assert.equal(SquireDelivery.batchOrigin([lead]), "lead");
    assert.equal(SquireDelivery.batchOrigin([user, lead]), "lead");
    assert.equal(SquireDelivery.batchOrigin([lead, squire]), "message");
    assert.equal(SquireDelivery.batchOrigin([user, squire]), "message");
  });

  it("demotes a batch whose room context holds another Squire's post to message (P19.7)", () => {
    const user = (id: number): SquireRepository.SquireEventRow => ({
      id,
      squire_id: SquireId.make("squire-release"),
      thread_id: null,
      kind: "message",
      state_key: `mk-${id}`,
      payload_json: encodeEvent({
        type: "message",
        messageKey: `mk-${id}`,
        from: { kind: "user" },
        hop: 0,
        body: "b",
      }),
      status: "pending",
      defer_reason: null,
      not_before: NOW,
      batch_id: null,
      created_at: NOW,
    });
    const event: SquireRepository.SquireEventRow = { ...user(2), kind: "turn-finished" };
    const webhookRow: SquireRepository.SquireEventRow = { ...user(3), kind: "webhook-received" };
    const context = (...authorKinds: ReadonlyArray<"user" | "lead" | "squire" | "system">) => [
      {
        posts: authorKinds.map((authorKind, index) => ({
          postId: index + 1,
          author: authorKind,
          authorKind,
          body: "post",
          createdAt: NOW,
        })),
      },
    ];
    // Another Squire's post: Auto and rules are off, as for its message.
    assert.equal(SquireDelivery.batchOrigin([user(1)], context("user", "squire")), "message");
    assert.equal(SquireDelivery.batchOrigin([event], context("squire")), "message");
    // User-only and Lead-only context is context, not input: the origin holds.
    assert.equal(SquireDelivery.batchOrigin([user(1)], context("user", "system")), "room");
    assert.equal(SquireDelivery.batchOrigin([event], context("user")), "event");
    assert.equal(SquireDelivery.batchOrigin([user(1)], context("lead")), "room");
    assert.equal(SquireDelivery.batchOrigin([event], context("lead", "user")), "event");
    // An origin that never acts on Auto keeps its own name.
    assert.equal(SquireDelivery.batchOrigin([webhookRow], context("squire")), "webhook");
  });

  it.live(
    "holds messages sent during a turn for one batch at its end, never with thread events",
    () =>
      withHome(({ squireId, homeThreadId, restart }) =>
        Effect.gen(function* () {
          const service = yield* SquireService.SquireService;
          const delivery = yield* SquireDelivery.SquireDelivery;
          const docs = yield* service.create(createInput("docs", "Docs"));
          const message = (key: string, body: string) =>
            threadless(
              squireId,
              {
                type: "message",
                messageKey: key,
                from: { kind: "squire", squireId: docs.id },
                hop: 1,
                body,
              },
              key,
            );
          const long = `Check whether #318 touches the currency formatter ${"x".repeat(120)}`;
          yield* message("mk-1", `${long}\nSecond line.`);
          yield* delivery.deliverReady(squireId);
          const [first] = yield* squireMessages(homeThreadId);
          // P19.7: the handoff row names both ends and the first line, cut at 120.
          const summary = first!.notification?.summary ?? "";
          assert.isTrue(summary.startsWith("Docs → Release: Check whether #318"));
          assert.isTrue(summary.endsWith("…"));
          assert.lengthOf(summary.slice("Docs → Release: ".length), 120);

          // While the first turn runs: two more messages and a thread event.
          yield* message("mk-2", "Formatter is clean.");
          yield* turnFinished(squireId, tracked, "run-1");
          yield* message("mk-3", "Also the rounding helper.");
          yield* delivery.deliverReady(squireId);
          assert.lengthOf(yield* squireMessages(homeThreadId), 1);

          yield* finishRun(squireId, homeThreadId, first!);
          const [, second, ...rest] = yield* squireMessages(homeThreadId);
          assert.lengthOf(rest, 0);
          assert.equal(originOf(second!), "message");
          assert.equal(second!.senderThreadId, docs.homeThreadId);
          assert.deepEqual(second!.notification?.source, {
            kind: "squire",
            squireId,
            eventCount: 2,
            eventKinds: ["message", "message"],
          });
          assert.equal(second!.notification?.summary, "2 Squire events: message");
          assert.include(second!.text, "key mk-2:\nFormatter is clean.");
          assert.include(second!.text, "key mk-3:\nAlso the rounding helper.");
          assert.notInclude(second!.text, "turn-finished");
          assert.deepEqual(yield* statuses(squireId), [
            "message:delivered",
            "message:batched",
            "turn-finished:pending",
            "message:batched",
          ]);

          for (let start = 0; start < 2; start++) {
            yield* restart(
              Effect.flatMap(SquireDelivery.SquireDelivery, (next) => next.redispatchBatched),
            );
          }
          assert.lengthOf(yield* restart(squireMessages(homeThreadId)), 2);
        }),
      ),
  );

  it.live("attaches a room's unseen posts to the next batch and advances the cursor once", () =>
    withHome(({ squireId, homeThreadId }) =>
      Effect.gen(function* () {
        const service = yield* SquireService.SquireService;
        const delivery = yield* SquireDelivery.SquireDelivery;
        const repository = yield* SquireRepository.SquireRepository;
        const docs = yield* service.create(createInput("docs", "Docs"));
        yield* seedRoom([squireId, docs.id]);
        for (let index = 0; index < 22; index++) {
          yield* roomPost({ kind: "squire", id: docs.id }, `Docs note ${index}`);
        }
        const asked = yield* roomPost({ kind: "user" }, "@Release can you rebase?");
        yield* threadless(
          squireId,
          {
            type: "message",
            messageKey: "req-1",
            from: { kind: "user" },
            roomId: ROOM,
            postId: asked,
            hop: 0,
            body: "@Release can you rebase?",
          },
          "req-1",
        );

        yield* delivery.deliverReady(squireId);
        const [first] = yield* squireMessages(homeThreadId);
        // P19.7: Docs' posts in the context make the user's request a message turn.
        assert.equal(originOf(first!), "message");
        assert.isUndefined(first!.senderThreadId);
        assert.include(
          first!.text,
          `Message from the user · in room ${ROOM} · post #${asked} · hop 0 · key req-1:`,
        );
        assert.include(first!.text, `Room "v2.5 release" (${ROOM}) · 2 older posts not shown`);
        const contextLines = first!.text.split("\n").filter((line) => line.startsWith("- post #"));
        assert.lengthOf(contextLines, 20);
        assert.strictEqual(contextLines.at(-1), `- post #${asked - 1} · Docs: Docs note 21`);
        // The delivered post is the message, not context, and still moves the cursor.
        assert.notInclude(first!.text, `- post #${asked} `);
        assert.strictEqual(yield* cursorOf(squireId), asked);
        const [received] = yield* repository.listActionLog({
          squireId,
          kinds: ["event.received"],
          limit: 10,
        });
        assert.include(received!.data_json, `"${ROOM_CONTEXT_LOG_KEY}"`);
        // Context wakes nobody: Docs has nothing to deliver.
        yield* delivery.deliverReady(docs.id);
        assert.lengthOf(yield* squireMessages(docs.homeThreadId!), 0);

        const late = yield* roomPost({ kind: "squire", id: docs.id }, "Docs late note");
        yield* turnFinished(squireId, tracked, "run-1");
        yield* finishRun(squireId, homeThreadId, first!);
        const [, second] = yield* squireMessages(homeThreadId);
        assert.equal(originOf(second!), "message");
        const lines = second!.text.split("\n").filter((line) => line.startsWith("- post #"));
        assert.deepEqual(lines, [`- post #${late} · Docs: Docs late note`]);
        assert.notInclude(second!.text, "older post");
        assert.strictEqual(yield* cursorOf(squireId), late);
      }),
    ),
  );

  it.live("keeps the cursor of a room the batch had no room to show", () =>
    withHome(({ squireId, homeThreadId }) =>
      Effect.gen(function* () {
        const service = yield* SquireService.SquireService;
        const delivery = yield* SquireDelivery.SquireDelivery;
        const docs = yield* service.create(createInput("docs", "Docs"));
        const second = SquireRoomId.make("room-docs");
        yield* seedRoom([squireId]);
        yield* seedRoom([squireId], second, "Docs sync");
        for (const room of [ROOM, second]) {
          for (const fill of ["p", "q"]) {
            yield* roomPost({ kind: "user" }, `${room} ${fill.repeat(1_500)}`, room);
          }
        }
        const messages = (count: number, prefix: string) =>
          Effect.forEach(
            Array.from({ length: count }, (_, index) => `${prefix}-${index}`),
            (key) =>
              threadless(
                squireId,
                {
                  type: "message",
                  messageKey: key,
                  from: { kind: "squire", squireId: docs.id },
                  hop: 1,
                  body: `${key} ${"m".repeat(1_990)}`,
                },
                key,
              ),
            { discard: true },
          );
        const shownRooms = (text: string) =>
          [ROOM, second].filter((room) => new RegExp(`\\(${room}\\)[^\\n]*\\n- post #`).test(text));

        // Events that fill the 16k budget leave no room for any context.
        yield* messages(9, "full");
        yield* delivery.deliverReady(squireId);
        const [first] = yield* squireMessages(homeThreadId);
        assert.match(first!.text, /more events not shown$/);
        assert.deepEqual(shownRooms(first!.text), []);
        assert.strictEqual(yield* cursorOf(squireId, ROOM), 0);
        assert.strictEqual(yield* cursorOf(squireId, second), 0);

        // Room for one room only: the other is cut and keeps its cursor.
        yield* messages(5, "some");
        yield* finishRun(squireId, homeThreadId, first!);
        const [, middle] = yield* squireMessages(homeThreadId);
        assert.match(middle!.text, /\+1 more rooms not shown$/);
        assert.deepEqual(shownRooms(middle!.text), [ROOM]);
        assert.isAbove((yield* cursorOf(squireId, ROOM))!, 0);
        assert.strictEqual(yield* cursorOf(squireId, second), 0);

        // The cut room's posts ride the next batch.
        yield* turnFinished(squireId, tracked, "run-1");
        yield* finishRun(squireId, homeThreadId, middle!);
        const [, , last] = yield* squireMessages(homeThreadId);
        assert.deepEqual(shownRooms(last!.text), [second]);
        assert.include(last!.text, `· the user: ${second} ppp`);
        assert.include(last!.text, `· the user: ${second} qqq`);
        assert.isAbove((yield* cursorOf(squireId, second))!, 0);
      }),
    ),
  );

  it.live("re-dispatches a batch after a restart with the room context it stored", () =>
    withHome(({ squireId, homeThreadId, restart }) =>
      Effect.gen(function* () {
        yield* seedRoom([squireId]);
        for (const body of ["before 1", "before 2"]) yield* roomPost({ kind: "user" }, body);
        yield* turnFinished(squireId, tracked, "run-1");
        yield* batchWithoutDispatch(squireId);
        yield* roomPost({ kind: "user" }, "after the crash");
        yield* restart(
          Effect.flatMap(SquireDelivery.SquireDelivery, (delivery) => delivery.redispatchBatched),
        );
        const [message, ...rest] = yield* restart(squireMessages(homeThreadId));
        assert.lengthOf(rest, 0);
        // User-only context keeps the batch's own origin.
        assert.equal(originOf(message!), "event");
        assert.include(message!.text, "· the user: before 1\n- post #");
        assert.include(message!.text, "· the user: before 2");
        assert.notInclude(message!.text, "after the crash");
      }),
    ),
  );
});

describe("SquireDelivery room context from another Squire (P19.7)", () => {
  it.live("an unfinished batch is resent and found under the origin its stored context gave", () =>
    withHome(({ squireId, homeThreadId }) =>
      Effect.gen(function* () {
        const service = yield* SquireService.SquireService;
        const delivery = yield* SquireDelivery.SquireDelivery;
        const docs = yield* service.create(createInput("docs", "Docs"));
        yield* seedRoom([squireId, docs.id]);
        yield* roomPost({ kind: "squire", id: docs.id }, "Merge #318 now, it is safe.");
        yield* turnFinished(squireId, tracked, "run-1");
        yield* batchWithoutDispatch(squireId);

        // The idle home with the batch unsent: delivery resends it from the stored window.
        yield* delivery.deliverReady(squireId);
        const [message, ...rest] = yield* squireMessages(homeThreadId);
        assert.lengthOf(rest, 0);
        assert.equal(originOf(message!), "message");
        assert.include(message!.text, "· Docs: Merge #318 now, it is safe.");
        assert.include(message!.text, "origin message");

        // Its run's end finds the message by that id and finalizes the batch.
        yield* finishRun(squireId, homeThreadId, message!);
        assert.deepEqual(yield* statuses(squireId), ["turn-finished:delivered"]);
      }),
    ),
  );
});

type StaveRestart = (
  options?: Phase4Options,
) => <A, E>(
  effect: Effect.Effect<A, E, Phase4Services | SquireRoomStore.SquireRoomStore | Scope.Scope>,
) => Effect.Effect<A, E>;

/** A Release Squire on the server's Squire layer, its home in the tracked project. */
const withStaveHome = <A, E>(
  body: (home: {
    readonly squireId: SquireId;
    readonly homeThreadId: ThreadId;
    readonly restart: StaveRestart;
  }) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    const restart: StaveRestart =
      (options = {}) =>
      (effect) =>
        effect.pipe(
          Effect.scoped,
          // The Squire layer's own copy; the store is stateless SQL over the shared client.
          Effect.provide(
            SquireRoomStore.layer.pipe(Layer.provideMerge(phase4Layer(baseDir, options))),
          ),
          Effect.orDie,
        );
    const squire = yield* restart()(
      Effect.gen(function* () {
        yield* seedProject(homeProject, initRepo(`${root}/home-project`));
        yield* createThread(tracked, "Fix invoice rounding");
        const service = yield* need(SquireService.SquireService);
        return yield* service.create(
          createInput("release", "Release", [{ kind: "project", targetId: homeProject }]),
        );
      }),
    );
    return yield* body({ squireId: squire.id, homeThreadId: squire.homeThreadId!, restart });
  }).pipe(Effect.scoped);

/** A Stave operation holds the home project's space until the returned Deferred completes. */
const holdSpace = (scope: Scope.Scope) =>
  Effect.gen(function* () {
    const locks = yield* StaveSpaceLock.StaveSpaceLock;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const project = Option.getOrThrow(yield* projects.get(homeProject));
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* locks
      .withSpaceLock(
        project.workspaceRoot,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkIn(scope));
    yield* Deferred.await(held);
    return release;
  });

const deliveryLog = (squireId: SquireId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository.listActionLog({ squireId, kinds: ["notification.delivery"], limit: 10 }),
  );

describe("SquireDelivery under the Stave space lock", () => {
  it.effect("delivers a turn a long Stave operation refused exactly once, after it ends", () =>
    withStaveHome(({ squireId, homeThreadId, restart }) =>
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>();
        const refused = yield* Deferred.make<void>();
        yield* restart({
          staveSpaceLock: {
            onWaiting: Deferred.succeed(waiting, undefined),
            onRefused: Deferred.succeed(refused, undefined),
          },
        })(
          Effect.gen(function* () {
            const delivery = yield* need(SquireDelivery.SquireDelivery);
            // Held before the row exists: the startup sweep may wake delivery at any time.
            const release = yield* holdSpace(yield* Effect.scope);
            yield* seedRoom([squireId]);
            yield* roomPost({ kind: "user" }, "before the refusal");
            yield* turnFinished(squireId, tracked, "run-1");

            yield* delivery.wake(squireId);
            yield* Deferred.await(waiting);
            // The operation outlasts the admission wait.
            yield* TestClock.adjust(STAVE_ADMISSION_WAIT);
            yield* Deferred.await(refused);
            const cursor = yield* cursorOf(squireId);
            // Posted while the batch waits: the retry shows the window it stored.
            yield* roomPost({ kind: "user" }, "while the space was busy");
            yield* Deferred.succeed(release, undefined);
            yield* delivery.drain;

            const messages = yield* squireMessages(homeThreadId);
            assert.lengthOf(messages, 1);
            assert.include(messages[0]!.text, "before the refusal");
            assert.notInclude(messages[0]!.text, "while the space was busy");
            assert.strictEqual(yield* cursorOf(squireId), cursor);
            assert.deepEqual(yield* statuses(squireId), ["turn-finished:batched"]);
            assert.lengthOf(yield* deliveryLog(squireId), 0);

            yield* delivery.wake(squireId);
            yield* delivery.drain;
            assert.lengthOf(yield* squireMessages(homeThreadId), 1);
          }),
        );
      }),
    ),
  );

  it.effect("delivers on the first attempt when a short Stave operation ends inside the wait", () =>
    withStaveHome(({ squireId, homeThreadId, restart }) =>
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>();
        const refused = yield* Deferred.make<void>();
        yield* restart({
          staveSpaceLock: {
            onWaiting: Deferred.succeed(waiting, undefined),
            onRefused: Deferred.succeed(refused, undefined),
          },
        })(
          Effect.gen(function* () {
            const delivery = yield* need(SquireDelivery.SquireDelivery);
            const release = yield* holdSpace(yield* Effect.scope);
            yield* turnFinished(squireId, tracked, "run-1");

            yield* delivery.wake(squireId);
            yield* Deferred.await(waiting);
            yield* TestClock.adjust("4 seconds");
            assert.lengthOf(yield* squireMessages(homeThreadId), 0);
            yield* Deferred.succeed(release, undefined);
            yield* delivery.drain;

            assert.lengthOf(yield* squireMessages(homeThreadId), 1);
            // Never refused, so the retry path never ran.
            assert.isFalse(yield* Deferred.isDone(refused));
            assert.deepEqual(yield* statuses(squireId), ["turn-finished:batched"]);
            assert.lengthOf(yield* deliveryLog(squireId), 0);
          }),
        );
      }),
    ),
  );

  it.effect("never refuses a user turn because a Squire delivery waits for the space", () =>
    withStaveHome(({ squireId, homeThreadId, restart }) =>
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>();
        const refused = yield* Deferred.make<void>();
        yield* restart({
          staveSpaceLock: {
            onWaiting: Deferred.succeed(waiting, undefined),
            onRefused: Deferred.succeed(refused, undefined),
          },
        })(
          Effect.gen(function* () {
            const delivery = yield* need(SquireDelivery.SquireDelivery);
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const locks = yield* StaveSpaceLock.StaveSpaceLock;
            const projects = yield* ProjectStore.ProjectStoreV2;
            const root = Option.getOrThrow(yield* projects.get(homeProject)).workspaceRoot;
            const held = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            // The user's turn is sent by the holder the moment it lets go, as
            // the delivery's shared wait for the space is granted.
            const holder = yield* locks
              .withSpaceLock(
                root,
                Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
              )
              .pipe(
                Effect.andThen(
                  orchestrator.dispatch({
                    type: "message.dispatch",
                    commandId: CommandId.make("test:user-turn"),
                    threadId: tracked,
                    messageId: MessageId.make("message:user:test-user-turn"),
                    text: "Ship it.",
                    attachments: [],
                    dispatchMode: { type: "queue_after_active" },
                    createdBy: "user",
                    creationSource: "web",
                  }),
                ),
                Effect.forkChild,
              );
            yield* Deferred.await(held);
            yield* turnFinished(squireId, tracked, "run-1");

            yield* delivery.wake(squireId);
            yield* Deferred.await(waiting);
            yield* TestClock.adjust(STAVE_ADMISSION_WAIT);
            yield* Deferred.await(refused);
            yield* Deferred.succeed(release, undefined);
            // A refusal would fail the join.
            yield* Fiber.join(holder);
            yield* delivery.drain;

            assert.lengthOf(yield* squireMessages(homeThreadId), 1);
            const user = yield* orchestrator.getThreadProjection(tracked);
            assert.isTrue(
              user.messages.some((message) => message.id === "message:user:test-user-turn"),
            );
          }),
        );
      }),
    ),
  );

  it.effect("still drops a batch Stave refused for another reason", () =>
    withStaveHome(({ squireId, homeThreadId, restart }) =>
      restart({ staveSpaceLock: {} })(
        Effect.gen(function* () {
          const hooks = yield* LecturnOrchestrationHooks.LecturnOrchestrationHooks;
          const delivery = yield* need(SquireDelivery.SquireDelivery);
          yield* hooks.register({
            name: "stave-admission",
            aroundCommand: (input, commit) =>
              input.command.type === "message.dispatch" && input.command.threadId === homeThreadId
                ? Effect.fail(
                    new LecturnOrchestrationHooks.LecturnHookRejectedError({
                      hook: "aroundCommand",
                      contribution: "stave",
                      reason: "This space does not admit new turns.",
                      cause: "admission",
                    }),
                  )
                : commit,
          });
          yield* turnFinished(squireId, tracked, "run-1");

          yield* delivery.wake(squireId);
          yield* delivery.drain;
          assert.lengthOf(yield* squireMessages(homeThreadId), 0);
          assert.deepEqual(yield* statuses(squireId), ["turn-finished:dropped"]);
          const [logged] = yield* deliveryLog(squireId);
          assert.include(logged!.data_json, '"outcome":"rejected"');
        }),
      ),
    ),
  );

  it.effect("rewinds the room cursor of a refused batch, so its context rides the next", () =>
    withStaveHome(({ squireId, homeThreadId, restart }) =>
      restart({ staveSpaceLock: {} })(
        Effect.gen(function* () {
          const hooks = yield* LecturnOrchestrationHooks.LecturnOrchestrationHooks;
          const delivery = yield* need(SquireDelivery.SquireDelivery);
          let admit = false;
          yield* hooks.register({
            name: "stave-admission",
            aroundCommand: (input, commit) =>
              !admit &&
              input.command.type === "message.dispatch" &&
              input.command.threadId === homeThreadId
                ? Effect.fail(
                    new LecturnOrchestrationHooks.LecturnHookRejectedError({
                      hook: "aroundCommand",
                      contribution: "stave",
                      reason: "This space does not admit new turns.",
                      cause: "admission",
                    }),
                  )
                : commit,
          });
          yield* seedRoom([squireId]);
          const posted = yield* roomPost({ kind: "user" }, "Hold the release until Friday.");
          yield* turnFinished(squireId, tracked, "run-1");

          yield* delivery.wake(squireId);
          yield* delivery.drain;
          assert.deepEqual(yield* statuses(squireId), ["turn-finished:dropped"]);
          assert.strictEqual(yield* cursorOf(squireId), 0);

          admit = true;
          yield* turnFinished(squireId, tracked, "run-2");
          yield* delivery.wake(squireId);
          yield* delivery.drain;
          const [message] = yield* squireMessages(homeThreadId);
          assert.include(
            message!.text,
            `- post #${posted} · the user: Hold the release until Friday.`,
          );
          assert.strictEqual(yield* cursorOf(squireId), posted);
        }),
      ),
    ),
  );

  it.effect("delivers a batch a long Stave operation refused once across restarts", () =>
    withStaveHome(({ squireId, homeThreadId, restart }) =>
      Effect.gen(function* () {
        // The holder outlives the first server, so its lock never frees there.
        const outlives = yield* Effect.scope;
        const waiting = yield* Deferred.make<void>();
        const refused = yield* Deferred.make<void>();
        yield* restart({
          staveSpaceLock: {
            onWaiting: Deferred.succeed(waiting, undefined),
            onRefused: Deferred.succeed(refused, undefined),
          },
        })(
          Effect.gen(function* () {
            const delivery = yield* need(SquireDelivery.SquireDelivery);
            yield* holdSpace(outlives);
            yield* turnFinished(squireId, tracked, "run-1");
            yield* delivery.wake(squireId);
            yield* Deferred.await(waiting);
            yield* TestClock.adjust(STAVE_ADMISSION_WAIT);
            yield* Deferred.await(refused);
          }),
        );
        assert.lengthOf(yield* restart()(squireMessages(homeThreadId)), 0);
        for (let start = 0; start < 2; start++) {
          yield* restart({ staveSpaceLock: {} })(
            Effect.gen(function* () {
              const delivery = yield* need(SquireDelivery.SquireDelivery);
              yield* delivery.redispatchBatched;
              yield* delivery.wake(squireId);
              yield* delivery.drain;
            }),
          );
        }
        const after = yield* restart()(
          Effect.all({
            messages: squireMessages(homeThreadId),
            statuses: statuses(squireId),
            log: deliveryLog(squireId),
          }),
        );
        assert.lengthOf(after.messages, 1);
        assert.deepEqual(after.statuses, ["turn-finished:batched"]);
        assert.lengthOf(after.log, 0);
      }),
    ),
  );
});

describe("message turn permissions (D56, P19.7)", () => {
  it.effect.each([
    { author: "squire", origin: "message", status: "open" },
    { author: "lead", origin: "lead", status: "held" },
    { author: "user", origin: "room", status: "held" },
  ] as const)("a $author-authored batch runs as $origin and its Auto steer is $status", (cell) =>
    withRoomCast(
      ({ release, research, lead }) =>
        Effect.gen(function* () {
          const repository = yield* need(SquireRepository.SquireRepository);
          // An allow rule that would match: a message turn must not apply it.
          yield* repository.insertRule({
            id: SquireRuleId.make("rule-rerun"),
            squire_id: release.squireId,
            effect: "allow",
            action_class: "steer",
            target_kind: "thread",
            target_id: invoiceThread,
            steer_kind: "rerun-checks",
            status: "active",
            match_count: 0,
            last_matched_at: null,
            created_at: NOW,
          });
          const from: SquireParticipant =
            cell.author === "squire"
              ? { kind: "squire", squireId: research.squireId }
              : cell.author === "lead"
                ? { kind: "lead", squireId: lead.squireId }
                : { kind: "user" };
          assert.isTrue(
            yield* repository.insertEvent({
              squire_id: release.squireId,
              thread_id: null,
              kind: "message",
              state_key: "mk-steer",
              payload_json: encodeEvent({
                type: "message",
                messageKey: "mk-steer",
                from,
                hop: cell.author === "user" ? 0 : 1,
                body: "Invoice rounding needs a rerun.",
              }),
              status: "pending",
              defer_reason: null,
              not_before: NOW,
              batch_id: null,
              created_at: NOW,
            }),
          );
          yield* deliver(release.squireId);
          const result = yield* callTool(release, "squire", "squire_send_steer", {
            threadId: invoiceThread,
            reason: "CI flaked on the rounding suite.",
            steer: "Rerun the checks.",
            steerKind: "rerun-checks",
          });
          assert.isFalse(result.isError);
          const [card, ...rest] = yield* repository.listCards({ squireId: release.squireId });
          assert.lengthOf(rest, 0);
          assert.strictEqual(card!.origin, cell.origin);
          assert.strictEqual(card!.status, cell.status);
          const log = yield* repository.listActionLog({
            squireId: release.squireId,
            kinds: ["action.held", "rule.matched"],
            limit: 10,
          });
          if (cell.author === "squire") {
            assert.isNull(card!.rule_id);
            assert.lengthOf(log, 0);
          } else {
            assert.isTrue(log.some((row) => row.kind === "action.held"));
          }
        }),
      { squirePermissions: { steer: "auto" } },
    ),
  );
});
