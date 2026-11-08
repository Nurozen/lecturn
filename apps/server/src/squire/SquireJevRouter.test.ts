import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ContextualError,
  EnvironmentId,
  type ExtensionFundingStatusResult,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  SquireCardId,
  SquireEvent,
  SquireId,
  SquireRoomId,
  type SquireRoomPostId,
  SquireRouting,
  SquireRoutingRequest,
  type SquireRoutingResult,
  ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ExtensionsCloudClient from "../extensions/ExtensionsCloudClient.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SquireContainers from "./SquireContainers.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquireJevRouter from "./SquireJevRouter.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRoomStore from "./SquireRoomStore.ts";
import * as SquireScope from "./SquireScope.ts";
import { seedProject } from "./testkit/lifecycleHarness.ts";
import { grantRow, orchestratorLayer, squireRow } from "./testkit/scopeHarness.ts";

const START = Date.parse("2026-11-02T08:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const release = SquireId.make("squire:release");
const research = SquireId.make("squire:research");
const lead = SquireId.make("squire:lead");
const billing = ProjectId.make("billing-service");
const webApp = ProjectId.make("web-app");
const roomId = SquireRoomId.make("room:checkout");
const KEY = "post-key-1";
const OTHER_BODY = "OTHER-POST-BODY never leaves the server";
const POST_BODY = "Can someone look at why the checkout total drifts?";
const LONG_BRIEF = `Release watches billing. ${"x".repeat(600)}`;
const threadModel = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SquireEvent));
const decodeRouting = Schema.decodeUnknownSync(Schema.fromJsonString(SquireRouting));
const decodeRoutingRequest = Schema.decodeUnknownEffect(SquireRoutingRequest);
const decodeLogData = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

type Script = (
  request: SquireJevRouter.JevRouteRequest,
) => Effect.Effect<SquireJevRouter.JevAnswer, SquireJevRouter.SquireJevRelayError>;

interface Probe {
  readonly requests: Array<SquireJevRouter.JevRouteRequest>;
  readonly woken: Array<SquireId>;
  readonly logs: Array<string>;
}

const newProbe = (): Probe => ({ requests: [], woken: [], logs: [] });

// One database per test: the stores, the real scope, and the projections.
const stores = SquireScope.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SquireRepository.layer, SquireRoomStore.layer)),
  Layer.provideMerge(SquireContainers.layerTest({})),
  Layer.provideMerge(orchestratorLayer),
);

/** One server process's router over the shared stores; a second build is a restart. */
const router = (
  probe: Probe,
  script: Script,
  availability?: Effect.Effect<SquireJevRouter.JevAvailability>,
) =>
  SquireJevRouter.layerRouting.pipe(
    Layer.provide(
      SquireJevRouter.layerRelayTest(
        (request) => Effect.suspend(() => (probe.requests.push(request), script(request))),
        availability === undefined ? {} : { availability },
      ),
    ),
    Layer.provide(
      Layer.mock(SquireDelivery.SquireDelivery)({
        wake: (squireId) => Effect.sync(() => void probe.woken.push(squireId)),
      }),
    ),
  );

const captureLogs = (probe: Probe) =>
  Logger.layer(
    [
      Logger.make(
        ({ message }) =>
          void probe.logs.push(Array.isArray(message) ? String(message[0]) : String(message)),
      ),
    ],
    { mergeWithExisting: false },
  );

const createThread = (threadId: ThreadId, projectId: ProjectId, title: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "system",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId,
      title,
      modelSelection: threadModel,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  );

const card = (id: string, title: string, createdAt: string): SquireRepository.SquireCardRow => ({
  id: SquireCardId.make(id),
  squire_id: release,
  owner_squire_id: release,
  kind: "fyi",
  status: "open",
  target_thread_id: null,
  project_id: null,
  title,
  why: "TRANSCRIPT-LIKE why text stays home",
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
  executes_at: null,
  expires_at: null,
  attempt: 0,
  command_id: null,
  execution_key: null,
  dedupe_key: null,
  replaced_count: 0,
  ask_json: null,
  resolution: null,
  created_at: createdAt,
  updated_at: createdAt,
});

const roomRow = (now: string): SquireRoomStore.SquireRoomDbRow => ({
  id: roomId,
  topic: "Checkout drift",
  about_json: "[]",
  status: "open",
  muted: 0,
  bot_messaging: "on",
  idle_ttl_seconds: 24 * 3600,
  creator_kind: "user",
  proposal_event_id: null,
  last_post_at: now,
  closed_reason: null,
  create_request_id: "room-request",
  revision: 0,
  created_at: now,
  updated_at: now,
});

const ruleRouting = JSON.stringify({
  via: { kind: "rule", rule: "mention", match: "@Release" },
  recipients: [release],
});

/**
 * The state p7b-rooms commits for a funded rule (e) post: the post with
 * routing `pending` and the Lead's `message` row deferred for 5 s.
 */
const seed = Effect.gen(function* () {
  yield* TestClock.setTime(START);
  const repository = yield* SquireRepository.SquireRepository;
  const rooms = yield* SquireRoomStore.SquireRoomStore;
  const now = iso(START);
  yield* seedProject(billing, "/nonexistent/billing-service");
  yield* seedProject(webApp, "/nonexistent/web-app");
  for (let n = 1; n <= 22; n++) {
    yield* createThread(ThreadId.make(`thr_billing_${n}`), billing, `Billing thread ${n}`);
  }
  yield* createThread(ThreadId.make("thr_currency"), webApp, "Currency formatter");
  yield* (yield* Orchestrator.OrchestratorV2).dispatch({
    type: "thread.pull-request.link",
    commandId: CommandId.make("link:thr_currency:318"),
    threadId: ThreadId.make("thr_currency"),
    host: "github.com",
    repository: "acme/web-app",
    number: 318,
    url: "https://github.com/acme/web-app/pull/318",
    source: "manual",
  });

  yield* repository.createSquire(squireRow(release, { name: "Release", brief: LONG_BRIEF }));
  yield* repository.createSquire(
    squireRow(research, { name: "Research", brief: "Research watches the web app." }),
  );
  yield* repository.createSquire(squireRow(lead, { name: "Lead", role: "lead" }));
  yield* repository.insertGrant(grantRow(release, "project", billing));
  yield* repository.insertGrant(grantRow(research, "project", webApp));
  yield* repository.insertCard(
    card("card-recent", "Invoice rounding is off by a cent", iso(START - HOUR)),
  );
  yield* repository.insertCard(card("card-old", "Last week's deploy", iso(START - 30 * HOUR)));

  return yield* repository.transaction(
    Effect.gen(function* () {
      yield* rooms.insertRoom(roomRow(now));
      for (const member of [release, research]) {
        yield* rooms.addMember({
          room_id: roomId,
          member_kind: "squire",
          member_id: member,
          read_cursor: 0,
          user_seen_cursor: null,
        });
      }
      yield* rooms.addMember({
        room_id: roomId,
        member_kind: "user",
        member_id: SquireRoomStore.USER_MEMBER_ID,
        read_cursor: 0,
        user_seen_cursor: 0,
      });
      const base = {
        room_id: roomId,
        reply_to: null,
        refs_json: "[]",
        hop: 0,
        rerouted_from: null,
        created_at: now,
      };
      yield* rooms.insertPost({
        ...base,
        message_key: "earlier",
        author_kind: "squire",
        author_id: release,
        body: OTHER_BODY,
        routing_json: ruleRouting,
      });
      const postId = Option.getOrThrow(
        yield* rooms.insertPost({
          ...base,
          message_key: KEY,
          author_kind: "user",
          author_id: null,
          body: POST_BODY,
          routing_json: SquireRoomStore.PENDING_ROUTING_JSON,
        }),
      );
      yield* repository.insertEvent({
        squire_id: lead,
        thread_id: null,
        kind: "message",
        state_key: KEY,
        payload_json: encodeEvent({
          type: "message",
          messageKey: KEY,
          from: { kind: "user" },
          roomId,
          postId,
          hop: 0,
          body: POST_BODY,
        }),
        status: "deferred",
        defer_reason: "routing",
        not_before: iso(START + SquireJevRouter.JEV_DEADLINE_MS),
        batch_id: null,
        created_at: now,
      });
      return postId;
    }),
  );
});

const messageRow = (squireId: SquireId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository.getEventByKey({ squireId, kind: "message", threadId: null, stateKey: KEY }),
  );

const statusOf = (squireId: SquireId) =>
  messageRow(squireId).pipe(
    Effect.map(Option.map((row) => row.status)),
    Effect.map(Option.getOrNull),
  );

const routingOf = (postId: SquireRoomPostId) =>
  Effect.gen(function* () {
    const rooms = yield* SquireRoomStore.SquireRoomStore;
    return decodeRouting(Option.getOrThrow(yield* rooms.getPost(postId)).routing_json);
  });

const logRows = (kind: string) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    return (yield* repository.listActionLog({ squireId: lead, kinds: [kind], limit: 20 })).map(
      (row) => ({ ...row, data: decodeLogData(row.data_json) }),
    );
  });

const elapsed = Effect.map(DateTime.now, (now) => DateTime.toEpochMillis(now) - START);

const answer = (
  choice: SquireId | "lead",
  confidence: number,
  noReplyConfidence = 0.1,
): SquireJevRouter.JevAnswer => ({ choice, confidence, noReplyConfidence });

/** Seeds the pending post, begins with `script`, and waits for the request to settle. */
const routeOnce = (probe: Probe, script: Script) =>
  Effect.gen(function* () {
    const postId = yield* seed;
    yield* Effect.gen(function* () {
      const jev = yield* SquireJevRouter.SquireJevRouting;
      yield* jev.begin({ postId, fundingGeneration: 1 });
      yield* jev.drain;
    }).pipe(Effect.provide(router(probe, script)));
    return postId;
  });

describe("SquireJevRouter", () => {
  it.effect("sends only names, bounded briefs, scope, and activity titles", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      yield* routeOnce(probe, () => Effect.succeed(answer(research, 0.9)));
      assert.strictEqual(probe.requests.length, 1);
      const request = probe.requests[0]!;
      assert.strictEqual(request.requestId, `squire-route:${KEY}`);
      assert.strictEqual(request.runId, `squire-route:${KEY}`);
      assert.strictEqual(request.fundingGeneration, 1);
      assert.deepStrictEqual(request.post, { body: POST_BODY });
      assert.deepStrictEqual(
        request.members.map((member) => member.name),
        ["Release", "Research"],
      );
      const [releaseState, researchState] = request.members;
      assert.strictEqual(releaseState!.brief.length, 500);
      assert.isTrue(LONG_BRIEF.startsWith(releaseState!.brief));
      assert.deepStrictEqual(releaseState!.scope.containers, ["billing-service"]);
      assert.strictEqual(releaseState!.scope.threadTitles.length, 20);
      assert.isTrue(releaseState!.scope.threadTitles.every((title) => title.startsWith("Billing")));
      assert.deepStrictEqual(releaseState!.recentActivity, [
        "1 posts in this room in the last 24 h",
        "Invoice rounding is off by a cent",
      ]);
      assert.deepStrictEqual(researchState!.scope, {
        containers: ["web-app"],
        threadTitles: ["Currency formatter"],
        pullRequests: [318],
      });
      for (const member of request.members) {
        assert.deepStrictEqual(Object.keys(member).toSorted(), [
          "brief",
          "name",
          "recentActivity",
          "scope",
          "squireId",
        ]);
      }
      assert.deepStrictEqual(Object.keys(request).toSorted(), [
        "featureId",
        "fundingGeneration",
        "members",
        "post",
        "requestId",
        "runId",
        "templateVersion",
      ]);
      const body = JSON.stringify(request);
      assert.notInclude(body, OTHER_BODY);
      assert.notInclude(body, "TRANSCRIPT-LIKE");
    }).pipe(Effect.provide(stores));
  });

  it.effect("at or above 0.85 the member gets the post and the Lead row is dropped", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* routeOnce(probe, () => Effect.succeed(answer(research, 0.85)));
      assert.deepStrictEqual(yield* routingOf(postId), {
        via: { kind: "jev", confidence: 0.85, noReplyNeeded: false, shownToLead: false },
        recipients: [research],
      });
      assert.strictEqual(yield* statusOf(lead), "dropped");
      assert.strictEqual(yield* statusOf(research), "pending");
      assert.deepStrictEqual(probe.woken, [research]);
      const routed = yield* logRows("room.routed");
      assert.strictEqual(routed.length, 1);
      assert.strictEqual(routed[0]!.data.band, "high");
      assert.strictEqual(routed[0]!.post_id, postId);
      const rooms = yield* SquireRoomStore.SquireRoomStore;
      assert.isTrue(Option.isNone(yield* rooms.getPostByKey(`jev-shown:${KEY}`)));
    }).pipe(Effect.provide(stores));
  });

  it.effect("from 0.6 to 0.85 the member gets it and a system row shows it to the Lead", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* routeOnce(probe, () => Effect.succeed(answer(research, 0.6)));
      assert.deepStrictEqual(yield* routingOf(postId), {
        via: { kind: "jev", confidence: 0.6, noReplyNeeded: false, shownToLead: true },
        recipients: [research],
      });
      assert.strictEqual(yield* statusOf(lead), "dropped");
      assert.strictEqual(yield* statusOf(research), "pending");
      assert.deepStrictEqual(probe.woken, [research]);
      const rooms = yield* SquireRoomStore.SquireRoomStore;
      const shown = Option.getOrThrow(yield* rooms.getPostByKey(`jev-shown:${KEY}`));
      assert.strictEqual(shown.author_kind, "system");
      assert.strictEqual(shown.body, "Routed to Research · Jev 0.60 · shown to Lead");
      assert.strictEqual(shown.reply_to, postId);
      assert.deepStrictEqual(decodeRouting(shown.routing_json).recipients, []);
    }).pipe(Effect.provide(stores));
  });

  it.effect.each([
    { label: "below 0.6", reply: answer(research, 0.59) },
    { label: "`lead` on top", reply: answer("lead", 0.95) },
  ])("$label: the Lead row goes pending", ({ reply }) => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* routeOnce(probe, () => Effect.succeed(reply));
      assert.deepStrictEqual(yield* routingOf(postId), {
        via: {
          kind: "jev",
          confidence: reply.confidence,
          noReplyNeeded: false,
          shownToLead: false,
        },
        recipients: [lead],
      });
      assert.strictEqual(yield* statusOf(lead), "pending");
      assert.isNull(yield* statusOf(research));
      assert.deepStrictEqual(probe.woken, [lead]);
      assert.strictEqual((yield* logRows("room.routed"))[0]!.data.band, "lead");
    }).pipe(Effect.provide(stores));
  });

  it.effect("no reply needed at 0.85 wakes nobody", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* routeOnce(probe, () => Effect.succeed(answer(research, 0.95, 0.85)));
      assert.deepStrictEqual(yield* routingOf(postId), {
        via: { kind: "jev", confidence: 0.85, noReplyNeeded: true, shownToLead: false },
        recipients: [],
      });
      assert.strictEqual(yield* statusOf(lead), "dropped");
      assert.isNull(yield* statusOf(research));
      assert.deepStrictEqual(probe.woken, []);
    }).pipe(Effect.provide(stores));
  });

  const relayFailure =
    (reason: SquireJevRouter.JevFailureReason): Script =>
    () =>
      Effect.fail(new SquireJevRouter.SquireJevRelayError({ reason }));

  it.effect.each([
    { label: "rate-limited", reason: "rate-limited", script: relayFailure("rate-limited") },
    { label: "allowance", reason: "allowance", script: relayFailure("allowance") },
    { label: "error", reason: "error", script: relayFailure("error") },
    {
      label: "invalid (unknown member)",
      reason: "invalid",
      script: () => Effect.succeed(answer(SquireId.make("squire:ghost"), 0.9)),
    },
    {
      label: "invalid (confidence out of range)",
      reason: "invalid",
      script: () => Effect.succeed(answer(research, 1.2)),
    },
  ] as const)("$label falls back to the Lead at once", ({ reason, script }) => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* routeOnce(probe, script);
      assert.deepStrictEqual(yield* routingOf(postId), {
        via: { kind: "fallback", reason },
        recipients: [lead],
      });
      assert.strictEqual(yield* statusOf(lead), "pending");
      assert.isNull(yield* statusOf(research));
      assert.deepStrictEqual(probe.woken, [lead]);
      assert.deepStrictEqual(
        (yield* logRows("room.routing-fallback")).map((row) => row.data.reason),
        [reason],
      );
      assert.strictEqual(yield* elapsed, 0);
    }).pipe(Effect.provide(stores));
  });

  it.effect("no answer within 5 s falls back to the Lead (timeout)", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* seed;
      yield* Effect.gen(function* () {
        const jev = yield* SquireJevRouter.SquireJevRouting;
        yield* jev.begin({ postId, fundingGeneration: 1 });
        assert.deepStrictEqual(
          yield* jev.nextDeadlineAt,
          Option.some(DateTime.makeUnsafe(START + SquireJevRouter.JEV_DEADLINE_MS)),
        );
        yield* TestClock.adjust(SquireJevRouter.JEV_DEADLINE_MS - 1);
        yield* jev.timeoutDue(yield* DateTime.now);
        assert.strictEqual(yield* statusOf(lead), "deferred");

        yield* TestClock.adjust(1);
        yield* jev.timeoutDue(yield* DateTime.now);
        assert.deepStrictEqual(yield* routingOf(postId), {
          via: { kind: "fallback", reason: "timeout" },
          recipients: [lead],
        });
        assert.strictEqual(yield* statusOf(lead), "pending");
        assert.deepStrictEqual(probe.woken, [lead]);
        assert.strictEqual(yield* elapsed, SquireJevRouter.JEV_DEADLINE_MS);
        assert.deepStrictEqual(yield* jev.nextDeadlineAt, Option.none());
        assert.deepStrictEqual(
          (yield* logRows("room.routing-fallback")).map((row) => row.data.reason),
          ["timeout"],
        );
      }).pipe(Effect.provide(router(probe, () => Effect.never)));
    }).pipe(Effect.provide(stores));
  });

  it.effect("a late answer after the timeout is logged and ignored", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* seed;
      const gate = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const jev = yield* SquireJevRouter.SquireJevRouting;
        yield* jev.begin({ postId, fundingGeneration: 1 });
        yield* TestClock.adjust(SquireJevRouter.JEV_DEADLINE_MS);
        yield* jev.timeoutDue(yield* DateTime.now);
        yield* Deferred.succeed(gate, undefined);
        yield* jev.drain;
      }).pipe(
        Effect.provide(
          router(probe, () => Deferred.await(gate).pipe(Effect.as(answer(research, 0.95)))),
        ),
      );
      assert.deepStrictEqual(yield* routingOf(postId), {
        via: { kind: "fallback", reason: "timeout" },
        recipients: [lead],
      });
      assert.isNull(yield* statusOf(research));
      assert.strictEqual(yield* statusOf(lead), "pending");
      assert.deepStrictEqual(probe.woken, [lead]);
      assert.strictEqual((yield* logRows("room.routed")).length, 0);
      assert.isTrue(probe.logs.some((line) => line.includes("ignored")));
    }).pipe(Effect.provide(Layer.mergeAll(stores, captureLogs(probe))));
  });

  it.effect("a restart inside the deadline asks again under the same request id only", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* seed;
      // The first process asks, then stops before any answer.
      const firstAsked = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const jev = yield* SquireJevRouter.SquireJevRouting;
        yield* jev.begin({ postId, fundingGeneration: 1 });
        yield* Deferred.await(firstAsked);
      }).pipe(
        Effect.provide(
          router(probe, () =>
            Deferred.succeed(firstAsked, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      );
      assert.strictEqual(probe.requests.length, 1);
      assert.strictEqual(yield* statusOf(lead), "deferred");

      yield* TestClock.adjust(2_000);
      const asked = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const jev = yield* SquireJevRouter.SquireJevRouting;
        yield* jev.resumePending;
        yield* Deferred.await(asked);
        // A second resume while the request is in flight asks nothing.
        yield* jev.resumePending;
        yield* Deferred.succeed(gate, undefined);
        yield* jev.drain;
      }).pipe(
        Effect.provide(
          router(probe, () =>
            Deferred.succeed(asked, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as(answer(research, 0.9)),
            ),
          ),
        ),
      );
      assert.deepStrictEqual(
        probe.requests.map((request) => [request.requestId, request.runId]),
        [
          [`squire-route:${KEY}`, `squire-route:${KEY}`],
          [`squire-route:${KEY}`, `squire-route:${KEY}`],
        ],
      );
      assert.strictEqual(yield* statusOf(research), "pending");
      assert.strictEqual(yield* statusOf(lead), "dropped");
    }).pipe(Effect.provide(stores));
  });

  it.effect("a restart past the deadline or while unfunded falls back without asking", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* seed;
      yield* Effect.flatMap(SquireJevRouter.SquireJevRouting, (jev) => jev.resumePending).pipe(
        Effect.provide(
          router(
            probe,
            () => Effect.succeed(answer(research, 0.9)),
            Effect.succeed({ available: false, reason: "unfunded" }),
          ),
        ),
      );
      assert.strictEqual(probe.requests.length, 0);
      assert.deepStrictEqual(yield* routingOf(postId), {
        via: { kind: "fallback", reason: "unfunded" },
        recipients: [lead],
      });
      assert.strictEqual(yield* statusOf(lead), "pending");
    }).pipe(Effect.provide(stores));
  });
  it.effect("asks for at most six members", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* seed;
      const repository = yield* SquireRepository.SquireRepository;
      const rooms = yield* SquireRoomStore.SquireRoomStore;
      for (let n = 1; n <= 6; n++) {
        const id = SquireId.make(`squire:extra-${n}`);
        yield* repository.createSquire(squireRow(id, { name: `Extra ${n}` }));
        yield* rooms.addMember({
          room_id: roomId,
          member_kind: "squire",
          member_id: id,
          read_cursor: 0,
          user_seen_cursor: null,
        });
      }
      yield* Effect.gen(function* () {
        const jev = yield* SquireJevRouter.SquireJevRouting;
        yield* jev.begin({ postId, fundingGeneration: 1 });
        yield* jev.drain;
      }).pipe(Effect.provide(router(probe, () => Effect.succeed(answer(research, 0.9)))));
      assert.deepStrictEqual(
        probe.requests[0]!.members.map((member) => member.name),
        ["Release", "Research", "Extra 1", "Extra 2", "Extra 3", "Extra 4"],
      );
    }).pipe(Effect.provide(stores));
  });

  it.effect("a room with no candidate member falls back without asking", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* seed;
      const rooms = yield* SquireRoomStore.SquireRoomStore;
      for (const member of [release, research]) {
        yield* rooms.removeMember({
          roomId,
          member: { member_kind: "squire", member_id: member },
        });
      }
      yield* Effect.gen(function* () {
        const jev = yield* SquireJevRouter.SquireJevRouting;
        yield* jev.begin({ postId, fundingGeneration: 1 });
        yield* jev.drain;
      }).pipe(Effect.provide(router(probe, () => Effect.succeed(answer("lead", 0.9)))));
      assert.strictEqual(probe.requests.length, 0);
      assert.deepStrictEqual(yield* routingOf(postId), {
        via: { kind: "fallback", reason: "invalid" },
        recipients: [lead],
      });
      assert.deepStrictEqual(probe.woken, [lead]);
    }).pipe(Effect.provide(stores));
  });
});

const environmentId = EnvironmentId.make("jev-test");
const funding = (
  overrides: Partial<ExtensionFundingStatusResult> = {},
): ExtensionFundingStatusResult => ({
  featureId: "squires",
  environmentId,
  state: "active",
  generation: 7,
  accountLabel: "Synthetic",
  eligible: true,
  reason: "eligible",
  allowance: null,
  remoteRevocationPending: false,
  ...overrides,
});
const routedResult = (
  request: SquireJevRouter.JevRouteRequest,
  choice: string,
  confidence: number,
): SquireRoutingResult => ({
  requestId: request.requestId,
  runId: request.runId,
  templateVersion: "squire-routing-v1",
  policyVersion: "squire-routing-v1",
  model: "extensions-v1",
  judgments: [{ choice, confidence, noReplyConfidence: 0.05 }],
  inputTokens: 100,
  allowance: {
    poolId: "pool",
    basis: "subscription",
    windowStart: "2026-11-01T00:00:00.000Z",
    windowEnd: "2026-12-01T00:00:00.000Z",
    limitInputTokens: 1000,
    usedInputTokens: 100,
    reservedInputTokens: 0,
    remainingInputTokens: 900,
    byFeature: [{ featureId: "squires", usedInputTokens: 100, reservedInputTokens: 0 }],
  },
  replayed: false,
});

type CloudStub = Partial<
  Pick<ExtensionsCloudClient.ExtensionsCloudClient["Service"], "localStatus" | "route">
>;

const liveRelay = (cloud: CloudStub) =>
  SquireJevRouter.layerRelay.pipe(
    Layer.provide(Layer.mock(ExtensionsCloudClient.ExtensionsCloudClient)(cloud)),
  );

/** The router over the live relay, with the cloud client stubbed at its edge. */
const liveRouter = (probe: Probe, route: CloudStub["route"] & {}) =>
  SquireJevRouter.layerRouting.pipe(
    Layer.provide(liveRelay({ route })),
    Layer.provide(
      Layer.mock(SquireDelivery.SquireDelivery)({
        wake: (squireId) => Effect.sync(() => void probe.woken.push(squireId)),
      }),
    ),
  );

const availabilityOf = (layer: Layer.Layer<SquireJevRouter.SquireJevRelay>) =>
  Effect.flatMap(SquireJevRouter.SquireJevRelay, (relay) => relay.availability).pipe(
    Effect.provide(layer),
  );

describe("SquireJevRouter.layerRelay", () => {
  it.effect.each([
    { label: "active", status: funding(), expected: { available: true, fundingGeneration: 7 } },
    {
      label: "unfunded",
      status: funding({ state: "unfunded", eligible: false, reason: "unavailable" }),
      expected: { available: false, reason: "unfunded" },
    },
    {
      label: "pending",
      status: funding({ state: "pending", eligible: false, reason: "unavailable" }),
      expected: { available: false, reason: "pending" },
    },
    {
      label: "revoked",
      status: funding({ state: "revoked", eligible: false, reason: "unavailable" }),
      expected: { available: false, reason: "revoked" },
    },
    {
      label: "unavailable",
      status: funding({ state: "unavailable", eligible: false, reason: "unavailable" }),
      expected: { available: false, reason: "unavailable" },
    },
    {
      label: "active but ineligible",
      status: funding({ eligible: false, reason: "not-paid" }),
      expected: { available: false, reason: "unavailable" },
    },
  ] as const)("availability: $label", ({ status, expected }) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* availabilityOf(
          liveRelay({
            localStatus: (feature) =>
              feature === "squires" ? Effect.succeed(status) : Effect.die("wrong feature"),
          }),
        ),
        expected,
      );
    }),
  );

  it.effect("availability is unavailable when the stored status cannot be read", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* availabilityOf(
          liveRelay({
            localStatus: () =>
              Effect.fail(new ContextualError({ code: "unavailable", message: "store offline" })),
          }),
        ),
        { available: false, reason: "unavailable" },
      );
    }),
  );

  it.effect("without the cloud client the live relay is unfunded", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* availabilityOf(SquireJevRouter.layerRelay), {
        available: false,
        reason: "unfunded",
      });
    }),
  );

  it.effect("a valid Jev answer retargets, and the request carries P19.4 state only", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* seed;
      yield* Effect.gen(function* () {
        const jev = yield* SquireJevRouter.SquireJevRouting;
        yield* jev.begin({ postId, fundingGeneration: 1 });
        yield* jev.drain;
      }).pipe(
        Effect.provide(
          liveRouter(probe, (request) =>
            Effect.sync(() => {
              probe.requests.push(request);
              return routedResult(request, research, 0.9);
            }),
          ),
        ),
      );
      assert.deepStrictEqual(yield* routingOf(postId), {
        via: { kind: "jev", confidence: 0.9, noReplyNeeded: false, shownToLead: false },
        recipients: [research],
      });
      assert.strictEqual(yield* statusOf(lead), "dropped");
      assert.strictEqual(yield* statusOf(research), "pending");
      assert.deepStrictEqual(probe.woken, [research]);

      const request = probe.requests[0]!;
      // The relay refuses anything beyond the contract, so the request must decode strictly.
      yield* decodeRoutingRequest(request, {
        onExcessProperty: "error",
      });
      assert.strictEqual(request.featureId, "squires");
      assert.strictEqual(request.templateVersion, "squire-routing-v1");
      assert.deepStrictEqual(request.post, { body: POST_BODY });
      const [releaseState, researchState] = request.members;
      assert.strictEqual(releaseState!.name, "Release");
      assert.strictEqual(releaseState!.brief.length, 500);
      assert.deepStrictEqual(releaseState!.scope.containers, ["billing-service"]);
      assert.strictEqual(releaseState!.scope.threadTitles.length, 20);
      assert.include(releaseState!.recentActivity, "Invoice rounding is off by a cent");
      assert.deepStrictEqual(researchState!.scope.pullRequests, [318]);
      const body = JSON.stringify(request);
      assert.notInclude(body, OTHER_BODY);
      assert.notInclude(body, "TRANSCRIPT-LIKE");
    }).pipe(Effect.provide(stores));
  });

  it.effect("a `lead` answer wakes the Lead", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* seed;
      yield* Effect.gen(function* () {
        const jev = yield* SquireJevRouter.SquireJevRouting;
        yield* jev.begin({ postId, fundingGeneration: 1 });
        yield* jev.drain;
      }).pipe(
        Effect.provide(
          liveRouter(probe, (request) => Effect.succeed(routedResult(request, "lead", 0.9))),
        ),
      );
      assert.deepStrictEqual((yield* routingOf(postId)).recipients, [lead]);
      assert.strictEqual(yield* statusOf(lead), "pending");
      assert.deepStrictEqual(probe.woken, [lead]);
    }).pipe(Effect.provide(stores));
  });

  it.effect.each(["rate-limited", "allowance", "error", "invalid"] as const)(
    "a %s route failure falls back to the Lead at once",
    (reason) => {
      const probe = newProbe();
      return Effect.gen(function* () {
        const postId = yield* seed;
        yield* Effect.gen(function* () {
          const jev = yield* SquireJevRouter.SquireJevRouting;
          yield* jev.begin({ postId, fundingGeneration: 1 });
          yield* jev.drain;
        }).pipe(
          Effect.provide(
            liveRouter(probe, () =>
              Effect.fail(new ExtensionsCloudClient.ExtensionsRouteError({ reason })),
            ),
          ),
        );
        assert.deepStrictEqual(yield* routingOf(postId), {
          via: { kind: "fallback", reason },
          recipients: [lead],
        });
        assert.strictEqual(yield* statusOf(lead), "pending");
        assert.deepStrictEqual(probe.woken, [lead]);
        assert.deepStrictEqual(
          (yield* logRows("room.routing-fallback")).map((row) => row.data.reason),
          [reason],
        );
        assert.strictEqual(yield* elapsed, 0);
      }).pipe(Effect.provide(stores));
    },
  );

  it.effect("a route that never answers falls back at the 5 s deadline", () => {
    const probe = newProbe();
    return Effect.gen(function* () {
      const postId = yield* seed;
      yield* Effect.gen(function* () {
        const jev = yield* SquireJevRouter.SquireJevRouting;
        yield* jev.begin({ postId, fundingGeneration: 1 });
        yield* TestClock.adjust(SquireJevRouter.JEV_DEADLINE_MS);
        yield* jev.timeoutDue(yield* DateTime.now);
      }).pipe(Effect.provide(liveRouter(probe, () => Effect.never)));
      assert.deepStrictEqual(yield* routingOf(postId), {
        via: { kind: "fallback", reason: "timeout" },
        recipients: [lead],
      });
      assert.strictEqual(yield* statusOf(lead), "pending");
      assert.deepStrictEqual(probe.woken, [lead]);
    }).pipe(Effect.provide(stores));
  });
});
