import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SQUIRE_BUDGETS,
  EventId,
  ProjectId,
  SQUIRE_MAX_ALLOW_RULES,
  SQUIRE_MAX_ASK_FIRST_RULES,
  SQUIRE_RULE_LIMIT_TEXT,
  SquireCardId,
  SquireError,
  SquireId,
  SquirePermissions,
  type SquireRuleCreateInput,
  type SquireRuleOffer,
  type SquireSteerKind,
  ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import { planProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import * as SquireContainers from "./SquireContainers.ts";
import * as squirePolicy from "./squirePolicy.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRules from "./SquireRules.ts";
import * as SquireScope from "./SquireScope.ts";
import { createThread, grantRow, orchestratorLayer, squireRow } from "./testkit/scopeHarness.ts";

const release = SquireId.make("squire:release");
const lead = SquireId.make("squire:lead");
const projectA = ProjectId.make("project:a");
const billing = ProjectId.make("project:billing");
const billingSpace = "space:billing";

const withRules = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      SquireRules.layer.pipe(
        Layer.provideMerge(SquireScope.layer),
        Layer.provideMerge(SquirePolicyLock.layer),
        Layer.provideMerge(SquireRepository.layer),
        Layer.provideMerge(
          SquireContainers.layerTest({
            spaces: [{ spaceId: billingSpace, projectIds: [billing] }],
          }),
        ),
        Layer.provideMerge(orchestratorLayer),
      ),
    ),
  );

const seed = (
  grants: ReadonlyArray<SquireRepository.SquireGrantRow>,
  overrides: Partial<SquireRepository.SquireRow> = {},
) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    yield* repository.createSquire(squireRow(release, { name: "Release", ...overrides }));
    yield* repository.createSquire(squireRow(lead, { role: "lead" }));
    for (const grant of grants) yield* repository.insertGrant(grant);
  });

const input = (
  overrides: Partial<typeof SquireRuleCreateInput.Type> = {},
): typeof SquireRuleCreateInput.Type => ({
  requestId: "request-1",
  squireId: release,
  effect: "allow",
  actionClass: "createThread",
  targetKind: "project",
  targetId: projectA,
  ...overrides,
});

const projectN = (n: number) => `project:${n}`;

const isSquireError = Schema.is(SquireError);
const decodePermissions = Schema.decodeUnknownSync(Schema.fromJsonString(SquirePermissions));

/** The refusal code, or the tag of any other failure so a test shows it. */
const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (isSquireError(error) ? error.code : error._tag)),
  );

describe("SquireRules", () => {
  it.effect("refuses the 11th allow and 21st ask-first rule and evicts none", () =>
    withRules(
      Effect.gen(function* () {
        const rules = yield* SquireRules.SquireRules;
        const repository = yield* SquireRepository.SquireRepository;
        yield* seed(
          Array.from({ length: SQUIRE_MAX_ASK_FIRST_RULES + 1 }, (_, n) =>
            grantRow(release, "project", projectN(n)),
          ),
        );
        const save = (effect: "allow" | "ask-first", n: number) =>
          rules.create(input({ requestId: `${effect}-${n}`, effect, targetId: projectN(n) }));

        for (let n = 0; n < SQUIRE_MAX_ALLOW_RULES; n++) yield* save("allow", n);
        const allowIds = (yield* rules.list(release)).map((rule) => rule.id);
        assert.equal(yield* refusal(save("allow", SQUIRE_MAX_ALLOW_RULES)), "limit_reached");
        assert.deepStrictEqual(
          (yield* rules.list(release)).map((rule) => rule.id),
          allowIds,
        );

        for (let n = 0; n < SQUIRE_MAX_ASK_FIRST_RULES; n++) yield* save("ask-first", n);
        assert.equal(
          yield* refusal(save("ask-first", SQUIRE_MAX_ASK_FIRST_RULES)),
          "limit_reached",
        );
        assert.lengthOf(
          yield* rules.list(release),
          SQUIRE_MAX_ALLOW_RULES + SQUIRE_MAX_ASK_FIRST_RULES,
        );

        // A replay at the cap returns the stored rule instead of refusing.
        assert.equal((yield* save("allow", 0)).id, allowIds[0]);

        // A disabled rule keeps its slot; only Remove frees one.
        yield* repository.deleteGrant({
          squireId: release,
          kind: "project",
          targetId: projectN(0),
        });
        yield* rules.disableOutOfScope(release);
        assert.equal(yield* refusal(save("allow", SQUIRE_MAX_ALLOW_RULES)), "limit_reached");
        const [first] = allowIds;
        if (first === undefined) return assert.fail("no allow rules");
        yield* rules.remove({ requestId: "remove-1", ruleId: first });
        assert.equal((yield* save("allow", SQUIRE_MAX_ALLOW_RULES)).status, "active");
      }),
    ),
  );

  it.effect("returns the stored rule for a repeated request or the same pattern", () =>
    withRules(
      Effect.gen(function* () {
        const rules = yield* SquireRules.SquireRules;
        yield* seed([grantRow(release, "project", projectA)]);
        const saved = yield* rules.create(input());
        assert.deepStrictEqual(yield* rules.create(input()), saved);
        assert.deepStrictEqual(yield* rules.create(input({ requestId: "request-2" })), saved);
        assert.lengthOf(yield* rules.list(release), 1);
      }),
    ),
  );

  it.effect("refuses the Lead, a target outside scope, and steer rules that cannot match", () =>
    withRules(
      Effect.gen(function* () {
        const rules = yield* SquireRules.SquireRules;
        yield* seed([grantRow(release, "project", projectA)]);
        assert.equal(yield* refusal(rules.create(input({ squireId: lead }))), "invalid_request");
        assert.equal(
          yield* refusal(rules.create(input({ squireId: SquireId.make("squire:gone") }))),
          "not_found",
        );
        assert.equal(
          yield* refusal(rules.create(input({ targetId: "project:other" }))),
          "out_of_scope",
        );
        assert.equal(
          yield* refusal(
            rules.create(input({ targetKind: "thread", targetId: "thread:untracked" })),
          ),
          "out_of_scope",
        );
        const steer = input({ actionClass: "steer" });
        assert.equal(yield* refusal(rules.create(steer)), "invalid_request");
        assert.equal(
          yield* refusal(rules.create({ ...steer, steerKind: "other" })),
          "invalid_request",
        );
        assert.equal(
          yield* refusal(rules.create(input({ steerKind: "rebase" }))),
          "invalid_request",
        );
        assert.deepStrictEqual(yield* rules.list(release), []);
        assert.deepStrictEqual(yield* rules.list(lead), []);
      }),
    ),
  );

  it.effect("disables rules whose target left scope and restores them when it returns", () =>
    withRules(
      Effect.gen(function* () {
        const rules = yield* SquireRules.SquireRules;
        const repository = yield* SquireRepository.SquireRepository;
        const { withPolicyLock } = yield* SquirePolicyLock.SquirePolicyLock;
        const threadId = ThreadId.make("thread:tracked");
        const other = ProjectId.make("project:b");
        yield* seed([grantRow(release, "project", projectA), grantRow(release, "project", other)]);
        yield* createThread(threadId, projectA);

        const onThread = yield* rules.create(
          input({
            requestId: "thread-rule",
            actionClass: "steer",
            steerKind: "rebase",
            targetKind: "thread",
            targetId: threadId,
          }),
        );
        const onProject = yield* rules.create(input({ requestId: "project-rule" }));
        const untouched = yield* rules.create(
          input({ requestId: "other-rule", effect: "ask-first", targetId: other }),
        );

        // What the grant cascade does: remove the grant, then disable, under one lock.
        const cascade = yield* withPolicyLock(
          Effect.gen(function* () {
            yield* repository.deleteGrant({
              squireId: release,
              kind: "project",
              targetId: projectA,
            });
            return yield* rules.disableOutOfScope(release);
          }),
        );
        assert.sameMembers([...cascade.disabled], [onThread.id, onProject.id]);
        assert.deepStrictEqual(cascade.restored, []);
        const statuses = new Map(
          (yield* rules.list(release)).map((rule) => [rule.id, rule.status]),
        );
        assert.equal(statuses.get(onThread.id), "disabled");
        assert.equal(statuses.get(onProject.id), "disabled");
        assert.equal(statuses.get(untouched.id), "active");

        yield* repository.insertGrant(grantRow(release, "project", projectA));
        const back = yield* rules.disableOutOfScope(release);
        assert.sameMembers([...back.restored], [onThread.id, onProject.id]);
        assert.deepStrictEqual(back.disabled, []);
      }),
    ),
  );

  it.effect("logs creation and removal, and removing twice succeeds", () =>
    withRules(
      Effect.gen(function* () {
        const rules = yield* SquireRules.SquireRules;
        const repository = yield* SquireRepository.SquireRepository;
        yield* seed([grantRow(release, "project", projectA)]);
        const rule = yield* rules.create(input());
        yield* rules.remove({ requestId: "remove", ruleId: rule.id });
        yield* rules.remove({ requestId: "remove", ruleId: rule.id });
        assert.deepStrictEqual(yield* rules.list(release), []);
        const log = yield* repository.listActionLog({
          squireId: release,
          kinds: ["rule.created", "rule.removed"],
          limit: 10,
        });
        assert.deepStrictEqual(
          log.map((row) => row.kind),
          ["rule.created", "rule.removed"],
        );
      }),
    ),
  );

  describe("offers", () => {
    const tracked = ThreadId.make("thread:billing");

    const seedProject = (projectId: ProjectId, title: string) =>
      Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const commandId = CommandId.make(`project:create:${projectId}`);
        const created = planProjectCommand({
          command: {
            type: "project.create",
            commandId,
            projectId,
            title,
            workspaceRoot: `/tmp/${projectId}`,
          },
          state: { project: undefined, workspaceOwner: undefined, appWorkspaceOwner: undefined },
          eventId: EventId.make(`event:${commandId}`),
          now,
        });
        yield* eventSink.commitProjectCommand({
          commandId,
          projectId,
          commandType: "project.create",
          acceptedAt: now,
          event: Result.getOrThrow(created),
        });
      });

    const card = (
      overrides: Partial<SquireRepository.SquireCardRow> = {},
    ): SquireRepository.SquireCardRow => ({
      id: SquireCardId.make("card:1"),
      squire_id: release,
      owner_squire_id: release,
      kind: "steer",
      status: "resolved",
      target_thread_id: tracked,
      project_id: billing,
      title: "Rebase onto main",
      why: "",
      payload_json: "{}",
      evidence_json: "{}",
      trigger_json: "{}",
      intent_json: null,
      origin: "event",
      steer_kind: "rebase",
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
      created_at: "2026-11-01T00:00:00.000Z",
      updated_at: "2026-11-01T00:00:00.000Z",
      ...overrides,
    });
    const proposal = (overrides: Partial<SquireRepository.SquireCardRow> = {}) =>
      card({ kind: "proposal", target_thread_id: null, steer_kind: null, ...overrides });

    const setup = (
      grants: ReadonlyArray<SquireRepository.SquireGrantRow>,
      overrides: Partial<SquireRepository.SquireRow> = {},
    ) =>
      Effect.gen(function* () {
        yield* seed(grants, overrides);
        yield* seedProject(billing, "billing-service");
        yield* createThread(tracked, billing);
      });

    const saveOffer = (offer: SquireRuleOffer, requestId = "offer") =>
      Effect.flatMap(SquireRules.SquireRules, (rules) =>
        rules.create({
          requestId,
          squireId: release,
          effect: offer.effect,
          actionClass: offer.actionClass,
          targetKind: offer.targetKind,
          targetId: offer.targetId,
          ...(offer.steerKind === undefined ? {} : { steerKind: offer.steerKind }),
          fromCardId: SquireCardId.make("card:1"),
        }),
      );

    /** The call-time decision for a steer or proposal on the billing thread or project. */
    const decideFor = (
      actionClass: "steer" | "createThread",
      steerKind: SquireSteerKind = "rebase",
    ) =>
      Effect.gen(function* () {
        const rules = yield* SquireRules.SquireRules;
        const repository = yield* SquireRepository.SquireRepository;
        const row = yield* repository.getSquire(release);
        if (Option.isNone(row)) return assert.fail("no squire");
        return squirePolicy.decide({
          actionClass,
          squire: {
            id: release,
            role: "squire",
            status: "active",
            permissions: decodePermissions(row.value.permissions_json),
            budgets: DEFAULT_SQUIRE_BUDGETS,
            createdAt: row.value.created_at,
          },
          rules: yield* rules.list(release),
          target: {
            threadId: actionClass === "steer" ? tracked : null,
            projectId: billing,
            staveSpaceId: billingSpace,
            staveSagaId: null,
          },
          trackers: [],
          budgetRows: [],
          origin: "event",
          steerKind,
          now: DateTime.formatIso(yield* DateTime.now),
        });
      });

    it.effect("offers the thread rule with its granted container as the one alternative", () =>
      withRules(
        Effect.gen(function* () {
          const rules = yield* SquireRules.SquireRules;
          yield* setup([grantRow(release, "project", billing)]);
          const offer = yield* rules.offerFor(card());
          assert.deepStrictEqual(Option.getOrUndefined(offer), {
            effect: "allow",
            actionClass: "steer",
            targetKind: "thread",
            targetId: tracked,
            steerKind: "rebase",
            text: 'Release may auto-send rebase steers on "Thread"',
            alternative: {
              targetKind: "project",
              targetId: billing,
              text: "Release may auto-send rebase steers on threads in billing-service",
            },
            capReached: false,
          });
          const fix = yield* rules.offerFor(card({ steer_kind: "fix-failing-check" }));
          assert.equal(
            Option.getOrUndefined(fix)?.alternative?.text,
            "Release may auto-send fix failing check steers on threads in billing-service",
          );
        }),
      ),
    );

    it.effect("offers a Stave container, no alternative for a thread grant, and proposals", () =>
      withRules(
        Effect.gen(function* () {
          const rules = yield* SquireRules.SquireRules;
          yield* setup([grantRow(release, "staveSpace", billingSpace)]);
          const steer = Option.getOrUndefined(yield* rules.offerFor(card()));
          assert.deepStrictEqual(steer?.alternative, {
            targetKind: "staveSpace",
            targetId: billingSpace,
            text: `Release may auto-send rebase steers on threads in ${billingSpace}`,
          });

          // A proposal's target is its project's granted container; there is no thread.
          const byProject = Option.getOrUndefined(yield* rules.offerFor(proposal()));
          assert.deepStrictEqual(byProject, {
            effect: "allow",
            actionClass: "createThread",
            targetKind: "staveSpace",
            targetId: billingSpace,
            text: `Release may auto-create threads in ${billingSpace}`,
            capReached: false,
          });
          const repository = yield* SquireRepository.SquireRepository;
          yield* repository.insertGrant(grantRow(release, "project", billing));
          const both = Option.getOrUndefined(yield* rules.offerFor(proposal()));
          assert.equal(both?.text, "Release may auto-create threads in billing-service");
          assert.equal(both?.alternative?.targetKind, "staveSpace");

          yield* repository.deleteGrant({ squireId: release, kind: "project", targetId: billing });
          yield* repository.deleteGrant({
            squireId: release,
            kind: "staveSpace",
            targetId: billingSpace,
          });
          yield* repository.insertGrant(grantRow(release, "thread", tracked));
          const threadOnly = Option.getOrUndefined(yield* rules.offerFor(card()));
          assert.equal(threadOnly?.targetKind, "thread");
          assert.isUndefined(threadOnly?.alternative);
          assert.isTrue(Option.isNone(yield* rules.offerFor(proposal())));
        }),
      ),
    );

    it.effect(
      "offers nothing for excluded origins, `other`, non-Recommend classes, or the Lead",
      () =>
        withRules(
          Effect.gen(function* () {
            const rules = yield* SquireRules.SquireRules;
            const repository = yield* SquireRepository.SquireRepository;
            yield* setup([grantRow(release, "project", billing)]);
            for (const origin of [
              "voice",
              "webhook",
              "test",
              "sweep",
              "message",
              "lead",
            ] as const) {
              assert.isTrue(Option.isNone(yield* rules.offerFor(card({ origin }))), origin);
              assert.isTrue(Option.isNone(yield* rules.offerFor(proposal({ origin }))), origin);
            }
            for (const origin of ["event", "room", "user"] as const) {
              assert.isTrue(Option.isSome(yield* rules.offerFor(card({ origin }))), origin);
            }
            assert.isTrue(Option.isNone(yield* rules.offerFor(card({ steer_kind: "other" }))));
            assert.isTrue(Option.isNone(yield* rules.offerFor(card({ steer_kind: null }))));
            assert.isTrue(Option.isNone(yield* rules.offerFor(card({ kind: "question" }))));
            assert.isTrue(Option.isNone(yield* rules.offerFor(card({ squire_id: lead }))));
            assert.isTrue(
              Option.isNone(yield* rules.offerFor(card({ target_thread_id: ThreadId.make("x") }))),
            );

            // Allow only raises Recommend: nothing at Auto or Off.
            for (const steer of ["auto", "off"] as const) {
              yield* repository.updateSquire({
                id: release,
                patch: { permissions_json: JSON.stringify({ steer }) },
                updatedAt: "2026-11-01T00:00:01.000Z",
              });
              assert.isTrue(Option.isNone(yield* rules.offerFor(card())), steer);
            }
          }),
        ),
    );

    it.effect("at the cap the offer says so and saving it stores nothing", () =>
      withRules(
        Effect.gen(function* () {
          const rules = yield* SquireRules.SquireRules;
          yield* setup([
            grantRow(release, "project", billing),
            ...Array.from({ length: SQUIRE_MAX_ALLOW_RULES }, (_, n) =>
              grantRow(release, "project", projectN(n)),
            ),
          ]);
          for (let n = 0; n < SQUIRE_MAX_ALLOW_RULES; n++) {
            yield* rules.create(input({ requestId: `fill-${n}`, targetId: projectN(n) }));
          }
          const offer = Option.getOrUndefined(yield* rules.offerFor(card()));
          if (offer === undefined) return assert.fail("no offer");
          assert.deepStrictEqual(
            [offer.capReached, offer.text, offer.alternative],
            [true, SQUIRE_RULE_LIMIT_TEXT, undefined],
          );
          const before = yield* rules.list(release);
          assert.equal(yield* refusal(saveOffer(offer)), "limit_reached");
          assert.deepStrictEqual(yield* rules.list(release), before);
        }),
      ),
    );

    it.effect("saving the allow offer makes the next matching decision Auto by that rule", () =>
      withRules(
        Effect.gen(function* () {
          const rules = yield* SquireRules.SquireRules;
          yield* setup([grantRow(release, "project", billing)]);
          assert.deepStrictEqual(yield* decideFor("steer"), {
            level: "recommend",
            reason: "permission",
          });
          const offer = Option.getOrUndefined(yield* rules.offerFor(card()));
          if (offer?.alternative === undefined) return assert.fail("no offer");
          const rule = yield* saveOffer({ ...offer, ...offer.alternative });
          assert.equal(rule.targetKind, "project");
          assert.deepStrictEqual(yield* decideFor("steer"), {
            level: "auto",
            reason: "rule",
            ruleId: rule.id,
          });
          // Another kind does not match, and the covered pattern is not offered again.
          assert.equal((yield* decideFor("steer", "continue")).level, "recommend");
          assert.isTrue(Option.isNone(yield* rules.offerFor(card())));

          const threads = Option.getOrUndefined(yield* rules.offerFor(proposal()));
          if (threads === undefined) return assert.fail("no proposal offer");
          const threadRule = yield* saveOffer(threads, "offer-threads");
          assert.deepStrictEqual(yield* decideFor("createThread"), {
            level: "auto",
            reason: "rule",
            ruleId: threadRule.id,
          });
        }),
      ),
    );

    it.effect(
      "Undo on a hold offers the matching ask-first rule, which turns it to Recommend",
      () =>
        withRules(
          Effect.gen(function* () {
            const rules = yield* SquireRules.SquireRules;
            yield* setup([grantRow(release, "project", billing)], {
              permissions_json: JSON.stringify({ steer: "auto" }),
            });
            // Allow offers apply only at Recommend; ask-first only where Auto would act.
            assert.isTrue(Option.isNone(yield* rules.offerFor(card())));
            const offer = Option.getOrUndefined(
              yield* rules.askFirstOfferFor(card({ origin: "user" })),
            );
            assert.deepStrictEqual(offer, {
              effect: "ask-first",
              actionClass: "steer",
              targetKind: "thread",
              targetId: tracked,
              steerKind: "rebase",
              text: 'Release asks first before sending rebase steers on "Thread"',
              alternative: {
                targetKind: "project",
                targetId: billing,
                text: "Release asks first before sending rebase steers on threads in billing-service",
              },
              capReached: false,
            });
            if (offer === undefined) return;
            const rule = yield* saveOffer(offer);
            assert.deepStrictEqual(yield* decideFor("steer"), {
              level: "recommend",
              reason: "rule",
              ruleId: rule.id,
            });
            assert.isTrue(Option.isNone(yield* rules.askFirstOfferFor(card())));
            assert.equal(
              Option.getOrUndefined(yield* rules.askFirstOfferFor(card({ steer_kind: "continue" })))
                ?.effect,
              "ask-first",
            );
          }),
        ),
    );

    it.effect("a match bumps the count and last use once, with the log row's transaction", () =>
      withRules(
        Effect.gen(function* () {
          const rules = yield* SquireRules.SquireRules;
          const repository = yield* SquireRepository.SquireRepository;
          yield* setup([grantRow(release, "project", billing)]);
          const rule = yield* rules.create(input({ targetId: billing }));
          const first = "2026-11-01T01:00:00.000Z";
          const second = "2026-11-01T02:00:00.000Z";
          yield* rules.recordMatch({ ruleId: rule.id, matchedAt: first });
          const once = (yield* rules.list(release))[0];
          assert.deepStrictEqual([once?.matchCount, once?.lastMatchedAt], [1, first]);

          // A rolled-back invocation leaves no match behind.
          const failed = yield* repository
            .transaction(
              Effect.gen(function* () {
                yield* rules.recordMatch({ ruleId: rule.id, matchedAt: second });
                return yield* Effect.fail("rolled back" as const);
              }),
            )
            .pipe(Effect.flip);
          assert.equal(failed, "rolled back");
          const still = (yield* rules.list(release))[0];
          assert.deepStrictEqual([still?.matchCount, still?.lastMatchedAt], [1, first]);

          yield* rules.recordMatch({ ruleId: rule.id, matchedAt: second });
          const twice = (yield* rules.list(release))[0];
          assert.deepStrictEqual([twice?.matchCount, twice?.lastMatchedAt], [2, second]);
        }),
      ),
    );
  });
});
