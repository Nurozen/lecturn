import {
  DEFAULT_SQUIRE_BUDGETS,
  DEFAULT_SQUIRE_PERMISSIONS,
  ProjectId,
  SQUIRE_MAX_ALLOW_RULES,
  SQUIRE_MAX_ASK_FIRST_RULES,
  SQUIRE_RULE_LIMIT_TEXT,
  SquireBudgets,
  SquireError,
  type SquireId,
  SquirePermissions,
  SquireRule,
  type SquireRuleCreateInput,
  type SquireRuleEffect,
  SquireRuleId,
  type SquireRuleOffer,
  type SquireRuleRemoveInput,
  type SquireRuleTargetKind,
  SquireSteerKind,
  ThreadId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SquireContainers from "./SquireContainers.ts";
import * as squirePolicy from "./squirePolicy.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireScope from "./SquireScope.ts";
import { touchUserActivity } from "./squireUserActivity.ts";

type RuleError = SquireError | SquireScope.SquireScopeError;

export class SquireRules extends Context.Service<
  SquireRules,
  {
    /**
     * Saves a rule under the policy lock. A replay of the request id or of the
     * rule's unique key returns the stored rule, even at the cap.
     */
    readonly create: (
      input: typeof SquireRuleCreateInput.Type,
    ) => Effect.Effect<SquireRule, RuleError>;
    /** Idempotent: removing a missing rule succeeds. */
    readonly remove: (
      input: typeof SquireRuleRemoveInput.Type,
    ) => Effect.Effect<{ readonly ruleId: SquireRuleId }, RuleError>;
    /** Every rule, disabled ones included, oldest first. */
    readonly list: (squireId: SquireId) => Effect.Effect<ReadonlyArray<SquireRule>, RuleError>;
    /**
     * The cascade after a grant change: active rules whose target left
     * scope become `disabled`, and disabled rules whose target is back become
     * `active` again (they kept their cap slot). Callers already hold the
     * policy lock, so this does not take it.
     */
    readonly disableOutOfScope: (squireId: SquireId) => Effect.Effect<
      {
        readonly disabled: ReadonlyArray<SquireRuleId>;
        readonly restored: ReadonlyArray<SquireRuleId>;
      },
      RuleError
    >;
    /**
     * "Always allow this" after the user accepted the card. None unless
     * the card's class is at Recommend and no rule already decides it, and
     * never for recommend-only origins, the Lead, or steer kind `other`.
     * Never fails: an offer is optional and must not fail the accept.
     */
    readonly offerFor: (
      card: SquireRepository.SquireCardRow,
    ) => Effect.Effect<Option.Option<SquireRuleOffer>>;
    /** "Always ask first for this" after the user undid the card's hold. */
    readonly askFirstOfferFor: (
      card: SquireRepository.SquireCardRow,
    ) => Effect.Effect<Option.Option<SquireRuleOffer>>;
    /**
     * Bumps the match count and last use. Run it in the transaction that writes
     * the `rule.matched` log row, so a replayed invocation bumps nothing.
     */
    readonly recordMatch: (input: {
      readonly ruleId: SquireRuleId;
      readonly matchedAt: string;
    }) => Effect.Effect<void, RuleError>;
  }
>()("lecturn/squire/SquireRules") {}

const decodeRule = Schema.decodeUnknownEffect(SquireRule);
const encodeLogData = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
);

const toRule = (row: SquireRepository.SquireRuleRow) =>
  decodeRule({
    id: row.id,
    squireId: row.squire_id,
    effect: row.effect,
    actionClass: row.action_class,
    targetKind: row.target_kind,
    targetId: row.target_id,
    steerKind: row.steer_kind,
    status: row.status,
    matchCount: row.match_count,
    lastMatchedAt: row.last_matched_at,
    createdAt: row.created_at,
  }).pipe(Effect.orDie);

const caps = { allow: SQUIRE_MAX_ALLOW_RULES, "ask-first": SQUIRE_MAX_ASK_FIRST_RULES } as const;

const refuse = (code: SquireError["code"], message: string) => new SquireError({ code, message });

const decodePermissions = Schema.decodeUnknownOption(Schema.fromJsonString(SquirePermissions));
const decodeBudgets = Schema.decodeUnknownOption(Schema.fromJsonString(SquireBudgets));
const decodeSteerKind = Schema.decodeUnknownOption(SquireSteerKind);

const offerClasses = { steer: "steer", proposal: "createThread" } as const;
// Voice, webhook, test, sweep, message, and Lead cards get no allow offer.
const allowOfferOrigins: ReadonlySet<SquireRepository.SquireCardRow["origin"]> = new Set([
  "event",
  "room",
  "user",
]);

interface OfferTarget {
  readonly targetKind: SquireRuleTargetKind;
  readonly targetId: string;
  readonly name: string;
}

type ContainerKind = Exclude<SquireRuleTargetKind, "thread">;

interface OfferTargets {
  readonly policyTarget: squirePolicy.SquirePolicyTarget;
  readonly primary: OfferTarget;
  readonly alternative: OfferTarget | undefined;
}

const steerLabel = (kind: SquireSteerKind) => kind.replaceAll("-", " ");

const where = (target: OfferTarget, prefix: string) =>
  target.targetKind === "thread" ? `on "${target.name}"` : `${prefix} ${target.name}`;

/** The exact rule text, shown before saving. */
const ruleText = (input: {
  readonly squireName: string;
  readonly effect: SquireRuleEffect;
  readonly steerKind: SquireSteerKind | null;
  readonly target: OfferTarget;
}): string => {
  const { squireName, effect, steerKind, target } = input;
  if (steerKind === null) {
    return effect === "allow"
      ? `${squireName} may auto-create threads ${where(target, "in")}`
      : `${squireName} asks first before creating threads ${where(target, "in")}`;
  }
  const steers = `${steerLabel(steerKind)} steers ${where(target, "on threads in")}`;
  return effect === "allow"
    ? `${squireName} may auto-send ${steers}`
    : `${squireName} asks first before sending ${steers}`;
};

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const scope = yield* SquireScope.SquireScope;
  const { withPolicyLock } = yield* SquirePolicyLock.SquirePolicyLock;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const containers = yield* SquireContainers.SquireContainers;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const create: SquireRules["Service"]["create"] = (input) =>
    withPolicyLock(
      Effect.gen(function* () {
        const squire = yield* repository.getSquire(input.squireId);
        if (Option.isNone(squire)) return yield* refuse("not_found", "Squire not found.");
        if (squire.value.role === "lead") {
          return yield* refuse("invalid_request", "The Lead has no rules.");
        }
        // `other` never matches (squirePolicy), so a rule for it could never apply.
        const steerKind = input.steerKind ?? null;
        if (input.actionClass === "steer" && (steerKind === null || steerKind === "other")) {
          return yield* refuse("invalid_request", "A steer rule needs a steer kind.");
        }
        if (input.actionClass === "createThread" && steerKind !== null) {
          return yield* refuse("invalid_request", "Only steer rules have a steer kind.");
        }

        const id = SquireRuleId.make(`${input.squireId}:rule:${input.requestId}`);
        const existing = (yield* repository.listRules({ squireId: input.squireId })).find(
          (row) =>
            row.id === id ||
            (row.effect === input.effect &&
              row.action_class === input.actionClass &&
              row.target_kind === input.targetKind &&
              row.target_id === input.targetId &&
              row.steer_kind === steerKind),
        );
        if (existing !== undefined) return yield* toRule(existing);

        const inScope = yield* scope.ruleTargetInScope({
          squireId: input.squireId,
          targetKind: input.targetKind,
          targetId: input.targetId,
        });
        if (!inScope) {
          return yield* refuse("out_of_scope", "The rule's target is outside this Squire's scope.");
        }
        // At the cap nothing is saved and nothing is evicted.
        const count = yield* repository.countRules({
          squireId: input.squireId,
          effect: input.effect,
        });
        if (count >= caps[input.effect]) {
          return yield* refuse("limit_reached", SQUIRE_RULE_LIMIT_TEXT);
        }

        const createdAt = yield* nowIso;
        const row: SquireRepository.SquireRuleRow = {
          id,
          squire_id: input.squireId,
          effect: input.effect,
          action_class: input.actionClass,
          target_kind: input.targetKind,
          target_id: input.targetId,
          steer_kind: steerKind,
          status: "active",
          match_count: 0,
          last_matched_at: null,
          created_at: createdAt,
        };
        yield* repository.transaction(
          Effect.gen(function* () {
            yield* repository.insertRule(row);
            yield* repository.insertActionLog({
              squire_id: input.squireId,
              kind: "rule.created",
              room_id: null,
              post_id: null,
              trigger_id: null,
              task_id: null,
              thread_id: input.targetKind === "thread" ? ThreadId.make(input.targetId) : null,
              card_id: input.fromCardId ?? null,
              event_id: null,
              run_id: null,
              invocation_key: null,
              execution_key: null,
              data_json: encodeLogData({
                ruleId: id,
                effect: input.effect,
                actionClass: input.actionClass,
                targetKind: input.targetKind,
                steerKind,
              }),
              created_at: createdAt,
            });
          }),
        );
        return yield* toRule(row);
      }),
    );

  const remove: SquireRules["Service"]["remove"] = ({ ruleId }) =>
    withPolicyLock(
      Effect.gen(function* () {
        const rule = yield* repository.getRule(ruleId);
        if (Option.isNone(rule)) return { ruleId };
        const createdAt = yield* nowIso;
        yield* repository.transaction(
          Effect.gen(function* () {
            yield* repository.deleteRule(ruleId);
            yield* repository.insertActionLog({
              squire_id: rule.value.squire_id,
              kind: "rule.removed",
              room_id: null,
              post_id: null,
              trigger_id: null,
              task_id: null,
              thread_id:
                rule.value.target_kind === "thread" ? ThreadId.make(rule.value.target_id) : null,
              card_id: null,
              event_id: null,
              run_id: null,
              invocation_key: null,
              execution_key: null,
              data_json: encodeLogData({ ruleId, effect: rule.value.effect }),
              created_at: createdAt,
            });
          }),
        );
        return { ruleId };
      }),
    );

  const list: SquireRules["Service"]["list"] = (squireId) =>
    repository.listRules({ squireId }).pipe(Effect.flatMap(Effect.forEach(toRule)));

  const disableOutOfScope: SquireRules["Service"]["disableOutOfScope"] = (squireId) =>
    repository.transaction(
      Effect.gen(function* () {
        const rules = yield* repository.listRules({ squireId });
        const checked = yield* Effect.forEach(rules, (row) =>
          scope
            .ruleTargetInScope({ squireId, targetKind: row.target_kind, targetId: row.target_id })
            .pipe(Effect.map((inScope) => ({ row, inScope }))),
        );
        const disabled = checked
          .filter(({ row, inScope }) => !inScope && row.status === "active")
          .map(({ row }) => row.id);
        const restored = checked
          .filter(({ row, inScope }) => inScope && row.status === "disabled")
          .map(({ row }) => row.id);
        yield* repository.setRuleStatus({ ids: disabled, status: "disabled" });
        yield* repository.setRuleStatus({ ids: restored, status: "active" });
        return { disabled, restored };
      }),
    );

  const recordMatch: SquireRules["Service"]["recordMatch"] = ({ ruleId, matchedAt }) =>
    repository.recordRuleMatch({ id: ruleId, matchedAt }).pipe(Effect.asVoid);

  const projectName = (projectId: ProjectId) =>
    projects
      .getShell(projectId)
      .pipe(Effect.map((shell) => (Option.isSome(shell) && shell.value.title) || projectId));
  const containerName = (kind: ContainerKind, targetId: string) =>
    kind === "project"
      ? projectName(ProjectId.make(targetId))
      : // A space or saga is named by the project that coordinates it.
        projects
          .listShells()
          .pipe(
            Effect.map(
              (shells) =>
                shells.find((shell) => shell.stave?.spaceId === targetId)?.title ?? targetId,
            ),
          );

  /**
   * The card's target and, for a thread, its narrowest granted container as
   * the one alternative. A proposal has no thread, so its project grant is
   * the target and a covering Stave grant the alternative.
   */
  const offerTargets = (squireId: SquireId, card: SquireRepository.SquireCardRow) =>
    Effect.gen(function* () {
      const grants = yield* repository.listGrants(squireId);
      const granted = (kind: ContainerKind, id: string | null) =>
        id !== null && grants.some((grant) => grant.kind === kind && grant.target_id === id)
          ? [{ kind, id }]
          : [];
      // Narrowest first: a project, then its Stave space, then its saga.
      const containersOf = (target: squirePolicy.SquirePolicyTarget) =>
        Effect.forEach(
          [
            ...granted("project", target.projectId),
            ...granted("staveSpace", target.staveSpaceId),
            ...granted("staveSaga", target.staveSagaId),
          ],
          ({ kind, id }) =>
            containerName(kind, id).pipe(
              Effect.map((name): OfferTarget => ({ targetKind: kind, targetId: id, name })),
            ),
        );

      if (card.kind === "steer") {
        if (card.target_thread_id === null) return Option.none<OfferTargets>();
        const threadId = card.target_thread_id;
        const target = yield* scope.targetOf(threadId);
        if (Option.isNone(target)) return Option.none<OfferTargets>();
        const tracked = yield* scope.ruleTargetInScope({
          squireId,
          targetKind: "thread",
          targetId: threadId,
        });
        if (!tracked) return Option.none<OfferTargets>();
        const shell = yield* projections.getThreadShell(threadId);
        const [container] = yield* containersOf(target.value);
        return Option.some<OfferTargets>({
          policyTarget: target.value,
          primary: { targetKind: "thread", targetId: threadId, name: shell?.title ?? threadId },
          alternative: container,
        });
      }
      if (card.project_id === null) return Option.none<OfferTargets>();
      const stave = yield* containers.ofProject(card.project_id);
      const policyTarget: squirePolicy.SquirePolicyTarget = {
        threadId: null,
        projectId: card.project_id,
        staveSpaceId: stave.status === "known" ? stave.spaceId : null,
        staveSagaId: stave.status === "known" ? stave.sagaId : null,
      };
      const [primary, alternative] = yield* containersOf(policyTarget);
      return primary === undefined
        ? Option.none<OfferTargets>()
        : Option.some<OfferTargets>({ policyTarget, primary, alternative });
    });

  const offer = (card: SquireRepository.SquireCardRow, effect: SquireRuleEffect) =>
    Effect.gen(function* () {
      if (card.kind !== "steer" && card.kind !== "proposal") return Option.none();
      if (effect === "allow" && !allowOfferOrigins.has(card.origin)) return Option.none();
      const actionClass = offerClasses[card.kind];
      const steerKind =
        actionClass === "steer"
          ? Option.getOrElse(decodeSteerKind(card.steer_kind), () => "other" as const)
          : null;
      // `other` never matches a rule, so a rule for it could never apply.
      if (steerKind === "other") return Option.none();

      const row = yield* repository.getSquire(card.squire_id);
      if (Option.isNone(row) || row.value.role !== "squire" || row.value.lifecycle === "deleting") {
        return Option.none();
      }
      const squire = row.value;
      const targets = yield* offerTargets(squire.id, card);
      if (Option.isNone(targets)) return Option.none();

      // The level this pattern gets today, ignoring budgets and other
      // Squires: an allow offer only helps at plain Recommend, an ask-first
      // offer only where the action would still be Auto.
      const decision = squirePolicy.decide({
        actionClass,
        squire: {
          id: squire.id,
          role: squire.role,
          status: squire.status,
          permissions: Option.getOrElse(
            decodePermissions(squire.permissions_json),
            () => DEFAULT_SQUIRE_PERMISSIONS,
          ),
          budgets: Option.getOrElse(
            decodeBudgets(squire.budgets_json),
            () => DEFAULT_SQUIRE_BUDGETS,
          ),
          createdAt: squire.created_at,
        },
        rules: yield* list(squire.id),
        target: targets.value.policyTarget,
        trackers: [],
        budgetRows: [],
        origin: "event",
        steerKind: steerKind ?? undefined,
        now: yield* nowIso,
      });
      const useful =
        effect === "allow"
          ? decision.level === "recommend" && decision.reason === "permission"
          : decision.level === "auto";
      if (!useful) return Option.none();

      const { primary, alternative } = targets.value;
      const base = {
        effect,
        actionClass,
        targetKind: primary.targetKind,
        targetId: primary.targetId,
        ...(steerKind === null ? {} : { steerKind }),
      };
      const count = yield* repository.countRules({ squireId: squire.id, effect });
      if (count >= caps[effect]) {
        return Option.some<SquireRuleOffer>({
          ...base,
          text: SQUIRE_RULE_LIMIT_TEXT,
          capReached: true,
        });
      }
      const text = (target: OfferTarget) =>
        ruleText({ squireName: squire.name, effect, steerKind, target });
      return Option.some<SquireRuleOffer>({
        ...base,
        text: text(primary),
        ...(alternative === undefined
          ? {}
          : {
              alternative: {
                targetKind: alternative.targetKind,
                targetId: alternative.targetId,
                text: text(alternative),
              },
            }),
        capReached: false,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Squire rule offer skipped", { cardId: card.id, cause }).pipe(
          Effect.as(Option.none<SquireRuleOffer>()),
        ),
      ),
    );

  // The inactivity check counts user RPCs only.
  const touch = Effect.flatMap(nowIso, (now) => touchUserActivity(repository, now));

  return SquireRules.of({
    create: (input) => create(input).pipe(Effect.tap(() => touch)),
    remove: (input) => remove(input).pipe(Effect.tap(() => touch)),
    list,
    disableOutOfScope,
    offerFor: (card) => offer(card, "allow"),
    askFirstOfferFor: (card) => offer(card, "ask-first"),
    recordMatch,
  });
});

export const layer = Layer.effect(SquireRules, make);
