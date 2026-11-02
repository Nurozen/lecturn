import type {
  ProjectId,
  Squire,
  SquireCardOrigin,
  SquireId,
  SquirePermissionLevel,
  SquireRule,
  SquireRuleId,
  SquireSteerKind,
  ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";

export type SquirePolicyActionClass = "steer" | "createThread" | "notify" | "manageSquires";

export type SquirePolicyReason =
  | "permission"
  | "single-auto"
  | "budget"
  | "voice"
  | "origin"
  | "rule"
  | "intersection"
  | "paused";

export type SquirePolicySquire = Pick<
  Squire,
  "id" | "role" | "status" | "permissions" | "budgets" | "createdAt"
>;

/** A Squire tracking the target thread, with its own rules. */
export interface SquirePolicyTracker {
  readonly squire: SquirePolicySquire;
  readonly rules: ReadonlyArray<SquireRule>;
}

/** The action's target and the containers rules can name; `threadId` is null for a new thread. */
export interface SquirePolicyTarget {
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId;
  readonly staveSpaceId: string | null;
  readonly staveSagaId: string | null;
}

/** One `squire_budget_usage` row of the Squire whose budgets are charged. */
export interface SquirePolicyBudgetRow {
  readonly kind: "steer" | "thread" | "message";
  readonly threadId: ThreadId | null;
  readonly executedAt: string;
}

export interface SquirePolicyInput {
  readonly actionClass: SquirePolicyActionClass;
  /** The acting Squire, or the owning Squire when `lead` acts on its item. */
  readonly squire: SquirePolicySquire;
  readonly rules: ReadonlyArray<SquireRule>;
  readonly target: SquirePolicyTarget;
  /** Every Squire tracking the target thread; the acting Squire may be included or not. */
  readonly trackers: ReadonlyArray<SquirePolicyTracker>;
  readonly budgetRows: ReadonlyArray<SquirePolicyBudgetRow>;
  readonly origin: SquireCardOrigin;
  readonly steerKind?: SquireSteerKind | undefined;
  readonly now: string;
  /** Set when the Lead is the actor; `squire` is then the owning Squire. */
  readonly lead?: SquirePolicySquire;
}

export interface SquirePolicyDecision {
  /** Notify On is reported as `auto`: it acts at once and is never held. */
  readonly level: SquirePermissionLevel;
  readonly reason: SquirePolicyReason;
  /** The rule that changed the level, when `reason` is `rule`. */
  readonly ruleId?: SquireRuleId;
  /** When the exhausted budget frees a slot, when `reason` is `budget`. */
  readonly recommendingUntil?: string;
}

const rank = { off: 0, recommend: 1, auto: 2 } as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Rules and Auto both need input the user typed or approved; these origins carry model or outside input.
const recommendOnlyOrigins: ReadonlySet<SquireCardOrigin> = new Set([
  "voice",
  "webhook",
  "test",
  "sweep",
  "message",
  "unknown",
]);
// Test runs and sweep findings never push.
const silentOrigins: ReadonlySet<SquireCardOrigin> = new Set(["test", "sweep"]);

const classLevel = (
  squire: SquirePolicySquire,
  actionClass: SquirePolicyActionClass,
): SquirePermissionLevel => {
  switch (actionClass) {
    case "steer":
      return squire.permissions.steer;
    case "createThread":
      return squire.permissions.createThread;
    case "notify":
      return squire.permissions.notify === "on" ? "auto" : "off";
    case "manageSquires":
      return squire.permissions.manageSquires ?? "off";
  }
};

const ruleCovers = (rule: SquireRule, target: SquirePolicyTarget): boolean => {
  switch (rule.targetKind) {
    case "thread":
      return target.threadId !== null && rule.targetId === target.threadId;
    case "project":
      return rule.targetId === target.projectId;
    case "staveSpace":
      return rule.targetId === target.staveSpaceId;
    case "staveSaga":
      return rule.targetId === target.staveSagaId;
  }
};

const ruleApplies = (
  rule: SquireRule,
  squireId: SquireId,
  actionClass: "steer" | "createThread",
  target: SquirePolicyTarget,
  steerKind: SquireSteerKind | undefined,
): boolean =>
  rule.squireId === squireId &&
  rule.status === "active" &&
  rule.actionClass === actionClass &&
  (actionClass === "createThread" ||
    (rule.steerKind !== null && rule.steerKind !== "other" && rule.steerKind === steerKind)) &&
  ruleCovers(rule, target);

// A steer allow rule of any matchable kind covering the thread makes its Squire a holder.
const holdsAuto = (tracker: SquirePolicyTracker, target: SquirePolicyTarget): boolean => {
  const { squire } = tracker;
  if (squire.role === "lead" || squire.status === "paused") return false;
  if (squire.permissions.steer === "auto") return true;
  return (
    squire.permissions.steer === "recommend" &&
    tracker.rules.some(
      (rule) =>
        rule.effect === "allow" &&
        ruleApplies(rule, squire.id, "steer", target, rule.steerKind ?? undefined),
    )
  );
};

const earlier = (a: SquirePolicySquire, b: SquirePolicySquire): boolean =>
  Date.parse(a.createdAt) < Date.parse(b.createdAt);

/**
 * The earliest-created Squire that holds steer Auto on the thread, if
 * any. `trackers` come in creation order (created_at, then rowid, as
 * `SquireScope.trackersOf` lists them), so a created_at tie goes to the
 * earlier entry.
 */
export const autoHolder = (
  trackers: ReadonlyArray<SquirePolicyTracker>,
  target: SquirePolicyTarget,
): SquireId | null => {
  let holder: SquirePolicySquire | null = null;
  for (const tracker of trackers) {
    if (holdsAuto(tracker, target) && (holder === null || earlier(tracker.squire, holder))) {
      holder = tracker.squire;
    }
  }
  return holder?.id ?? null;
};

const withSelf = (
  trackers: ReadonlyArray<SquirePolicyTracker>,
  self: SquirePolicyTracker,
): ReadonlyArray<SquirePolicyTracker> =>
  // In place, so `self` keeps its creation-order position for the tie-break.
  trackers.some((tracker) => tracker.squire.id === self.squire.id)
    ? trackers.map((tracker) => (tracker.squire.id === self.squire.id ? self : tracker))
    : [...trackers, self];

/** Threads where `self` would auto-steer but another Squire holds Auto (snapshot `conflicts`). */
export const conflicts = (
  self: SquirePolicyTracker,
  threads: ReadonlyArray<{
    readonly target: SquirePolicyTarget & { readonly threadId: ThreadId };
    readonly trackers: ReadonlyArray<SquirePolicyTracker>;
  }>,
): ReadonlyArray<{ readonly threadId: ThreadId; readonly autoHolderSquireId: SquireId }> =>
  threads.flatMap(({ target, trackers }) => {
    if (!holdsAuto(self, target)) return [];
    const holder = autoHolder(withSelf(trackers, self), target);
    return holder !== null && holder !== self.squire.id
      ? [{ threadId: target.threadId, autoHolderSquireId: holder }]
      : [];
  });

export type SquireBudgetCheck =
  | { readonly exhausted: false }
  | { readonly exhausted: true; readonly recommendingUntil?: string };

/** Rolling budget windows;`recommendingUntil` is when every exhausted window frees a slot. */
export const checkBudget = (input: {
  readonly actionClass: "steer" | "createThread";
  readonly budgets: SquirePolicySquire["budgets"];
  readonly threadId: ThreadId | null;
  readonly budgetRows: ReadonlyArray<SquirePolicyBudgetRow>;
  readonly now: string;
}): SquireBudgetCheck => {
  const now = Date.parse(input.now);
  const { budgets, threadId } = input;
  const windows =
    input.actionClass === "createThread"
      ? [{ limit: budgets.threadsPerDay, windowMs: DAY_MS, kind: "thread", threadId: null }]
      : [
          { limit: budgets.steersPerDay, windowMs: DAY_MS, kind: "steer", threadId: null },
          // The per-thread window only exists for a known thread.
          ...(threadId === null
            ? []
            : [
                {
                  limit: budgets.steersPerThreadPerHour,
                  windowMs: HOUR_MS,
                  kind: "steer",
                  threadId,
                },
              ]),
        ];
  let exhausted = false;
  let until: number | null = null;
  let untilKnown = true;
  for (const window of windows) {
    const leavesAt = input.budgetRows
      .filter(
        (row) =>
          row.kind === window.kind &&
          (window.threadId === null || row.threadId === window.threadId),
      )
      .map((row) => Date.parse(row.executedAt) + window.windowMs)
      .filter((at) => at > now)
      .toSorted((a, b) => a - b);
    if (leavesAt.length < window.limit) continue;
    exhausted = true;
    // A slot frees when the count drops below the limit; with limit 0 none ever does.
    const freesAt = leavesAt[leavesAt.length - window.limit];
    if (freesAt === undefined) untilKnown = false;
    else until = until === null ? freesAt : Math.max(until, freesAt);
  }
  if (!exhausted) return { exhausted: false };
  return untilKnown && until !== null
    ? { exhausted: true, recommendingUntil: DateTime.formatIso(DateTime.makeUnsafe(until)) }
    : { exhausted: true };
};

const lowerTo = (
  level: SquirePermissionLevel,
  ceiling: SquirePermissionLevel,
): SquirePermissionLevel => (rank[ceiling] < rank[level] ? ceiling : level);

/** The off/recommend/auto decision for one action, at call time and again at execution. */
export const decide = (input: SquirePolicyInput): SquirePolicyDecision => {
  const { actionClass, squire, lead, origin, target } = input;
  const actor = lead ?? squire;
  if (actor.status === "paused") return { level: "off", reason: "paused" };

  let level = classLevel(actor, actionClass);
  let reason: SquirePolicyReason = "permission";
  if (level === "off") return { level, reason };

  // Class levels intersect; the owner's rules do not carry over to the Lead.
  if (lead !== undefined && actionClass !== "manageSquires") {
    const owned = lowerTo(level, classLevel(squire, actionClass));
    if (owned !== level) {
      level = owned;
      reason = "intersection";
      if (level === "off") return { level, reason };
    }
  }

  if (actionClass === "notify") {
    return silentOrigins.has(origin) ? { level: "off", reason: "origin" } : { level, reason };
  }

  const recommendOnly = recommendOnlyOrigins.has(origin);
  if (recommendOnly && level === "auto") {
    return { level: "recommend", reason: origin === "voice" ? "voice" : "origin" };
  }
  if (actionClass === "manageSquires") return { level, reason };

  let ruleId: SquireRuleId | undefined;
  if (lead === undefined && !recommendOnly) {
    const matching = input.rules.filter((rule) =>
      ruleApplies(rule, squire.id, actionClass, target, input.steerKind),
    );
    const askFirst = matching.find((rule) => rule.effect === "ask-first");
    const allow = matching.find((rule) => rule.effect === "allow");
    if (askFirst !== undefined && (level === "auto" || allow !== undefined)) {
      return { level: "recommend", reason: "rule", ruleId: askFirst.id };
    }
    if (allow !== undefined && level === "recommend") {
      level = "auto";
      reason = "rule";
      ruleId = allow.id;
    }
  }
  if (level !== "auto") return { level, reason };

  if (actionClass === "steer") {
    const holder = autoHolder(withSelf(input.trackers, { squire, rules: input.rules }), target);
    if (holder !== squire.id) return { level: "recommend", reason: "single-auto" };
  }

  const budget = checkBudget({
    actionClass,
    budgets: squire.budgets,
    threadId: target.threadId,
    budgetRows: input.budgetRows,
    now: input.now,
  });
  if (budget.exhausted) {
    return budget.recommendingUntil === undefined
      ? { level: "recommend", reason: "budget" }
      : { level: "recommend", reason: "budget", recommendingUntil: budget.recommendingUntil };
  }

  return ruleId === undefined ? { level, reason } : { level, reason, ruleId };
};
