/**
 * Lead control and Squire-store accept executors on the switch-on Squire layer over a real orchestrator.
 * A crash is the layer's scope closing; a restart builds it again over the same home.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  SquireCardId,
  SquireCreateInput,
  type SquireId,
  ThreadId,
} from "@lecturn/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SquireActions from "./SquireActions.ts";
import {
  decodeSquireActionIntent,
  encodeSquireActionIntent,
  isSquireStoreIntent,
  squireActionCommandId,
  squireProposalRequestId,
} from "./squireActionIntent.ts";
import * as SquireControl from "./SquireControl.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
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
const tracked = ThreadId.make("thr_fix_invoice_rounding");
const second = ThreadId.make("thr_tax_rounding");
const decodeCreateInput = Schema.decodeUnknownSync(SquireCreateInput);

const need = <I, S>(tag: Context.Key<I, S>) =>
  Effect.map(Effect.serviceOption(tag), Option.getOrThrow);
const repo = need(SquireRepository.SquireRepository);

interface Team {
  readonly leadId: SquireId;
  readonly leadHome: ThreadId;
  /** Project grant on billing-service: tracks both threads. */
  readonly release: SquireId;
  /** Thread grant on `tracked` only. */
  readonly research: SquireId;
}

type Body<A, E> = Effect.Effect<A, E, Phase4Services | Scope.Scope>;

// The server's 5 s backstop would run holds on its own as the test clock moves.
const noTicks = Layer.succeed(
  Scheduler.Scheduler,
  Scheduler.Scheduler.of({ register: () => Effect.void }),
);

/** One server lifetime over `baseDir`; its scope closing is a crash. */
const lifetime = <A, E>(baseDir: string, body: Body<A, E>) =>
  body.pipe(
    Effect.scoped,
    Effect.provide(phase4Layer(baseDir, { scheduler: noTicks })),
    Effect.orDie,
  );

let runCounter = 0;
/** An event-origin run on a home thread, so tool calls read as event turns. */
const homeRun = (homeThreadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const key = `event-${++runCounter}`;
    yield* withSquireDispatchOrigin(
      threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`test:home:${key}`),
        threadId: homeThreadId,
        messageId: MessageId.make(`message:squire:event:${key}`),
        text: "Events.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
      }),
    );
  });

const createSquire = (requestId: string, name: string, grant: { kind: string; targetId: string }) =>
  Effect.flatMap(need(SquireService.SquireService), (service) =>
    service.create(
      decodeCreateInput({
        requestId,
        homeProjectId: homeProject,
        providerInstanceId: scripted,
        modelSelection: scriptedModel,
        name,
        brief: "",
        grants: [grant],
        events: {},
        permissions: {},
        budgets: {},
      }),
    ),
  );

const seed = (root: string) =>
  Effect.gen(function* () {
    yield* seedProject(homeProject, initRepo(`${root}/billing-service`));
    const threads = yield* ThreadManagement.ThreadManagementService;
    for (const [threadId, title] of [
      [tracked, "Fix invoice rounding"],
      [second, "Fix tax rounding"],
    ] as const) {
      yield* threads.dispatch({
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
      });
    }
    const release = yield* createSquire("release", "Release", {
      kind: "project",
      targetId: homeProject,
    });
    const research = yield* createSquire("research", "Research", {
      kind: "thread",
      targetId: tracked,
    });
    const lead = Option.getOrThrow(
      yield* (yield* need(SquireService.SquireService)).ensureLead({ requestId: "lead" }),
    );
    yield* homeRun(lead.homeThreadId!);
    return {
      leadId: lead.id,
      leadHome: lead.homeThreadId!,
      release: release.id,
      research: research.id,
    } satisfies Team;
  });

const withTeam = <A, E>(body: (team: Team) => Body<A, E>) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    return yield* lifetime(baseDir, Effect.flatMap(seed(root), body));
  }).pipe(Effect.scoped);

const setManage = (team: Team, level: "off" | "recommend" | "auto") =>
  Effect.gen(function* () {
    yield* (yield* repo).updateSquire({
      id: team.leadId,
      patch: {
        permissions_json: JSON.stringify({
          steer: "recommend",
          createThread: "recommend",
          notify: "on",
          manageSquires: level,
        }),
      },
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

let reasonCounter = 0;
/** A Lead tool call; each gets its own reason so no two share an invocation key. */
const leadCall = (team: Team, tool: string, args: Record<string, unknown>) =>
  Effect.flatMap(need(SquireTools.SquireTools), (tools) =>
    tools.call({ squireId: team.leadId, role: "lead", threadId: team.leadHome }, tool, {
      reason: `Keeps the queue clean (${++reasonCounter}).`,
      ...args,
    }),
  );

const cardIdOf = (result: SquireTools.SquireToolResult) => {
  assert.isFalse(result.isError, result.text);
  return SquireCardId.make((result.structuredContent as { cardId: string }).cardId);
};

const actions = need(SquireActions.SquireActions);
const control = need(SquireControl.SquireControl);
const executeDue = Effect.flatMap(actions, (service) => service.executeDue);
const reconcileStartup = Effect.flatMap(actions, (service) => service.reconcileStartup);
let actCounter = 0;
const accept = (cardIds: ReadonlyArray<SquireCardId>, requestId = `act-${++actCounter}`) =>
  Effect.flatMap(actions, (service) =>
    service.act({ requestId, cardIds: [...cardIds], action: "accept" }),
  );
const dismiss = (cardId: SquireCardId) =>
  Effect.flatMap(actions, (service) =>
    service.act({ requestId: `act-${++actCounter}`, cardIds: [cardId], action: "dismiss" }),
  );

const cardOf = (cardId: SquireCardId) =>
  Effect.flatMap(repo, (repository) =>
    repository.getCard(cardId).pipe(Effect.map(Option.getOrThrow)),
  );
const squireOf = (squireId: SquireId) =>
  Effect.flatMap(repo, (repository) =>
    repository.getSquire(squireId).pipe(Effect.map(Option.getOrThrow)),
  );
const grantKeys = (squireId: SquireId) =>
  Effect.flatMap(repo, (repository) =>
    repository
      .listGrants(squireId)
      .pipe(Effect.map((rows) => rows.map((row) => `${row.kind}:${row.target_id}`).toSorted())),
  );
const leadCards = (team: Team) =>
  Effect.flatMap(repo, (repository) => repository.listCards({ squireId: team.leadId }));

const logOf = (squireId: SquireId) =>
  Effect.gen(function* () {
    const rows = yield* (yield* repo).listActionLog({ squireId, limit: 500 });
    return rows.map((row) => ({ ...row, data: JSON.parse(row.data_json) as Record<string, any> }));
  });
const executionsFor = (team: Team, cardId: SquireCardId) =>
  Effect.map(logOf(team.leadId), (log) =>
    log.filter((row) => row.kind === "action.executed" && row.card_id === cardId),
  );
const onlyExecution = (team: Team, cardId: SquireCardId) =>
  Effect.map(executionsFor(team, cardId), (rows) => {
    assert.lengthOf(rows, 1);
    return rows[0]!;
  });

/** An open merge proposal, as the Lead recorded one before the merge tool was retired. */
const seedMergeProposal = (team: Team, itemIds: ReadonlyArray<SquireCardId>, name: string) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const id = SquireCardId.make(`card:proposal:merge:${name}`);
    yield* (yield* repo).insertCard({
      id,
      squire_id: team.leadId,
      owner_squire_id: team.leadId,
      kind: "proposal",
      status: "open",
      target_thread_id: null,
      project_id: null,
      title: "Merge duplicate items",
      why: "Two Squires raised the same item.",
      payload_json: JSON.stringify({
        type: "control",
        action: "merge",
        squireId: null,
        cardIds: itemIds,
      }),
      evidence_json: "{}",
      trigger_json: "{}",
      intent_json: null,
      origin: "lead",
      steer_kind: null,
      routed_task_id: null,
      rule_id: null,
      finding_key: null,
      escalate_at: null,
      opened_at: null,
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
    return id;
  });

/** An open steer item raised by `squireId` on `threadId`, as a Squire turn writes one. */
const seedItem = (squireId: SquireId, threadId: ThreadId, name: string) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const id = SquireCardId.make(`card:steer:${name}`);
    yield* (yield* repo).insertCard({
      id,
      squire_id: squireId,
      owner_squire_id: squireId,
      kind: "steer",
      status: "open",
      target_thread_id: threadId,
      project_id: homeProject,
      title: `Rerun api-e2e (${name})`,
      why: "api-e2e failed.",
      payload_json: JSON.stringify({
        type: "steer",
        threadId,
        steer: "Rerun api-e2e.",
        steerKind: "rerun-checks",
      }),
      evidence_json: "{}",
      trigger_json: "{}",
      intent_json: null,
      origin: "event",
      steer_kind: "rerun-checks",
      routed_task_id: null,
      rule_id: null,
      finding_key: null,
      escalate_at: null,
      opened_at: null,
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
    return id;
  });

/** A Lead-raised card of another kind, as onboarding, overlap, or inactivity writes it. */
const seedLeadCard = (
  team: Team,
  name: string,
  kind: "proposal" | "overlap" | "fyi",
  payload: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const id = SquireCardId.make(`card:${kind}:${team.leadId}:${name}`);
    yield* (yield* repo).insertCard({
      id,
      squire_id: team.leadId,
      owner_squire_id: team.leadId,
      kind,
      status: "open",
      target_thread_id: null,
      project_id: kind === "proposal" ? homeProject : null,
      title: name,
      why: "Recent activity fits.",
      payload_json: JSON.stringify(payload),
      evidence_json: "{}",
      trigger_json: "{}",
      intent_json: null,
      origin: "lead",
      steer_kind: null,
      routed_task_id: null,
      rule_id: null,
      finding_key: null,
      escalate_at: null,
      opened_at: null,
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
    return id;
  });

const squireProposal = {
  type: "squire-proposal",
  name: "Docs",
  brief: "Keeps the docs in step with releases.",
  grants: [{ kind: "project", targetId: homeProject }],
  permissions: { steer: "recommend", createThread: "recommend", notify: "on" },
  companion: { palette: "sage", hood: "up", equipment: "grimoire" },
};

const advance = (seconds: number) => TestClock.adjust(`${seconds} seconds`);

const revert = (logEntryId: number, requestId: string) =>
  Effect.flatMap(control, (service) => service.revert({ requestId, logEntryId }));

describe("Lead control in every Manage Squires cell (P8, P17.6)", () => {
  it.effect("Off refuses every control tool and raises nothing", () =>
    withTeam((team) =>
      Effect.gen(function* () {
        yield* setManage(team, "off");
        const item = yield* seedItem(team.release, tracked, "off");
        const calls = [
          leadCall(team, "squire_pause", { squireId: team.research }),
          leadCall(team, "squire_resume", { squireId: team.research }),
          leadCall(team, "squire_rescope", { squireId: team.release, grants: [] }),
          leadCall(team, "squire_forward_item", { itemId: item, toSquireId: team.research }),
        ];
        for (const call of calls) {
          const result = yield* call;
          assert.isTrue(result.isError);
          assert.include(result.text, "Manage Squires is Off");
        }
        assert.lengthOf(yield* leadCards(team), 0);
        assert.strictEqual((yield* squireOf(team.research)).status, "active");
      }),
    ),
  );

  it.effect("Recommend: each action is a proposal item; accepting it runs it once", () =>
    withTeam((team) =>
      Effect.gen(function* () {
        yield* setManage(team, "recommend");

        const pause = cardIdOf(yield* leadCall(team, "squire_pause", { squireId: team.research }));
        assert.strictEqual((yield* cardOf(pause)).status, "open");
        assert.strictEqual((yield* cardOf(pause)).kind, "proposal");
        assert.strictEqual((yield* squireOf(team.research)).status, "active");
        const raised = (yield* logOf(team.leadId)).find(
          (row) => row.kind === "card.created" && row.card_id === pause,
        );
        assert.deepStrictEqual(raised?.data.before, { status: "active" });
        const [accepted] = (yield* accept([pause])).results;
        assert.strictEqual(accepted!.status, "resolved");
        assert.strictEqual((yield* squireOf(team.research)).status, "paused");
        assert.deepStrictEqual((yield* onlyExecution(team, pause)).data.before, {
          status: "active",
        });

        const resume = cardIdOf(
          yield* leadCall(team, "squire_resume", { squireId: team.research }),
        );
        yield* accept([resume]);
        assert.strictEqual((yield* squireOf(team.research)).status, "active");

        // Narrowing: exclude the tax thread from Release's project grant.
        const rescope = cardIdOf(
          yield* leadCall(team, "squire_rescope", {
            squireId: team.release,
            grants: [{ kind: "project", targetId: homeProject }],
            exclusions: [second],
          }),
        );
        yield* accept([rescope]);
        assert.deepStrictEqual(yield* grantKeys(team.release), [
          `exclusion:${second}`,
          `project:${homeProject}`,
        ]);

        const item = yield* seedItem(team.release, tracked, "recommend-forward");
        const forward = cardIdOf(
          yield* leadCall(team, "squire_forward_item", { itemId: item, toSquireId: team.research }),
        );
        yield* accept([forward]);
        const moved = yield* cardOf(item);
        assert.strictEqual(moved.squire_id, team.research);
        assert.strictEqual(moved.owner_squire_id, team.research);
        assert.strictEqual(moved.status, "open");

        const duplicate = yield* seedItem(team.release, tracked, "recommend-duplicate");
        const merge = yield* seedMergeProposal(team, [item, duplicate], "recommend");
        yield* accept([merge]);
        assert.strictEqual((yield* cardOf(item)).status, "open");
        assert.strictEqual((yield* cardOf(duplicate)).status, "outdated");
        assert.strictEqual((yield* cardOf(duplicate)).resolution, "superseded");

        // A retried accept of an executed proposal runs nothing again.
        yield* accept([merge]);
        for (const cardId of [pause, resume, rescope, forward, merge]) {
          assert.lengthOf(yield* executionsFor(team, cardId), 1);
        }
      }),
    ),
  );

  it.effect("Recommend refuses forwards outside the target's scope", () =>
    withTeam((team) =>
      Effect.gen(function* () {
        yield* setManage(team, "recommend");
        const onTax = yield* seedItem(team.release, second, "out-of-scope");
        const forward = yield* leadCall(team, "squire_forward_item", {
          itemId: onTax,
          toSquireId: team.research,
        });
        assert.isTrue(forward.isError);
        assert.include(forward.text, "scope does not cover");
        assert.lengthOf(yield* leadCards(team), 0);
      }),
    ),
  );

  it.effect(
    "Auto: narrowing actions hold and run after the undo window; widening is a proposal",
    () =>
      withTeam((team) =>
        Effect.gen(function* () {
          yield* setManage(team, "auto");
          // The permission intersection covers thread classes only: a recommend-only Squire does
          // not lower the Lead's own Manage Squires.
          const pause = cardIdOf(
            yield* leadCall(team, "squire_pause", { squireId: team.research }),
          );
          const narrow = cardIdOf(
            yield* leadCall(team, "squire_rescope", {
              squireId: team.release,
              grants: [{ kind: "project", targetId: homeProject }],
              exclusions: [second],
            }),
          );
          const widen = cardIdOf(
            yield* leadCall(team, "squire_rescope", {
              squireId: team.research,
              grants: [
                { kind: "thread", targetId: tracked },
                { kind: "thread", targetId: second },
              ],
            }),
          );
          assert.strictEqual((yield* cardOf(pause)).status, "held");
          assert.strictEqual((yield* cardOf(narrow)).status, "held");
          assert.strictEqual((yield* cardOf(widen)).status, "open");

          yield* advance(9);
          yield* executeDue;
          assert.strictEqual((yield* squireOf(team.research)).status, "active");

          yield* advance(2);
          yield* executeDue;
          yield* executeDue;
          assert.strictEqual((yield* cardOf(pause)).status, "executed");
          assert.strictEqual((yield* squireOf(team.research)).status, "paused");
          assert.strictEqual((yield* cardOf(narrow)).status, "executed");
          assert.include(yield* grantKeys(team.release), `exclusion:${second}`);
          assert.lengthOf(yield* executionsFor(team, pause), 1);
          assert.lengthOf(yield* executionsFor(team, narrow), 1);
          assert.deepStrictEqual(yield* grantKeys(team.research), [`thread:${tracked}`]);
          assert.lengthOf(yield* executionsFor(team, widen), 0);

          // The widening rescope runs only on the user's accept.
          yield* accept([widen]);
          assert.deepStrictEqual(yield* grantKeys(team.research), [
            `thread:${tracked}`,
            `thread:${second}`,
          ]);
        }),
      ),
  );

  it.effect("Auto: a hold re-checks at execution; Recommend by then leaves a proposal", () =>
    withTeam((team) =>
      Effect.gen(function* () {
        yield* setManage(team, "auto");
        const pause = cardIdOf(yield* leadCall(team, "squire_pause", { squireId: team.research }));
        yield* setManage(team, "recommend");
        yield* advance(11);
        yield* executeDue;
        assert.strictEqual((yield* cardOf(pause)).status, "open");
        assert.strictEqual((yield* squireOf(team.research)).status, "active");
        yield* accept([pause]);
        assert.strictEqual((yield* squireOf(team.research)).status, "paused");
      }),
    ),
  );
});

describe("squire.control.revert (P17.6)", () => {
  it.effect("each revert restores the before-state, once per request", () =>
    withTeam((team) =>
      Effect.gen(function* () {
        yield* setManage(team, "recommend");
        const run = (tool: string, args: Record<string, unknown>) =>
          Effect.gen(function* () {
            const cardId = cardIdOf(yield* leadCall(team, tool, args));
            yield* accept([cardId]);
            return (yield* onlyExecution(team, cardId)).id;
          });

        const paused = yield* run("squire_pause", { squireId: team.research });
        assert.strictEqual((yield* revert(paused, "revert-pause")).squire.status, "active");
        // The same request again is the same answer; another request refuses.
        assert.strictEqual((yield* revert(paused, "revert-pause")).squire.status, "active");
        const twice = yield* Effect.flip(revert(paused, "revert-pause-again"));
        assert.strictEqual(twice.code, "invalid_request");
        assert.strictEqual((yield* squireOf(team.research)).status, "active");

        yield* (yield* need(SquireService.SquireService)).setStatus({
          requestId: "pause-research",
          squireId: team.research,
          status: "paused",
        });
        const resumed = yield* run("squire_resume", { squireId: team.research });
        assert.strictEqual((yield* squireOf(team.research)).status, "active");
        assert.strictEqual((yield* revert(resumed, "revert-resume")).squire.status, "paused");
        yield* (yield* need(SquireService.SquireService)).setStatus({
          requestId: "resume-research",
          squireId: team.research,
          status: "active",
        });

        const before = yield* grantKeys(team.release);
        const rescoped = yield* run("squire_rescope", {
          squireId: team.release,
          grants: [{ kind: "thread", targetId: tracked }],
        });
        assert.deepStrictEqual(yield* grantKeys(team.release), [`thread:${tracked}`]);
        yield* revert(rescoped, "revert-rescope");
        assert.deepStrictEqual(yield* grantKeys(team.release), before);

        const item = yield* seedItem(team.release, tracked, "revert-forward");
        const forwarded = yield* run("squire_forward_item", {
          itemId: item,
          toSquireId: team.research,
        });
        assert.strictEqual((yield* cardOf(item)).owner_squire_id, team.research);
        const back = yield* revert(forwarded, "revert-forward");
        assert.strictEqual(back.squire.id, team.release);
        assert.strictEqual((yield* cardOf(item)).squire_id, team.release);
        assert.strictEqual((yield* cardOf(item)).owner_squire_id, team.release);

        const duplicate = yield* seedItem(team.research, tracked, "revert-merge");
        const storedMerge = yield* seedMergeProposal(team, [item, duplicate], "revert");
        yield* accept([storedMerge]);
        const merged = (yield* onlyExecution(team, storedMerge)).id;
        assert.strictEqual((yield* cardOf(duplicate)).status, "outdated");
        yield* revert(merged, "revert-merge");
        assert.strictEqual((yield* cardOf(duplicate)).status, "open");
        assert.strictEqual((yield* cardOf(item)).status, "open");

        const reverts = (yield* logOf(team.leadId)).filter(
          (row) => row.kind === "control.reverted",
        );
        assert.deepStrictEqual(
          reverts.map((row) => row.data.logEntryId),
          [paused, resumed, rescoped, forwarded, merged],
        );
      }),
    ),
  );

  it.effect("reverting a forward of a resolved item refuses and changes nothing", () =>
    withTeam((team) =>
      Effect.gen(function* () {
        yield* setManage(team, "recommend");
        const item = yield* seedItem(team.release, tracked, "resolved-forward");
        const forward = cardIdOf(
          yield* leadCall(team, "squire_forward_item", { itemId: item, toSquireId: team.research }),
        );
        yield* accept([forward]);
        const logEntryId = (yield* onlyExecution(team, forward)).id;
        yield* dismiss(item);
        const refused = yield* Effect.flip(revert(logEntryId, "revert-resolved"));
        assert.strictEqual(refused.code, "invalid_request");
        assert.include(refused.message, "no longer open");
        const card = yield* cardOf(item);
        assert.strictEqual(card.owner_squire_id, team.research);
        assert.strictEqual(card.status, "dismissed");
        assert.isFalse((yield* logOf(team.leadId)).some((row) => row.kind === "control.reverted"));
      }),
    ),
  );
});

describe("Squire-store executions across a crash (A9)", () => {
  it.effect("an Auto control survives a crash between hold and execution and applies once", () =>
    Effect.gen(function* () {
      const { root, baseDir } = yield* tempRoot;
      const { team, pause } = yield* lifetime(
        baseDir,
        Effect.gen(function* () {
          const team = yield* seed(root);
          yield* setManage(team, "auto");
          const pause = cardIdOf(
            yield* leadCall(team, "squire_pause", { squireId: team.research }),
          );
          return { team, pause };
        }),
      );
      yield* lifetime(
        baseDir,
        Effect.gen(function* () {
          yield* reconcileStartup;
          assert.strictEqual((yield* cardOf(pause)).status, "held");
          yield* advance(11);
          yield* executeDue;
          yield* executeDue;
          assert.strictEqual((yield* cardOf(pause)).status, "executed");
          assert.strictEqual((yield* squireOf(team.research)).status, "paused");
          assert.lengthOf(yield* executionsFor(team, pause), 1);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a crash after the control committed but before its card settled finalizes once", () =>
    Effect.gen(function* () {
      const { root, baseDir } = yield* tempRoot;
      const { team, pause } = yield* lifetime(
        baseDir,
        Effect.gen(function* () {
          const team = yield* seed(root);
          yield* setManage(team, "auto");
          const pause = cardIdOf(
            yield* leadCall(team, "squire_pause", { squireId: team.research }),
          );
          yield* advance(11);
          const card = yield* cardOf(pause);
          const repository = yield* repo;
          yield* repository.updateCard({
            id: pause,
            fromStatuses: ["held"],
            patch: { status: "executing" },
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          });
          const intent = Option.getOrThrow(decodeSquireActionIntent(card.intent_json));
          assert.isTrue(isSquireStoreIntent(intent));
          if (!isSquireStoreIntent(intent)) return { team, pause };
          const applied = yield* (yield* control).apply(intent, {
            executionKey: card.command_id!,
            now: DateTime.formatIso(yield* DateTime.now),
            verb: "execute",
          });
          assert.isTrue(applied.ok);
          return { team, pause };
        }),
      );
      yield* lifetime(
        baseDir,
        Effect.gen(function* () {
          yield* reconcileStartup;
          yield* executeDue;
          assert.strictEqual((yield* cardOf(pause)).status, "executed");
          assert.strictEqual((yield* squireOf(team.research)).status, "paused");
          assert.lengthOf(yield* executionsFor(team, pause), 1);
        }),
      );
    }).pipe(Effect.scoped),
  );
});

describe("accepting Lead items (P17.2, P17.3, P3.6)", () => {
  const squiresNamed = (name: string) =>
    Effect.flatMap(repo, (repository) =>
      repository.listSquires.pipe(Effect.map((rows) => rows.filter((row) => row.name === name))),
    );

  it.effect(
    "accepting a squire-proposal creates exactly that Squire; a retried accept creates one",
    () =>
      withTeam((team) =>
        Effect.gen(function* () {
          const proposal = yield* seedLeadCard(team, "docs", "proposal", squireProposal);
          const first = yield* accept([proposal], "accept-docs");
          assert.strictEqual(first.results[0]!.status, "resolved");
          assert.isNull(first.results[0]!.error);
          yield* accept([proposal], "accept-docs");
          yield* accept([proposal], "accept-docs-again");
          const [docs, ...more] = yield* squiresNamed("Docs");
          assert.lengthOf(more, 0);
          assert.strictEqual(docs!.home_project_id, homeProject);
          assert.strictEqual(docs!.provider_instance_id, scripted);
          assert.strictEqual(docs!.create_request_id, squireProposalRequestId(proposal, 1));
          assert.deepStrictEqual(yield* grantKeys(docs!.id), [`project:${homeProject}`]);
          const permissions = JSON.parse(docs!.permissions_json);
          assert.strictEqual(permissions.steer, "recommend");
          assert.isUndefined(permissions.manageSquires);
          const execution = yield* onlyExecution(team, proposal);
          assert.strictEqual(execution.data.action, "create_squire");
          assert.strictEqual(execution.data.squireId, docs!.id);
        }),
      ),
  );

  it.effect(
    "a crash after the create committed: the restart finishes the accept with one Squire",
    () =>
      Effect.gen(function* () {
        const { root, baseDir } = yield* tempRoot;
        const { team, proposal } = yield* lifetime(
          baseDir,
          Effect.gen(function* () {
            const team = yield* seed(root);
            const proposal = yield* seedLeadCard(team, "docs-crash", "proposal", squireProposal);
            const requestId = squireProposalRequestId(proposal, 1);
            const input = decodeCreateInput({
              requestId,
              homeProjectId: homeProject,
              providerInstanceId: scripted,
              modelSelection: scriptedModel,
              name: squireProposal.name,
              brief: squireProposal.brief,
              grants: squireProposal.grants,
              events: {},
              permissions: squireProposal.permissions,
              budgets: {},
              companion: squireProposal.companion,
            });
            const { requestId: _, ...fields } = input;
            // As an accept leaves the card once its create committed.
            yield* (yield* repo).updateCard({
              id: proposal,
              fromStatuses: ["open"],
              patch: {
                status: "accepting",
                attempt: 1,
                command_id: squireActionCommandId("accept", proposal, 1),
                intent_json: encodeSquireActionIntent({
                  type: "squire-create",
                  input: fields,
                  requestId,
                }),
              },
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            });
            yield* (yield* need(SquireService.SquireService)).create(input);
            return { team, proposal };
          }),
        );
        yield* lifetime(
          baseDir,
          Effect.gen(function* () {
            yield* reconcileStartup;
            assert.strictEqual((yield* cardOf(proposal)).status, "resolved");
            assert.lengthOf(yield* squiresNamed("Docs"), 1);
            assert.lengthOf(yield* executionsFor(team, proposal), 1);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("the inactivity check: accept is Keep, dismiss is Pause (P3.6)", () =>
    withTeam((team) =>
      Effect.gen(function* () {
        const fyi = {
          type: "fyi",
          source: "inactivity",
          text: "Keep Squire triggers running?",
          threadId: null,
        };
        const kept = yield* seedLeadCard(team, "inactivity:keep", "fyi", fyi);
        assert.strictEqual((yield* accept([kept])).results[0]!.status, "resolved");
        assert.isNull((yield* squireOf(team.leadId)).automation_paused_at);

        const paused = yield* seedLeadCard(team, "inactivity:pause", "fyi", fyi);
        assert.strictEqual((yield* dismiss(paused)).results[0]!.status, "dismissed");
        assert.isNotNull((yield* squireOf(team.leadId)).automation_paused_at);
      }),
    ),
  );

  it.effect("accepting an overlap item resolves it without dispatching anything", () =>
    withTeam((team) =>
      Effect.gen(function* () {
        const overlap = yield* seedLeadCard(team, "overlap", "overlap", {
          type: "overlap",
          repository: "github.com/acme/billing",
          threads: [
            { threadId: tracked, squireId: team.release, branch: null, provider: "scripted" },
            { threadId: second, squireId: team.research, branch: null, provider: "scripted" },
          ],
          paths: ["src/invoice/InvoiceTotals.ts"],
          recommendation: "Land Fix invoice rounding first.",
        });
        const [result] = (yield* accept([overlap])).results;
        assert.strictEqual(result!.status, "resolved");
        const card = yield* cardOf(overlap);
        assert.strictEqual(card.resolution, "accepted");
        assert.isNull(card.command_id);
        assert.lengthOf(yield* executionsFor(team, overlap), 0);
      }),
    ),
  );
});
