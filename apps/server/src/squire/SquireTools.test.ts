/**
 * Squire role tools on the server's switch-on Squire layer over a
 * real orchestrator. A tool call's run is the home thread's active run, so
 * each test starts one with the origin it needs.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  ProjectId,
  SquireCreateInput,
  SquireEvent,
  type SquireId,
  SquireRuleId,
  SquireVoiceNoteId,
  ThreadId,
} from "@lecturn/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import { SquireEventPayloadJson } from "./squireEvents.ts";
import { squireCardRowFields } from "./SquireItems.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireTools from "./SquireTools.ts";
import {
  claude,
  initRepo,
  scripted,
  scriptedModel,
  seedProject,
  tempRoot,
} from "./testkit/lifecycleHarness.ts";
import { type Phase4Services, phase4Layer } from "./testkit/phase4Harness.ts";

const homeProject = ProjectId.make("billing-service");
const otherProject = ProjectId.make("observatory");
const fixtureProject = ProjectId.make("fixture-billing");
const tracked = ThreadId.make("thr_fix_invoice_rounding");
const untracked = ThreadId.make("thr_untracked");
const decodeCreateInput = Schema.decodeSync(SquireCreateInput);
const decodeSteerArgs = Schema.decodeUnknownSync(SquireTools.SquireSteerArgs);

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

/** A Release Squire tracking `billing-service`, with one tracked and one untracked thread. */
const withSquire = <A, E>(
  body: (home: Home) => Effect.Effect<A, E, Phase4Services | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    return yield* Effect.gen(function* () {
      yield* seedProject(homeProject, initRepo(`${root}/billing-service`));
      yield* seedProject(otherProject, initRepo(`${root}/observatory`));
      yield* seedProject(fixtureProject, initRepo(`${baseDir}/squire-fixtures/billing`));
      yield* createThread(tracked, homeProject, "Fix invoice rounding");
      yield* createThread(untracked, otherProject, "Star catalog");
      const service = yield* need(SquireService.SquireService);
      const squire = yield* service.create(
        decodeCreateInput({
          requestId: "release",
          homeProjectId: homeProject,
          providerInstanceId: scripted,
          modelSelection: scriptedModel,
          name: "Release",
          brief: "",
          grants: [
            { kind: "project", targetId: homeProject },
            { kind: "project", targetId: fixtureProject },
          ],
          events: {},
          permissions: {},
          budgets: {},
        }),
      );
      return yield* body({ squireId: squire.id, homeThreadId: squire.homeThreadId! });
    }).pipe(Effect.scoped, Effect.provide(phase4Layer(baseDir)), Effect.orDie);
  }).pipe(Effect.scoped);

let runCounter = 0;
/** Starts a home-thread run whose message id carries `origin`, as delivery would; `user` has none. */
const homeRun = (homeThreadId: ThreadId, origin: string, batchId?: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const key = batchId ?? `${origin}-${++runCounter}`;
    yield* withSquireDispatchOrigin(
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`test:home:${key}`),
        threadId: homeThreadId,
        messageId: MessageId.make(
          origin === "user" ? `message:user:${key}` : `message:squire:${origin}:${key}`,
        ),
        text: "Events.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: origin === "user" ? "user" : "agent",
        creationSource: "server",
      }),
    );
  });

/** Loads permissions straight to the record, as `loadSetup` does. */
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

const seedUsage = (squireId: SquireId, kind: "steer" | "thread", count: number) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const now = yield* DateTime.now;
    for (let i = 0; i < count; i++) {
      yield* repository.insertBudgetUsage({
        squire_id: squireId,
        thread_id: kind === "steer" ? tracked : null,
        kind,
        room_id: null,
        executed_at: DateTime.formatIso(DateTime.subtract(now, { hours: 3 })),
        execution_key: null,
      });
    }
  });

const callTool = (home: Home, name: string, args: unknown, role: "squire" | "lead" = "squire") =>
  Effect.flatMap(need(SquireTools.SquireTools), (tools) =>
    tools.call({ squireId: home.squireId, role, threadId: home.homeThreadId }, name, args),
  );

const logOf = (squireId: SquireId) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const rows = yield* repository.listActionLog({ squireId, limit: 500 });
    return rows.map((row) => ({ ...row, data: JSON.parse(row.data_json) as Record<string, any> }));
  });
const count = (log: ReadonlyArray<{ readonly kind: string }>, kind: string) =>
  log.filter((row) => row.kind === kind).length;
const decisionOf = (log: ReadonlyArray<{ readonly kind: string; readonly data: any }>) =>
  log.findLast((row) => row.kind === "decision.recorded")?.data;

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SquireEvent));
const encodeEventPayload = Schema.encodeSync(SquireEventPayloadJson);

const cardsOf = (squireId: SquireId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository.listCards({ squireId }),
  );

const steerArgs = {
  threadId: tracked,
  reason: "Session crashed mid-turn: context window exceeded.",
  steer: "Start from the remaining two formatters and keep each change small.",
};

describe("SquireTools", () => {
  it.effect("a user-started turn cannot stay quiet", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* homeRun(home.homeThreadId, "user");
        const refused = yield* callTool(home, "squire_stay_quiet", { reason: "Nothing to do." });
        assert.isTrue(refused.isError);
        assert.strictEqual(count(yield* logOf(home.squireId), "quiet.recorded"), 0);
      }),
    ),
  );

  it.effect("a notify that replaces an open alert says it pushed nothing", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* setPermissions(home.squireId, { notify: "on" });
        yield* homeRun(home.homeThreadId, "event");
        const first = yield* callTool(home, "squire_notify", {
          message: "Waiting on you.",
          threadId: tracked,
        });
        assert.strictEqual(first.text, "Sent to the user.");
        const second = yield* callTool(home, "squire_notify", {
          message: "Still waiting.",
          threadId: tracked,
        });
        assert.include(second.text, "not pushed again");
        assert.strictEqual(count(yield* logOf(home.squireId), "notification.pushed"), 1);
      }),
    ),
  );

  it("decodes a steer without steerKind as other", () => {
    const decoded = decodeSteerArgs(steerArgs);
    assert.strictEqual(decoded.steerKind, "other");
  });

  it.effect("scope: untracked and marked threads are refused for every thread tool", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* homeRun(home.homeThreadId, "event");
        for (const threadId of [untracked, home.homeThreadId]) {
          for (const name of [
            "squire_get_summary",
            "squire_get_detail",
            "squire_recommend_steer",
            "squire_send_steer",
            "squire_notify",
          ]) {
            const result = yield* callTool(home, name, {
              ...steerArgs,
              message: "Heads up.",
              threadId,
            });
            assert.isTrue(result.isError, `${name} on ${threadId}`);
            assert.include(result.text, "out of scope");
          }
        }
        const proposal = yield* callTool(home, "squire_propose_thread", {
          project: otherProject,
          provider: "claudeAgent",
          firstPrompt: "Add a changelog entry.",
          reason: "Merged.",
        });
        assert.isTrue(proposal.isError);
        assert.lengthOf(yield* cardsOf(home.squireId), 0);
      }),
    ),
  );

  it.effect("permission: Off refuses steers, proposals, and notify with a reason, logged", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* setPermissions(home.squireId, { steer: "off", createThread: "off", notify: "off" });
        yield* homeRun(home.homeThreadId, "event");
        const steer = yield* callTool(home, "squire_recommend_steer", steerArgs);
        const send = yield* callTool(home, "squire_send_steer", steerArgs);
        const propose = yield* callTool(home, "squire_create_thread", {
          project: "billing-service",
          provider: "claudeAgent",
          firstPrompt: "Add a changelog entry.",
          reason: "Merged.",
        });
        const notify = yield* callTool(home, "squire_notify", { message: "Waiting on you." });
        for (const result of [steer, send, propose, notify]) assert.isTrue(result.isError);
        assert.include(steer.text, "Steer is Off");
        assert.include(propose.text, "Create thread is Off");
        assert.include(notify.text, "Notify is Off");
        const log = yield* logOf(home.squireId);
        assert.strictEqual(count(log, "tool.called"), 4);
        assert.deepStrictEqual(
          log.filter((row) => row.kind === "decision.recorded").map((row) => row.data.reason),
          ["permission", "permission", "permission", "permission"],
        );
        assert.lengthOf(yield* cardsOf(home.squireId), 0);

        const quiet = yield* callTool(home, "squire_stay_quiet", { reason: "Routine progress." });
        assert.isFalse(quiet.isError);
        assert.strictEqual(count(yield* logOf(home.squireId), "quiet.recorded"), 1);
      }),
    ),
  );

  it.effect("a steer of 280 characters or more is refused with a reason and makes no card", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* homeRun(home.homeThreadId, "event");
        const long = `Pull the api-e2e log and fix the first failing assertion. ${"x".repeat(240)}`;
        for (const name of ["squire_recommend_steer", "squire_send_steer"]) {
          const result = yield* callTool(home, name, { ...steerArgs, steer: long });
          assert.isTrue(result.isError, name);
          assert.include(result.text, "shorten it to one action under 280 characters");
        }
        assert.lengthOf(yield* cardsOf(home.squireId), 0);

        // "Under 280": exactly 280 is refused, 279 is the longest accepted.
        const exact = yield* callTool(home, "squire_recommend_steer", {
          ...steerArgs,
          steer: "y".repeat(SquireTools.SQUIRE_STEER_MAX_CHARS),
        });
        assert.isTrue(exact.isError);
        assert.include(exact.text, "the steer is 280 characters");
        assert.lengthOf(yield* cardsOf(home.squireId), 0);
        const longest = yield* callTool(home, "squire_recommend_steer", {
          ...steerArgs,
          steer: "y".repeat(SquireTools.SQUIRE_STEER_MAX_CHARS - 1),
        });
        assert.isFalse(longest.isError);
        assert.lengthOf(yield* cardsOf(home.squireId), 1);
      }),
    ),
  );

  it.effect("04: an exhausted budget downgrades a send to one pushed card with the caption", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* setPermissions(home.squireId, { steer: "auto" });
        yield* seedUsage(home.squireId, "steer", 10);
        yield* homeRun(home.homeThreadId, "event");
        const result = yield* callTool(home, "squire_send_steer", steerArgs);
        assert.isFalse(result.isError);
        assert.include(result.text, "Recorded as a recommendation card");
        assert.include(result.text, "budget reached, recommending only until ");

        const [card, ...more] = yield* cardsOf(home.squireId);
        assert.lengthOf(more, 0);
        assert.strictEqual(card!.kind, "steer");
        assert.strictEqual(card!.status, "open");
        assert.strictEqual(card!.target_thread_id, tracked);
        assert.strictEqual(card!.steer_kind, "other");
        const log = yield* logOf(home.squireId);
        assert.strictEqual(decisionOf(log).reason, "budget");
        const created = log.find((row) => row.kind === "card.created")!;
        assert.strictEqual(created.data.kind, "steer");
        assert.match(created.data.caption, /^budget reached, recommending only until \d{4}-/);
        assert.strictEqual(count(log, "notification.pushed"), 1);
        // The mobile row is the relay's to write, after this transaction.
        assert.strictEqual(count(log, "notification.delivery"), 0);
        assert.strictEqual(count(log, "action.held"), 0);
        assert.strictEqual(count(log, "action.executed"), 0);
      }),
    ),
  );

  it.effect("budget per tool: the caption counts what is left, or names the exhausted window", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* seedUsage(home.squireId, "steer", 3);
        yield* seedUsage(home.squireId, "thread", 3);
        yield* homeRun(home.homeThreadId, "event");
        const steer = yield* callTool(home, "squire_recommend_steer", steerArgs);
        assert.include(steer.text, "7 of 10 steers left today");
        const proposal = yield* callTool(home, "squire_propose_thread", {
          project: "billing-service",
          provider: "claudeAgent",
          firstPrompt: "Add a changelog entry.",
          reason: "Merged.",
        });
        assert.isFalse(proposal.isError);
        assert.include(proposal.text, "budget reached, recommending only until");
      }),
    ),
  );

  it.effect("06: a voice-origin send is a card labeled voice, decided for voice, never held", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* setPermissions(home.squireId, { steer: "auto" });
        yield* homeRun(home.homeThreadId, "voice");
        const result = yield* callTool(home, "squire_send_steer", steerArgs);
        assert.isFalse(result.isError);
        const [card] = yield* cardsOf(home.squireId);
        assert.strictEqual(card!.origin, "voice");
        const log = yield* logOf(home.squireId);
        assert.strictEqual(decisionOf(log).reason, "voice");
        assert.strictEqual(count(log, "action.held"), 0);
        assert.strictEqual(count(log, "action.executed"), 0);
        assert.strictEqual(count(log, "notification.pushed"), 1);
      }),
    ),
  );

  it.effect("a voice turn's card says whether the note's speaker was verified", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        yield* repository.insertEvent({
          squire_id: home.squireId,
          thread_id: null,
          kind: "voice-note",
          state_key: "voice-note-1",
          payload_json: encodeEvent({
            type: "voice-note",
            voiceNoteId: SquireVoiceNoteId.make("voice-note-1"),
            transcript: "Tell the rounding thread to start over.",
            speakerVerified: false,
            source: "plaud",
          }),
          status: "batched",
          defer_reason: null,
          not_before: "2026-11-01T10:00:00.000Z",
          batch_id: "voice-batch-1",
          created_at: "2026-11-01T10:00:00.000Z",
        });
        yield* homeRun(home.homeThreadId, "voice", "voice-batch-1");
        assert.isFalse((yield* callTool(home, "squire_send_steer", steerArgs)).isError);
        const [voiced] = yield* cardsOf(home.squireId);
        assert.strictEqual(voiced!.origin, "voice");
        assert.strictEqual(squireCardRowFields(voiced!).speakerVerified, false);
      }),
    ),
  );

  it.effect("a steer answering a PR transition in its batch keeps that transition", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const change = (transition: string, id: number) =>
          repository.insertEvent({
            squire_id: home.squireId,
            thread_id: tracked,
            kind: "pull-request-changed",
            state_key: `github.com/acme/billing-service#321:sha1:${transition}`,
            payload_json: encodeEventPayload({
              outcome: null,
              runId: null,
              pendingRequest: null,
              pullRequest: {
                host: "github.com",
                repository: "acme/billing-service",
                number: 321,
                url: "https://github.com/acme/billing-service/pull/321",
                headSha: "sha1",
                transition,
                state: "open",
                title: "Fix invoice rounding",
                headBranch: "fix/rounding",
                baseBranch: "main",
                checksState: "failing",
                reviewDecision: null,
                mergeability: "mergeable",
                threadSelfWatching: false,
              },
            }),
            status: "batched",
            defer_reason: null,
            not_before: "2026-11-01T10:00:00.000Z",
            batch_id: "pr-batch-1",
            created_at: `2026-11-01T10:00:0${id}.000Z`,
          });
        yield* change("checks:failed", 1);
        yield* change("mergeable:mergeable", 2);
        yield* homeRun(home.homeThreadId, "event", "pr-batch-1");
        const sent = yield* callTool(home, "squire_send_steer", {
          ...steerArgs,
          steerKind: "rerun-checks",
        });
        assert.isFalse(sent.isError, sent.text);
        const [card] = yield* cardsOf(home.squireId);
        // The newest change is mergeability; a rerun-checks steer answers the checks.
        assert.deepInclude(JSON.parse(card!.trigger_json), {
          prKey: "github.com/acme/billing-service#321",
          headSha: "sha1",
          transition: "checks:failed",
        });
      }),
    ),
  );

  it.effect("webhook- and message-origin sends are cards labeled by origin", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* setPermissions(home.squireId, { steer: "auto" });
        yield* homeRun(home.homeThreadId, "webhook");
        assert.isFalse((yield* callTool(home, "squire_send_steer", steerArgs)).isError);
        const [card] = yield* cardsOf(home.squireId);
        assert.strictEqual(card!.origin, "webhook");
        assert.notProperty(squireCardRowFields(card!), "speakerVerified");
        assert.strictEqual(decisionOf(yield* logOf(home.squireId)).reason, "origin");
      }),
    ),
  );

  it.effect("a call with no run to bind to only recommends, never as the user", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* setPermissions(home.squireId, { steer: "auto" });
        assert.isFalse((yield* callTool(home, "squire_send_steer", steerArgs)).isError);
        const [card] = yield* cardsOf(home.squireId);
        assert.strictEqual(card!.status, "open");
        assert.notStrictEqual(card!.origin, "user");
        const log = yield* logOf(home.squireId);
        assert.strictEqual(decisionOf(log).reason, "origin");
        assert.strictEqual(count(log, "action.held"), 0);
        const called = log.find((row) => row.kind === "tool.called");
        assert.strictEqual(called!.data.origin, "unknown");
      }),
    ),
  );

  it.effect("a run the user's own message started acts as the user", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* setPermissions(home.squireId, { steer: "auto" });
        yield* homeRun(home.homeThreadId, "user");
        assert.isFalse((yield* callTool(home, "squire_send_steer", steerArgs)).isError);
        const [card] = yield* cardsOf(home.squireId);
        assert.strictEqual(card!.origin, "user");
        assert.strictEqual(card!.status, "held");
      }),
    ),
  );

  it.effect("a Test turn's card never pushes, and its notify is refused", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* homeRun(home.homeThreadId, "test");
        assert.isFalse((yield* callTool(home, "squire_send_steer", steerArgs)).isError);
        const notify = yield* callTool(home, "squire_notify", { message: "Done." });
        assert.isTrue(notify.isError);
        const [card] = yield* cardsOf(home.squireId);
        assert.strictEqual(card!.origin, "test");
        const log = yield* logOf(home.squireId);
        assert.strictEqual(count(log, "notification.pushed"), 0);
        assert.strictEqual(count(log, "notification.delivery"), 0);
      }),
    ),
  );

  it.effect.each(["event", "voice"])("a matching allow rule on a %s turn", (origin) =>
    withSquire((home) =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const ruleId = SquireRuleId.make("rule-rerun");
        yield* repository.insertRule({
          id: ruleId,
          squire_id: home.squireId,
          effect: "allow",
          action_class: "steer",
          target_kind: "thread",
          target_id: tracked,
          steer_kind: "rerun-checks",
          status: "active",
          match_count: 0,
          last_matched_at: null,
          created_at: DateTime.formatIso(yield* DateTime.now),
        });
        yield* homeRun(home.homeThreadId, origin);
        const result = yield* callTool(home, "squire_send_steer", {
          ...steerArgs,
          steerKind: "rerun-checks",
        });
        assert.isFalse(result.isError);
        const [card] = yield* cardsOf(home.squireId);
        assert.strictEqual(card!.steer_kind, "rerun-checks");
        assert.include(card!.intent_json!, '"steerKind":"rerun-checks"');
        const log = yield* logOf(home.squireId);
        assert.strictEqual(count(log, "action.held"), origin === "voice" ? 0 : 1);
        if (origin === "voice") {
          // A rule never applies during a voice turn.
          assert.strictEqual(decisionOf(log).reason, "voice");
          assert.isNull(card!.rule_id);
          assert.strictEqual(count(log, "rule.matched"), 0);
          return;
        }
        // The Auto it raises is a hold, not a card.
        assert.deepStrictEqual(
          [decisionOf(log).level, decisionOf(log).reason, decisionOf(log).ruleId],
          ["auto", "rule", ruleId],
        );
        assert.strictEqual(card!.status, "held");
        assert.strictEqual(card!.rule_id, ruleId);
        assert.strictEqual(count(log, "card.created"), 0);
        assert.strictEqual(count(log, "rule.matched"), 1);
        const rule = Option.getOrThrow(yield* repository.getRule(ruleId));
        assert.strictEqual(rule.match_count, 1);
      }),
    ),
  );

  it.effect("the same invocation key twice is one card and the stored result", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* homeRun(home.homeThreadId, "event");
        const first = yield* callTool(home, "squire_recommend_steer", steerArgs);
        const again = yield* callTool(home, "squire_recommend_steer", { ...steerArgs });
        assert.deepStrictEqual(again, first);
        assert.lengthOf(yield* cardsOf(home.squireId), 1);
        const log = yield* logOf(home.squireId);
        assert.strictEqual(count(log, "tool.called"), 1);
        assert.strictEqual(count(log, "card.created"), 1);
      }),
    ),
  );

  it.effect("a newer steer for the thread updates the open card", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* homeRun(home.homeThreadId, "event");
        yield* callTool(home, "squire_recommend_steer", steerArgs);
        const updated = yield* callTool(home, "squire_recommend_steer", {
          ...steerArgs,
          steer: "Rerun api-e2e first.",
        });
        assert.include(updated.text, "updated 1");
        const cards = yield* cardsOf(home.squireId);
        assert.lengthOf(cards, 1);
        assert.strictEqual(cards[0]!.replaced_count, 1);
        assert.include(cards[0]!.payload_json, "Rerun api-e2e first.");
        // The update is not a second push.
        assert.strictEqual(count(yield* logOf(home.squireId), "notification.pushed"), 1);
      }),
    ),
  );

  it.effect("forbidden and unknown tools are refused and logged", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* homeRun(home.homeThreadId, "event");
        const merge = yield* callTool(home, "lecturn_pull_request_merge", { number: 318 });
        const lead = yield* callTool(home, "squire_get_detail", { threadId: tracked }, "lead");
        assert.isTrue(merge.isError);
        assert.include(merge.text, "not a tool");
        // The credential's role must be the Squire's own.
        assert.isTrue(lead.isError);
        const log = yield* logOf(home.squireId);
        assert.deepStrictEqual(
          log.filter((row) => row.kind === "tool.called").map((row) => row.data.tool),
          ["lecturn_pull_request_merge"],
        );

        // The Lead never reads raw thread history.
        const service = yield* need(SquireService.SquireService);
        const leadSquire = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
        const leadHome = { squireId: leadSquire.id, homeThreadId: leadSquire.homeThreadId! };
        const detail = yield* callTool(
          leadHome,
          "squire_get_detail",
          { threadId: tracked },
          "lead",
        );
        assert.isTrue(detail.isError);
        assert.include(detail.text, "not a tool a Lead can use");
        const summary = yield* callTool(
          leadHome,
          "squire_get_summary",
          { threadId: tracked },
          "lead",
        );
        assert.isFalse(summary.isError);
        assert.strictEqual(count(yield* logOf(leadSquire.id), "tool.called"), 2);
      }),
    ),
  );

  it.effect("a fixture proposal binds the scripted instance; the card shows the proposed one", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* homeRun(home.homeThreadId, "event");
        const proposal = {
          provider: "claudeAgent",
          firstPrompt: "Add a CHANGELOG entry for #318.",
          reason: "PR #318 merged.",
        };
        // A held create stores its launch intent.
        yield* setPermissions(home.squireId, { createThread: "auto" });
        // Into a fixture-owned project.
        yield* callTool(home, "squire_create_thread", { ...proposal, project: fixtureProject });
        // From a normal project: the real provider.
        yield* callTool(home, "squire_create_thread", {
          ...proposal,
          project: "Billing-Service",
          firstPrompt: "Tag the release.",
        });
        const [fixture, live] = yield* cardsOf(home.squireId);
        assert.strictEqual(fixture!.status, "held");
        assert.strictEqual(fixture!.project_id, fixtureProject);
        assert.include(fixture!.payload_json, `"providerInstanceId":"${claude}"`);
        assert.include(fixture!.payload_json, `"provider":"claudeAgent"`);
        assert.include(fixture!.intent_json!, `"instanceId":"${scripted}"`);
        assert.include(live!.intent_json!, `"instanceId":"${claude}"`);
        assert.strictEqual(decisionOf(yield* logOf(home.squireId)).reason, "permission");

        // From a fixture-owned Squire, any project.
        const repository = yield* SquireRepository.SquireRepository;
        yield* repository.updateSquire({
          id: home.squireId,
          patch: { create_request_id: "fixture:Release" },
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* callTool(home, "squire_create_thread", {
          ...proposal,
          project: homeProject,
          firstPrompt: "Bump the version.",
        });
        const cards = yield* cardsOf(home.squireId);
        assert.include(cards.at(-1)!.intent_json!, `"instanceId":"${scripted}"`);
      }),
    ),
  );

  it.effect("a steer card wakes the Lead with an item-raised row", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        const service = yield* need(SquireService.SquireService);
        const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
        yield* homeRun(home.homeThreadId, "event");
        yield* callTool(home, "squire_recommend_steer", steerArgs);
        const notify = yield* callTool(home, "squire_notify", {
          threadId: tracked,
          message: "Waiting on you.",
        });
        assert.isFalse(notify.isError);
        const repository = yield* SquireRepository.SquireRepository;
        const rows = yield* repository.listEventsByStatus({
          squireId: lead.id,
          statuses: ["pending", "batched", "delivered", "dropped"],
        });
        assert.deepStrictEqual(
          rows.map((row) => row.kind),
          ["item-raised"],
        );
        const log = yield* logOf(home.squireId);
        assert.deepStrictEqual(
          log.filter((row) => row.kind === "card.created").map((row) => row.data.kind),
          ["steer", "fyi"],
        );
        assert.strictEqual(count(log, "notification.pushed"), 2);
      }),
    ),
  );

  it.effect("read tools: list, summary, and a bounded, logged detail excerpt", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        const long = "x".repeat(6000);
        yield* trackedTurn(long);
        yield* homeRun(home.homeThreadId, "event");
        const list = yield* callTool(home, "squire_list_tracked", {});
        assert.isFalse(list.isError);
        assert.include(list.text, "Fix invoice rounding");
        assert.notInclude(list.text, "Star catalog");
        const summary = yield* callTool(home, "squire_get_summary", { threadId: tracked });
        assert.isFalse(summary.isError);
        const detail = yield* callTool(home, "squire_get_detail", { threadId: tracked });
        assert.isFalse(detail.isError);
        assert.isAtMost(detail.text.length, SquireTools.SQUIRE_DETAIL_MAX_CHARS);
        assert.include(detail.text, "Fix invoice rounding");
        const log = yield* logOf(home.squireId);
        const detailRow = log.find((row) => row.data.tool === "squire_get_detail")!;
        assert.strictEqual(detailRow.thread_id, tracked);
      }),
    ),
  );

  it.effect("squire.update saves steer Auto; Manage Squires Auto stays refused", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        const service = yield* need(SquireService.SquireService);
        const repository = yield* SquireRepository.SquireRepository;
        const row = Option.getOrThrow(yield* repository.getSquire(home.squireId));
        const saved = yield* service.update({
          requestId: "auto",
          squireId: home.squireId,
          expectedRevision: row.revision,
          permissions: { steer: "auto", createThread: "auto", notify: "on" },
        });
        assert.strictEqual(saved.permissions.steer, "auto");
        assert.strictEqual(saved.permissions.createThread, "auto");
      }),
    ),
  );
});

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

/** A user turn on the tracked thread whose assistant reply is `reply`, run to its end. */
const trackedTurn = (reply: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const messageId = MessageId.make(`message:${tracked}:detail`);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${tracked}:turn:detail`),
      threadId: tracked,
      messageId,
      text: `Fix the rounding.\n\`\`\`scripted\n${JSON.stringify([{ assistantText: reply }])}\n\`\`\``,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    let afterSequence = 0;
    for (;;) {
      yield* worker.drain();
      const projection = yield* orchestrator.getThreadProjection(tracked);
      const run = projection.runs.find(
        (candidate: OrchestrationV2Run) => candidate.userMessageId === messageId,
      );
      if (run !== undefined && TERMINAL.has(run.status)) return run;
      const next = yield* orchestrator
        .streamStoredEventsFrom({ threadId: tracked, afterSequence, eventType: "run.updated" })
        .pipe(Stream.runHead);
      afterSequence = Option.getOrThrow(next).sequence;
    }
  });

/** The Lead over the Release Squire of `withSquire`, whose permissions bound the Lead's. */
const leadOver = Effect.gen(function* () {
  const service = yield* need(SquireService.SquireService);
  const lead = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
  return { squireId: lead.id, homeThreadId: lead.homeThreadId! };
});

const leadSteer = (lead: Home, name: string, steer: string) =>
  callTool(lead, name, { ...steerArgs, steer }, "lead");

/** A second Squire tracking `billing-service`, created at the current (test) time. */
const createBilling = Effect.flatMap(need(SquireService.SquireService), (service) =>
  service.create(
    decodeCreateInput({
      requestId: "billing",
      homeProjectId: homeProject,
      providerInstanceId: scripted,
      modelSelection: scriptedModel,
      name: "Billing",
      brief: "",
      grants: [{ kind: "project", targetId: homeProject }],
      events: {},
      permissions: {},
      budgets: {},
    }),
  ),
);

describe("SquireTools for the Lead", () => {
  it.effect(
    "a Lead steer acts at the lower permission, on the owner's budget, never counted for Auto",
    () =>
      withSquire((home) =>
        Effect.gen(function* () {
          const lead = yield* leadOver;
          yield* setPermissions(lead.squireId, { steer: "auto" });
          yield* homeRun(lead.homeThreadId, "user");

          // The owner is recommend-only, so the Lead cannot escalate past it.
          const lowered = yield* leadSteer(lead, "squire_send_steer", "Rerun api-e2e.");
          assert.isFalse(lowered.isError, lowered.text);
          assert.strictEqual((lowered.structuredContent as any).outcome, "card");
          assert.strictEqual((lowered.structuredContent as any).reason, "intersection");
          assert.strictEqual((lowered.structuredContent as any).ownerSquireId, home.squireId);

          // Both Auto: held, and the Lead's own Auto never makes it a second holder.
          yield* setPermissions(home.squireId, { steer: "auto" });
          const held = yield* leadSteer(lead, "squire_send_steer", "Rebase onto main.");
          assert.strictEqual((held.structuredContent as any).outcome, "held", held.text);

          // The owner's budget, not the Lead's, decides.
          yield* seedUsage(lead.squireId, "steer", 10);
          const leadSpent = yield* leadSteer(lead, "squire_send_steer", "Retry the deploy.");
          assert.strictEqual((leadSpent.structuredContent as any).outcome, "held", leadSpent.text);
          yield* seedUsage(home.squireId, "steer", 10);
          const ownerSpent = yield* leadSteer(lead, "squire_send_steer", "Rerun the lint job.");
          assert.strictEqual((ownerSpent.structuredContent as any).outcome, "card");
          assert.strictEqual((ownerSpent.structuredContent as any).reason, "budget");

          const cards = yield* cardsOf(lead.squireId);
          assert.isAbove(cards.length, 0);
          for (const card of cards) {
            assert.strictEqual(card.squire_id, lead.squireId);
            assert.strictEqual(card.owner_squire_id, home.squireId);
          }
          // An Off owner refuses even a recommendation.
          yield* setPermissions(home.squireId, { steer: "off" });
          const off = yield* leadSteer(lead, "squire_recommend_steer", "Check the flaky test.");
          assert.isTrue(off.isError);
          assert.include(off.text, "Steer is Off for Release");
        }),
      ),
  );

  it.effect("a thread several Squires track resolves to one owner, deterministically", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        // Release was created at the start; Billing a second later.
        yield* TestClock.adjust("1 second");
        const billing = yield* createBilling;
        const lead = yield* leadOver;
        yield* homeRun(lead.homeThreadId, "user");
        // No open item: the earliest-created tracker owns it.
        const first = yield* leadSteer(lead, "squire_recommend_steer", "Rerun api-e2e.");
        assert.strictEqual((first.structuredContent as any).ownerSquireId, home.squireId);

        // An open item of the later Squire makes it the Squire the Lead acts for.
        yield* homeRun(billing.homeThreadId!, "event");
        const raised = yield* callTool(
          { squireId: billing.id, homeThreadId: billing.homeThreadId! },
          "squire_recommend_steer",
          steerArgs,
        );
        assert.isFalse(raised.isError, raised.text);
        const second = yield* leadSteer(lead, "squire_recommend_steer", "Rebase onto main.");
        assert.strictEqual((second.structuredContent as any).ownerSquireId, billing.id);
      }),
    ),
  );

  it.effect("a created_at tie goes to the Squire created first, never to its random id", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        // Same instant as Release (TestClock does not move): only creation order differs.
        const billing = yield* createBilling;
        const repository = yield* SquireRepository.SquireRepository;
        const rows = [home.squireId, billing.id].map((id) => repository.getSquire(id));
        const [release, other] = yield* Effect.all(rows);
        assert.strictEqual(
          Option.getOrThrow(release!).created_at,
          Option.getOrThrow(other!).created_at,
        );
        const lead = yield* leadOver;
        yield* homeRun(lead.homeThreadId, "user");
        const owned = yield* leadSteer(lead, "squire_recommend_steer", "Rerun api-e2e.");
        assert.strictEqual((owned.structuredContent as any).ownerSquireId, home.squireId);
      }),
    ),
  );

  it.effect(
    "the Lead proposes only for one of its Squires, and a sweep finding needs the sweep",
    () =>
      withSquire((home) =>
        Effect.gen(function* () {
          const lead = yield* leadOver;
          yield* homeRun(lead.homeThreadId, "user");
          const proposal = {
            project: "billing-service",
            provider: "claudeAgent",
            firstPrompt: "Add a CHANGELOG entry.",
            reason: "The user asked.",
          };
          const missing = yield* callTool(lead, "squire_propose_thread", proposal, "lead");
          assert.isTrue(missing.isError);
          assert.include(missing.text, "squireId");
          const toLead = yield* callTool(
            lead,
            "squire_propose_thread",
            { ...proposal, squireId: lead.squireId },
            "lead",
          );
          assert.isTrue(toLead.isError);
          assert.include(toLead.text, "not one of your Squires");
          const made = yield* callTool(
            lead,
            "squire_propose_thread",
            { ...proposal, squireId: home.squireId },
            "lead",
          );
          assert.isFalse(made.isError, made.text);
          assert.include(made.text, "for Release");
          // The Lead never creates threads.
          const create = yield* callTool(
            lead,
            "squire_create_thread",
            { ...proposal, squireId: home.squireId },
            "lead",
          );
          assert.include(create.text, "not a tool a Lead can use");
        }),
      ),
  );

  it.effect(
    "a sweep turn's finding is refused unless the sweep admits it, and writes nothing",
    () =>
      withSquire(() =>
        Effect.gen(function* () {
          const lead = yield* leadOver;
          yield* homeRun(lead.homeThreadId, "sweep");
          const finding = yield* leadSteer(lead, "squire_recommend_steer", "Rerun api-e2e.");
          assert.isTrue(finding.isError);
          assert.lengthOf(yield* cardsOf(lead.squireId), 0);
          const log = yield* logOf(lead.squireId);
          assert.strictEqual(count(log, "tool.called"), 1);
        }),
      ),
  );
});
