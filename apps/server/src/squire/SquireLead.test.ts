/**
 * The Lead's first run and event set (7.1, 7.2): `open` queues onboarding
 * once with a bounded scan and the client's timezone; `squire_propose_squire`
 * raises proposals that only the user turns into Squires; the Lead wakes
 * only for decision items its Squires raise or resolve.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  isUnknownUnionMember,
  MessageId,
  type OrchestrationV2Run,
  ProjectId,
  SquireCardPayload,
  SquireCreateInput,
  SquireEvent,
  SquireFakeScript,
  SquireFixtureScenario,
  type SquireId,
  ThreadId,
  type UnknownUnionMember,
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
import * as SquireActions from "./SquireActions.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import * as SquireLeadOnboarding from "./SquireLeadOnboarding.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireTools from "./SquireTools.ts";
import { barToolCalls, withBarTimeline } from "./testkit/barHarness.ts";
import fake00 from "./testdata/fake/00-lead-onboarding.json" with { type: "json" };
import scenario00 from "./testdata/scenarios/00-lead-onboarding.json" with { type: "json" };
import {
  initRepo,
  scripted,
  scriptedModel,
  seedProject,
  tempRoot,
} from "./testkit/lifecycleHarness.ts";
import { type Phase4Services, phase4Layer } from "./testkit/phase4Harness.ts";

const billing = ProjectId.make("billing-service");
const observatory = ProjectId.make("observatory");
const invoice = ThreadId.make("thr_fix_invoice_rounding");
const catalog = ThreadId.make("thr_build_star_catalog");
const TRANSCRIPT = "TRANSCRIPT-SENTINEL the assistant's private reasoning";

const decodeCreateInput = Schema.decodeSync(SquireCreateInput);
const decodeEventJson = Schema.decodeUnknownSync(Schema.fromJsonString(SquireEvent));
const decodePayloadJson = Schema.decodeUnknownSync(Schema.fromJsonString(SquireCardPayload));

type KnownEvent = Exclude<SquireEvent, UnknownUnionMember<"type">>;
const eventOf = <T extends KnownEvent["type"]>(json: string, type: T) => {
  const event = decodeEventJson(json);
  if (isUnknownUnionMember(event) || event.type !== type) throw new Error(`not ${type}: ${json}`);
  return event as Extract<KnownEvent, { readonly type: T }>;
};
type KnownPayload = Exclude<SquireCardPayload, UnknownUnionMember<"type">>;
const proposalOf = (json: string) => {
  const payload = decodePayloadJson(json);
  if (isUnknownUnionMember(payload) || payload.type !== "squire-proposal") {
    throw new Error(`not a Squire proposal: ${json}`);
  }
  return payload as Extract<KnownPayload, { readonly type: "squire-proposal" }>;
};
const decodeScenario = Schema.decodeUnknownSync(SquireFixtureScenario);
const decodeFake = Schema.decodeUnknownSync(SquireFakeScript);

const need = <I, S>(tag: Context.Key<I, S>) =>
  Effect.map(Effect.serviceOption(tag), Option.getOrThrow);

interface Home {
  readonly squireId: SquireId;
  readonly homeThreadId: ThreadId;
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

type Services =
  | Phase4Services
  | SquireLeadOnboarding.SquireLeadOnboarding
  | SquireService.SquireService
  | Scope.Scope;

/** Two projects with a thread each, and the Lead. */
const withLead = <A, E>(body: (lead: Home) => Effect.Effect<A, E, Services>) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    return yield* Effect.gen(function* () {
      yield* seedProject(billing, initRepo(`${root}/billing-service`));
      yield* seedProject(observatory, initRepo(`${root}/observatory`));
      yield* createThread(invoice, billing, "Fix invoice rounding");
      yield* createThread(catalog, observatory, "Build the star catalog");
      const service = yield* need(SquireService.SquireService);
      const onboarding = yield* need(SquireLeadOnboarding.SquireLeadOnboarding);
      const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
      return yield* body({ squireId: lead.id, homeThreadId: lead.homeThreadId! }).pipe(
        Effect.provideService(SquireLeadOnboarding.SquireLeadOnboarding, onboarding),
        Effect.provideService(SquireService.SquireService, service),
      );
    }).pipe(Effect.scoped, Effect.provide(phase4Layer(baseDir)), Effect.orDie);
  }).pipe(Effect.scoped);

const leadRow = (squireId: SquireId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    Effect.map(repository.getSquire(squireId), Option.getOrThrow),
  );

const eventsOf = (squireId: SquireId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository.listEventsByStatus({
      squireId,
      statuses: ["pending", "batched", "delivered", "dropped"],
    }),
  );

const open = (requestId: string, timezone?: string) =>
  Effect.gen(function* () {
    const onboarding = yield* SquireLeadOnboarding.SquireLeadOnboarding;
    const result = yield* onboarding.open({
      requestId,
      ...(timezone === undefined ? {} : { timezone }),
    });
    yield* (yield* need(SquireDelivery.SquireDelivery)).drain;
    return result;
  });

let runCounter = 0;
/** A home-thread run whose message id carries `origin`, as delivery would. */
const homeRun = (homeThreadId: ThreadId, origin: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const key = `${origin}-${++runCounter}`;
    yield* withSquireDispatchOrigin(
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`test:home:${key}`),
        threadId: homeThreadId,
        messageId: MessageId.make(`message:squire:${origin}:${key}`),
        text: "Events.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
      }),
    );
  });

const callTool = (home: Home, name: string, args: unknown, role: "squire" | "lead" = "lead") =>
  Effect.flatMap(need(SquireTools.SquireTools), (tools) =>
    tools.call({ squireId: home.squireId, role, threadId: home.homeThreadId }, name, args),
  );

const proposal = (name: string, project: string, extra: Record<string, unknown> = {}) => ({
  name,
  brief: `${name}: done means CI green and PR approved.`,
  scope: [{ kind: "project", name: project }],
  reason: `${project} has an open PR.`,
  ...extra,
});

const createRelease = Effect.gen(function* () {
  const service = yield* SquireService.SquireService;
  const squire = yield* service.create(
    decodeCreateInput({
      requestId: "release",
      homeProjectId: billing,
      providerInstanceId: scripted,
      modelSelection: scriptedModel,
      name: "Release",
      brief: "",
      grants: [{ kind: "project", targetId: billing }],
      events: {},
      permissions: {},
      budgets: {},
    }),
  );
  return { squireId: squire.id, homeThreadId: squire.homeThreadId! } satisfies Home;
});

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

/** A user turn on `threadId` whose assistant reply is `reply`, run to its end. */
const userTurn = (threadId: ThreadId, reply: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const messageId = MessageId.make(`message:${threadId}:turn`);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${threadId}:turn`),
      threadId,
      messageId,
      text: `Fix it.\n\`\`\`scripted\n${JSON.stringify([{ assistantText: reply }])}\n\`\`\``,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    let afterSequence = 0;
    for (;;) {
      yield* worker.drain();
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs.find(
        (candidate: OrchestrationV2Run) => candidate.userMessageId === messageId,
      );
      if (run !== undefined && TERMINAL.has(run.status)) return run;
      const next = yield* orchestrator
        .streamStoredEventsFrom({ threadId, afterSequence, eventType: "run.updated" })
        .pipe(Stream.runHead);
      afterSequence = Option.getOrThrow(next).sequence;
    }
  });

describe("SquireLeadOnboarding.open (7.1)", () => {
  it.effect("queues onboarding once across retries and reopens, and keeps the first timezone", () =>
    withLead((lead) =>
      Effect.gen(function* () {
        const first = yield* open("open-1", "America/Los_Angeles");
        const retry = yield* open("open-1", "America/Los_Angeles");
        const reopen = yield* open("open-2", "Europe/Berlin");
        assert.deepStrictEqual(first, { squireId: lead.squireId, onboardingQueued: true });
        assert.isTrue(retry.onboardingQueued);
        assert.isFalse(reopen.onboardingQueued);
        const onboarding = (yield* eventsOf(lead.squireId)).filter(
          (row) => row.kind === "onboarding",
        );
        assert.lengthOf(onboarding, 1);

        const row = yield* leadRow(lead.squireId);
        assert.strictEqual(row.timezone, "America/Los_Angeles");
        assert.isNotNull(row.onboarded_at);
        // D31: capturing the zone never turns the digest on.
        assert.isNull(row.digest_json);
        const service = yield* SquireService.SquireService;
        const view = Option.getOrThrow(yield* service.get(lead.squireId));
        assert.strictEqual(view.timezone, "America/Los_Angeles");
        assert.isNull(view.digest);
      }),
    ),
  );

  it.effect("ignores an unknown zone and fills it from a later client", () =>
    withLead((lead) =>
      Effect.gen(function* () {
        yield* open("open-1", "Mars/Olympus_Mons");
        assert.isUndefined((yield* leadRow(lead.squireId)).timezone ?? undefined);
        yield* open("open-2", "Asia/Tokyo");
        assert.strictEqual((yield* leadRow(lead.squireId)).timezone, "Asia/Tokyo");
      }),
    ),
  );

  it.effect("scans projects, titles, status, and activity, bounded, and never transcripts", () =>
    withLead((lead) =>
      Effect.gen(function* () {
        yield* userTurn(invoice, TRANSCRIPT);
        for (let i = 0; i < 10; i++) {
          yield* createThread(ThreadId.make(`thr_extra_${i}`), billing, `Extra thread ${i}`);
        }
        yield* open("open-1");
        const row = (yield* eventsOf(lead.squireId)).find((event) => event.kind === "onboarding");
        assert.notInclude(row!.payload_json!, "TRANSCRIPT-SENTINEL");
        assert.notInclude(row!.payload_json!, "Fix it.");
        const event = eventOf(row!.payload_json!, "onboarding");
        const projects = event.context!.projects;
        const billingScan = projects.find((project) => project.projectId === billing)!;
        assert.strictEqual(billingScan.threadCount, 11);
        assert.lengthOf(billingScan.threads, 8);
        assert.isNotNull(billingScan.lastActivityAt);
        // The Lead's own home thread is not a user thread.
        assert.notInclude(
          projects.flatMap((project) => project.threads.map((thread) => thread.threadId)),
          lead.homeThreadId,
        );
        const observatoryScan = projects.find((project) => project.projectId === observatory)!;
        assert.deepStrictEqual(
          observatoryScan.threads.map((thread) => [thread.title, thread.status]),
          [["Build the star catalog", "idle"]],
        );
      }),
    ),
  );

  it.effect("a Lead waiting for a provider keeps onboarding pending", () =>
    withLead((lead) =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        yield* repository.updateSquire({
          id: lead.squireId,
          patch: { lifecycle: "needs_provider" },
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        const result = yield* open("open-1", "UTC");
        assert.isTrue(result.onboardingQueued);
        assert.deepStrictEqual(
          (yield* eventsOf(lead.squireId)).map((row) => `${row.kind}:${row.status}`),
          ["onboarding:pending"],
        );
      }),
    ),
  );
});

describe("squire_propose_squire (7.1)", () => {
  it.effect("raises recommend-only proposals by whole project that never wake the Lead", () =>
    withLead((lead) =>
      Effect.gen(function* () {
        const tools = yield* need(SquireTools.SquireTools);
        const names = tools.definitions("lead").map((definition) => definition.name);
        assert.include(names, "squire_propose_squire");
        assert.notInclude(names, "squire_get_detail");
        assert.notInclude(
          tools.definitions("squire").map((definition) => definition.name),
          "squire_propose_squire",
        );

        yield* homeRun(lead.homeThreadId, "event");
        const raised = yield* callTool(
          lead,
          "squire_propose_squire",
          proposal("Release", "billing-service", {
            permissions: { steer: "auto", createThread: "auto" },
          }),
        );
        assert.isFalse(raised.isError, raised.text);
        const unknown = yield* callTool(
          lead,
          "squire_propose_squire",
          proposal("Ghost", "nowhere"),
        );
        assert.isTrue(unknown.isError);
        const gold = yield* callTool(
          lead,
          "squire_propose_squire",
          proposal("Gilded", "observatory", { companion: { palette: "gold" } }),
        );
        assert.isTrue(gold.isError);
        const twice = yield* callTool(
          lead,
          "squire_propose_squire",
          proposal("Release", "billing-service", { reason: "again" }),
        );
        assert.isTrue(twice.isError);
        const fromSquire = yield* callTool(
          lead,
          "squire_propose_squire",
          proposal("Sneaky", "billing-service"),
          "squire",
        );
        assert.isTrue(fromSquire.isError);

        const repository = yield* SquireRepository.SquireRepository;
        const [card, ...others] = yield* repository.listCards({ squireId: lead.squireId });
        assert.lengthOf(others, 0);
        assert.strictEqual(card!.kind, "proposal");
        assert.strictEqual(card!.status, "open");
        assert.strictEqual(card!.owner_squire_id, lead.squireId);
        assert.strictEqual(card!.project_id, billing);
        assert.isNull(card!.target_thread_id);
        const payload = proposalOf(card!.payload_json);
        assert.deepStrictEqual(payload.grants, [{ kind: "project", targetId: billing }]);
        // The Lead asked for Auto; only the user raises a proposal past Recommend.
        assert.deepStrictEqual(payload.permissions, {
          steer: "recommend",
          createThread: "recommend",
          notify: "on",
        });
        assert.notStrictEqual(payload.companion.palette, "gold");
        // D29: the Lead's own proposals never wake it.
        assert.lengthOf(yield* eventsOf(lead.squireId), 0);
      }),
    ),
  );

  it.effect("Accept all creates exactly the proposed Squires; Skip creates none", () =>
    withLead((lead) =>
      Effect.gen(function* () {
        yield* homeRun(lead.homeThreadId, "event");
        for (const [name, project] of [
          ["Release", "billing-service"],
          ["Research", "observatory"],
          ["Steward", "billing-service"],
        ] as const) {
          const result = yield* callTool(lead, "squire_propose_squire", proposal(name, project));
          assert.isFalse(result.isError, result.text);
        }
        const repository = yield* SquireRepository.SquireRepository;
        const [release, research, steward] = yield* repository.listCards({
          squireId: lead.squireId,
        });
        const actions = yield* need(SquireActions.SquireActions);
        const accepted = yield* actions.act({
          requestId: "accept-all",
          cardIds: [release!.id, research!.id],
          action: "accept",
        });
        assert.deepStrictEqual(
          accepted.results.map((result) => result.error),
          [null, null],
          JSON.stringify(accepted.results),
        );
        const skipped = yield* actions.act({
          requestId: "skip",
          cardIds: [steward!.id],
          action: "dismiss",
        });
        assert.strictEqual(skipped.results[0]!.status, "dismissed");
        // A retried Accept all is the same request: still exactly one Squire per card.
        yield* actions.act({
          requestId: "accept-all",
          cardIds: [release!.id, research!.id],
          action: "accept",
        });

        const service = yield* SquireService.SquireService;
        const squires = (yield* service.list).filter((squire) => squire.role === "squire");
        assert.deepStrictEqual(squires.map((squire) => squire.name).toSorted(), [
          "Release",
          "Research",
        ]);
        const created = squires.find((squire) => squire.name === "Research")!;
        assert.deepStrictEqual(
          created.grants.map((grant) => [grant.kind, grant.targetId]),
          [["project", observatory]],
        );
        assert.deepStrictEqual(created.permissions, {
          steer: "recommend",
          createThread: "recommend",
          notify: "on",
        });
        assert.notStrictEqual(created.companion.palette, "gold");
      }),
    ),
  );

  it.effect("gives each proposal in a batch a look no Squire or other proposal has", () =>
    withLead((lead) =>
      Effect.gen(function* () {
        yield* createRelease;
        yield* homeRun(lead.homeThreadId, "event");
        const service = yield* SquireService.SquireService;
        const taken = (yield* service.list).map((squire) => squire.companion);
        // The Lead names Release's exact look for the last one; it still gets its own.
        const releaseLook = taken.find((companion) => companion.palette !== "gold")!;
        for (const [name, extra] of [
          ["Alpha", {}],
          ["Beta", {}],
          ["Gamma", {}],
          ["Delta", { companion: { ...releaseLook, presence: "emblem" } }],
        ] as const) {
          const result = yield* callTool(
            lead,
            "squire_propose_squire",
            proposal(name, "billing-service", extra),
          );
          assert.isFalse(result.isError, result.text);
        }
        const repository = yield* SquireRepository.SquireRepository;
        const proposed = (yield* repository.listCards({ squireId: lead.squireId })).map(
          (card) => proposalOf(card.payload_json).companion,
        );
        assert.lengthOf(proposed, 4);
        const looks = [...taken, ...proposed].map((c) => `${c.appearance}/${c.hood}/${c.palette}`);
        assert.strictEqual(new Set(looks).size, looks.length, looks.join(", "));
        assert.isFalse(proposed.some((c) => c.palette === "gold"));
        // Free appearance and hood first: Lead, Release, and the first two take all four.
        assert.strictEqual(
          new Set([...taken, ...proposed.slice(0, 2)].map((c) => `${c.appearance}/${c.hood}`)).size,
          4,
        );
        assert.deepStrictEqual(
          proposed.slice(0, 3).map((c) => c.presence),
          ["figure", "figure", "figure"],
        );
        // A replaced look keeps the Lead's other choices.
        assert.strictEqual(proposed[3]!.presence, "emblem");
      }),
    ),
  );
});

describe("The Lead's event set (7.2, D29)", () => {
  it.effect("wakes for its Squires' decision items only, never FYIs or its own items", () =>
    withLead((lead) =>
      Effect.gen(function* () {
        const release = yield* createRelease;
        yield* homeRun(release.homeThreadId, "event");
        const steer = yield* callTool(
          release,
          "squire_recommend_steer",
          {
            threadId: invoice,
            reason: "CI failed on test_rounding.",
            steer: "Fix the rounding test, then push.",
          },
          "squire",
        );
        assert.isFalse(steer.isError, steer.text);
        yield* callTool(
          release,
          "squire_notify",
          { threadId: invoice, message: "Waiting on you." },
          "squire",
        );
        yield* homeRun(lead.homeThreadId, "event");
        yield* callTool(lead, "squire_propose_squire", proposal("Research", "observatory"));

        const repository = yield* SquireRepository.SquireRepository;
        const [steerCard] = yield* repository.listCards({
          squireId: release.squireId,
          kinds: ["steer"],
        });
        const [ownProposal] = yield* repository.listCards({ squireId: lead.squireId });
        const actions = yield* need(SquireActions.SquireActions);
        yield* actions.act({
          requestId: "dismiss-steer",
          cardIds: [steerCard!.id],
          action: "dismiss",
        });
        yield* actions.act({
          requestId: "dismiss-own",
          cardIds: [ownProposal!.id],
          action: "dismiss",
        });

        const rows = yield* eventsOf(lead.squireId);
        assert.deepStrictEqual(
          rows.map((row) => row.kind),
          ["item-raised", "item-resolved"],
        );
        // Items, never thread history: the row names the card and its thread.
        const raised = eventOf(rows[0]!.payload_json!, "item-raised");
        assert.deepStrictEqual(raised, {
          type: "item-raised",
          cardId: steerCard!.id,
          squireId: release.squireId,
          cardKind: "steer",
          title: steerCard!.title,
          targetThreadId: invoice,
        });
      }),
    ),
  );
});

/**
 * The scenario's effects from the action log (P14.2). Not `barObserve`, whose
 * proposal targets are thread proposals.
 */
const logEffects = (squireId: SquireId) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const rows = yield* repository.listActionLog({ squireId, limit: 10_000 });
    const cards = new Map<string, string>();
    const effects: Record<string, number> = {};
    const bump = (name: string) => (effects[name] = (effects[name] ?? 0) + 1);
    for (const row of rows) {
      const data = JSON.parse(row.data_json) as { kind?: string; action?: string };
      if (row.kind === "card.created" && row.card_id !== null && data.kind !== undefined) {
        cards.set(row.card_id, data.kind);
      }
      if (row.kind === "action.held") bump("action_held");
      if (row.kind === "event.received") bump("delivered_events");
      if (row.kind === "action.executed" && data.action === "steer") bump("steer_sent");
      if (row.kind === "action.executed" && data.action === "create_thread") {
        bump("thread_created");
      }
    }
    for (const kind of cards.values()) {
      if (kind === "steer") bump("card_created");
      if (kind === "proposal") bump("proposal_created");
    }
    return effects;
  });

describe("00-lead-onboarding on the fake (7.1)", () => {
  const scenario = decodeScenario(scenario00);
  const fake = decodeFake(fake00);

  it.effect("one onboarding turn proposes three Squires by whole project", () =>
    withBarTimeline(
      scenario,
      ({ loaded }) =>
        Effect.gen(function* () {
          const expected = scenario.expected!;
          const effects = yield* logEffects(loaded.squireId);
          const calls = yield* barToolCalls(loaded.homeThreadId);
          assert.deepStrictEqual(
            calls.map((call) => call.name).filter((name) => !expected.ignore.includes(name)),
            expected.toolCalls,
          );
          assert.strictEqual(effects.delivered_events, expected.deliveredEvents);
          for (const [name, want] of Object.entries(expected.effects)) {
            assert.strictEqual(effects[name] ?? 0, want, name);
          }
          for (const name of expected.mustNotHappen)
            assert.strictEqual(effects[name] ?? 0, 0, name);
          const repository = yield* SquireRepository.SquireRepository;
          const cards = yield* repository.listCards({ squireId: loaded.squireId });
          const grants = cards.map((card) => {
            const payload = proposalOf(card.payload_json);
            return [payload.name, payload.grants.map((grant) => grant.targetId)];
          });
          const billingId = loaded.projects["billing-service"]!;
          const observatoryId = loaded.projects["Observatory"]!;
          assert.deepStrictEqual(grants, [
            ["Release", [billingId]],
            ["Research", [observatoryId]],
            ["Steward", [billingId, observatoryId]],
          ]);
        }),
      { fake, timeline: [] },
    ),
  );
});
