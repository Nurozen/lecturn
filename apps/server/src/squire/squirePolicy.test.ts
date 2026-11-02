import {
  DEFAULT_LEAD_SQUIRE_PERMISSIONS,
  DEFAULT_SQUIRE_BUDGETS,
  DEFAULT_SQUIRE_PERMISSIONS,
  ProjectId,
  type SquireCardOrigin,
  SquireId,
  type SquirePermissionLevel,
  type SquireRule,
  SquireRuleId,
  type SquireSteerKind,
  ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  autoHolder,
  checkBudget,
  conflicts,
  decide,
  type SquirePolicyBudgetRow,
  type SquirePolicyDecision,
  type SquirePolicyInput,
  type SquirePolicySquire,
  type SquirePolicyTarget,
  type SquirePolicyTracker,
} from "./squirePolicy.ts";

const NOW = "2026-11-01T12:00:00.000Z";
const shift = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(NOW) + minutes * 60_000));
const minutesAgo = (minutes: number) => shift(-minutes);
const minutesAhead = shift;

const threadA = ThreadId.make("thr_a");
const target: SquirePolicyTarget = {
  threadId: threadA,
  projectId: ProjectId.make("proj_a"),
  staveSpaceId: "space_a",
  staveSagaId: "saga_a",
};
const otherTarget: SquirePolicyTarget = {
  threadId: ThreadId.make("thr_b"),
  projectId: ProjectId.make("proj_b"),
  staveSpaceId: "space_b",
  staveSagaId: null,
};

const squire = (
  id: string,
  options: {
    readonly steer?: SquirePermissionLevel;
    readonly createThread?: SquirePermissionLevel;
    readonly notify?: "off" | "on";
    readonly createdAt?: string;
    readonly paused?: boolean;
    readonly lead?: boolean;
    readonly manageSquires?: SquirePermissionLevel;
    readonly budgets?: Partial<SquirePolicySquire["budgets"]>;
  } = {},
): SquirePolicySquire => ({
  id: SquireId.make(id),
  role: options.lead ? "lead" : "squire",
  status: options.paused ? "paused" : "active",
  permissions: {
    ...(options.lead ? DEFAULT_LEAD_SQUIRE_PERMISSIONS : DEFAULT_SQUIRE_PERMISSIONS),
    ...(options.steer ? { steer: options.steer } : {}),
    ...(options.createThread ? { createThread: options.createThread } : {}),
    ...(options.notify ? { notify: options.notify } : {}),
    ...(options.manageSquires ? { manageSquires: options.manageSquires } : {}),
  },
  budgets: { ...DEFAULT_SQUIRE_BUDGETS, ...options.budgets },
  createdAt: options.createdAt ?? "2026-10-01T00:00:00.000Z",
});

const rule = (
  id: string,
  owner: SquirePolicySquire,
  options: Partial<
    Pick<SquireRule, "effect" | "actionClass" | "targetKind" | "targetId" | "steerKind" | "status">
  > = {},
): SquireRule => {
  const actionClass = options.actionClass ?? "steer";
  return {
    id: SquireRuleId.make(id),
    squireId: owner.id,
    effect: options.effect ?? "allow",
    actionClass,
    targetKind: options.targetKind ?? "thread",
    targetId: options.targetId ?? threadA,
    steerKind:
      options.steerKind !== undefined
        ? options.steerKind
        : actionClass === "steer"
          ? "rebase"
          : null,
    status: options.status ?? "active",
    matchCount: 0,
    lastMatchedAt: null,
    createdAt: "2026-10-20T00:00:00.000Z",
  };
};

const steerRows = (count: number, minutes: number, threadId = threadA) =>
  Array.from({ length: count }, (_, index): SquirePolicyBudgetRow => ({
    kind: "steer",
    threadId,
    executedAt: minutesAgo(minutes + index),
  }));

const self = squire("sq_self", { steer: "auto", createThread: "auto" });

const input = (overrides: Partial<SquirePolicyInput> = {}): SquirePolicyInput => ({
  actionClass: "steer",
  squire: self,
  rules: [],
  target,
  trackers: [],
  budgetRows: [],
  origin: "event",
  steerKind: "rebase",
  now: NOW,
  ...overrides,
});

const allOrigins: ReadonlyArray<SquireCardOrigin> = [
  "event",
  "voice",
  "webhook",
  "test",
  "sweep",
  "message",
  "room",
  "lead",
  "user",
  "unknown",
];
const normalOrigins: ReadonlySet<SquireCardOrigin> = new Set(["event", "room", "lead", "user"]);
const levels: ReadonlyArray<SquirePermissionLevel> = ["off", "recommend", "auto"];

// The spec's downgrade order for an action the permission sets to `level`.
const expectedWithoutRules = (
  level: SquirePermissionLevel,
  origin: SquireCardOrigin,
  blockers: { readonly singleAuto: boolean; readonly budget: boolean },
): SquirePolicyDecision["reason"] | "auto" => {
  if (level !== "auto") return "permission";
  if (origin === "voice") return "voice";
  if (!normalOrigins.has(origin)) return "origin";
  if (blockers.singleAuto) return "single-auto";
  if (blockers.budget) return "budget";
  return "auto";
};

describe("decide: P8 cells x origin x budget x single-Auto", () => {
  const earlierAuto = squire("sq_earlier", {
    steer: "auto",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  const cases = (["steer", "createThread"] as const).flatMap((actionClass) =>
    levels.flatMap((level) =>
      allOrigins.flatMap((origin) =>
        [false, true].flatMap((budget) =>
          [false, true].map((singleAuto) => ({ actionClass, level, origin, budget, singleAuto })),
        ),
      ),
    ),
  );

  it.each(cases)(
    "$actionClass $level origin=$origin budgetExhausted=$budget otherHolder=$singleAuto",
    ({ actionClass, level, origin, budget, singleAuto }) => {
      const actor = squire("sq_self", { steer: level, createThread: level });
      const decision = decide(
        input({
          actionClass,
          squire: actor,
          origin,
          trackers: singleAuto ? [{ squire: earlierAuto, rules: [] }] : [],
          budgetRows: budget
            ? actionClass === "steer"
              ? steerRows(10, 60 * 3, otherTarget.threadId ?? threadA)
              : Array.from({ length: 3 }, () => ({
                  kind: "thread" as const,
                  threadId: null,
                  executedAt: minutesAgo(30),
                }))
            : [],
        }),
      );
      // Single-Auto is a steer-only rule (P2.4).
      const expected = expectedWithoutRules(level, origin, {
        singleAuto: singleAuto && actionClass === "steer",
        budget,
      });
      if (expected === "auto") {
        expect(decision).toEqual({ level: "auto", reason: "permission" });
      } else {
        expect(decision.level).toBe(level === "off" ? "off" : "recommend");
        expect(decision.reason).toBe(expected);
        expect(decision.ruleId).toBeUndefined();
      }
    },
  );

  it.each(
    allOrigins.flatMap((origin) => (["off", "on"] as const).map((notify) => ({ origin, notify }))),
  )("notify $notify origin=$origin", ({ origin, notify }) => {
    const decision = decide(
      input({ actionClass: "notify", squire: squire("sq_self", { notify }), origin }),
    );
    if (notify === "off") expect(decision).toEqual({ level: "off", reason: "permission" });
    else if (origin === "test" || origin === "sweep")
      expect(decision).toEqual({ level: "off", reason: "origin" });
    else expect(decision).toEqual({ level: "auto", reason: "permission" });
  });

  it.each(["steer", "createThread", "notify", "manageSquires"] as const)(
    "a paused Squire is off for %s",
    (actionClass) => {
      const paused = squire("sq_self", { steer: "auto", paused: true, lead: true });
      expect(decide(input({ actionClass, squire: paused }))).toEqual({
        level: "off",
        reason: "paused",
      });
    },
  );

  it("Manage Squires follows the Lead's level and origin, and is off without it", () => {
    for (const level of levels) {
      const lead = squire("sq_lead", { lead: true, manageSquires: level });
      expect(decide(input({ actionClass: "manageSquires", squire: lead })).level).toBe(level);
      expect(
        decide(input({ actionClass: "manageSquires", squire: lead, origin: "sweep" })).level,
      ).toBe(level === "auto" ? "recommend" : level);
    }
    expect(decide(input({ actionClass: "manageSquires", squire: self }))).toEqual({
      level: "off",
      reason: "permission",
    });
  });
});

describe("decide: Lead intersection (P17.8)", () => {
  const cases = (["steer", "createThread", "notify"] as const).flatMap((actionClass) =>
    levels.flatMap((leadLevel) =>
      levels.map((ownerLevel) => ({ actionClass, leadLevel, ownerLevel })),
    ),
  );
  const asNotify = (level: SquirePermissionLevel) => (level === "off" ? "off" : "on");
  const notifyLevel = (level: SquirePermissionLevel): SquirePermissionLevel =>
    level === "off" ? "off" : "auto";

  it.each(cases)(
    "$actionClass lead=$leadLevel owner=$ownerLevel",
    ({ actionClass, leadLevel, ownerLevel }) => {
      const lead = squire("sq_lead", {
        lead: true,
        steer: leadLevel,
        createThread: leadLevel,
        notify: asNotify(leadLevel),
      });
      const owner = squire("sq_owner", {
        steer: ownerLevel,
        createThread: ownerLevel,
        notify: asNotify(ownerLevel),
      });
      const decision = decide(input({ actionClass, squire: owner, lead }));
      const [leadEffective, ownerEffective] =
        actionClass === "notify"
          ? [notifyLevel(leadLevel), notifyLevel(ownerLevel)]
          : [leadLevel, ownerLevel];
      const levelRank = { off: 0, recommend: 1, auto: 2 };
      const lower = levelRank[ownerEffective] < levelRank[leadEffective];
      expect(decision).toEqual({
        level: lower ? ownerEffective : leadEffective,
        reason: lower ? "intersection" : "permission",
      });
    },
  );

  it("cannot exceed a recommend-only Squire, even with the owner's allow rule", () => {
    const lead = squire("sq_lead", { lead: true, steer: "auto" });
    const owner = squire("sq_owner", { steer: "recommend" });
    expect(decide(input({ squire: owner, lead, rules: [rule("r1", owner)] }))).toEqual({
      level: "recommend",
      reason: "intersection",
    });
  });

  it("ignores the owner's ask-first rules", () => {
    const lead = squire("sq_lead", { lead: true, steer: "auto" });
    const owner = squire("sq_owner", { steer: "auto" });
    const askFirst = rule("r1", owner, { effect: "ask-first" });
    expect(decide(input({ squire: owner, lead, rules: [askFirst] }))).toEqual({
      level: "auto",
      reason: "permission",
    });
  });

  it("charges the owner's budgets and keeps origin downgrades", () => {
    const lead = squire("sq_lead", { lead: true, steer: "auto" });
    const owner = squire("sq_owner", { steer: "auto", budgets: { steersPerThreadPerHour: 1 } });
    expect(decide(input({ squire: owner, lead, budgetRows: steerRows(1, 10) }))).toMatchObject({
      level: "recommend",
      reason: "budget",
    });
    expect(decide(input({ squire: owner, lead, origin: "sweep" }))).toEqual({
      level: "recommend",
      reason: "origin",
    });
  });

  it("does not count the Lead toward single-Auto, but the owner must hold it", () => {
    const lead = squire("sq_lead", {
      lead: true,
      steer: "auto",
      createdAt: "2020-01-01T00:00:00Z",
    });
    const owner = squire("sq_owner", { steer: "auto" });
    const leadTracker = { squire: lead, rules: [] };
    expect(decide(input({ squire: owner, lead, trackers: [leadTracker] })).level).toBe("auto");
    const earlier = squire("sq_earlier", { steer: "auto", createdAt: "2026-09-01T00:00:00Z" });
    expect(
      decide(input({ squire: owner, lead, trackers: [{ squire: earlier, rules: [] }] })),
    ).toEqual({ level: "recommend", reason: "single-auto" });
  });

  it("a paused Lead is off", () => {
    const lead = squire("sq_lead", { lead: true, steer: "auto", paused: true });
    expect(decide(input({ squire: self, lead }))).toEqual({ level: "off", reason: "paused" });
  });
});

describe("single-Auto per thread (P2.4, D15)", () => {
  const first = squire("sq_first", { steer: "auto", createdAt: "2026-09-01T00:00:00Z" });
  const second = squire("sq_second", { steer: "recommend", createdAt: "2026-09-02T00:00:00Z" });
  const tracker = (squire: SquirePolicySquire, rules: ReadonlyArray<SquireRule> = []) => ({
    squire,
    rules,
  });

  it("at save: the later Squire turning steer Auto gets single-auto and sees the conflict", () => {
    const saved = { ...second, permissions: { ...second.permissions, steer: "auto" as const } };
    expect(decide(input({ squire: second, trackers: [tracker(first)] })).reason).toBe("permission");
    expect(decide(input({ squire: saved, trackers: [tracker(first)] }))).toEqual({
      level: "recommend",
      reason: "single-auto",
    });
    const threads = [{ target: { ...target, threadId: threadA }, trackers: [tracker(first)] }];
    expect(conflicts(tracker(saved), threads)).toEqual([
      { threadId: threadA, autoHolderSquireId: first.id },
    ]);
    expect(conflicts(tracker(first), [{ ...threads[0]!, trackers: [tracker(saved)] }])).toEqual([]);
    // The earlier Squire saving back to Recommend hands Auto over.
    const demoted = {
      ...first,
      permissions: { ...first.permissions, steer: "recommend" as const },
    };
    expect(decide(input({ squire: saved, trackers: [tracker(demoted)] })).level).toBe("auto");
  });

  it("at grant add: an earlier Auto Squire granting the thread takes it over", () => {
    const later = squire("sq_later", { steer: "auto", createdAt: "2026-10-05T00:00:00Z" });
    expect(decide(input({ squire: later, trackers: [tracker(later)] })).level).toBe("auto");
    expect(decide(input({ squire: later, trackers: [tracker(later), tracker(first)] }))).toEqual({
      level: "recommend",
      reason: "single-auto",
    });
    expect(decide(input({ squire: first, trackers: [tracker(later), tracker(first)] })).level).toBe(
      "auto",
    );
  });

  it("at new thread: a thread in a container granted to two Auto Squires goes to the earliest", () => {
    const later = squire("sq_later", { steer: "auto", createdAt: "2026-10-05T00:00:00Z" });
    const newThread = { ...target, threadId: ThreadId.make("thr_new") };
    expect(autoHolder([tracker(later), tracker(first)], newThread)).toBe(first.id);
    expect(
      decide(input({ squire: later, target: newThread, trackers: [tracker(first)] })).reason,
    ).toBe("single-auto");
  });

  it("breaks a createdAt tie by creation order and skips paused Squires and the Lead", () => {
    const a = squire("sq_a", { steer: "auto", createdAt: "2026-09-01T00:00:00Z" });
    const b = squire("sq_b", { steer: "auto", createdAt: "2026-09-01T00:00:00Z" });
    // Trackers come in creation order (rowid), never by id.
    expect(autoHolder([tracker(b), tracker(a)], target)).toBe(b.id);
    expect(autoHolder([tracker(a), tracker(b)], target)).toBe(a.id);
    const pausedEarly = squire("sq_0", {
      steer: "auto",
      paused: true,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const lead = squire("sq_lead", {
      lead: true,
      steer: "auto",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(autoHolder([tracker(pausedEarly), tracker(lead), tracker(b)], target)).toBe(b.id);
    expect(autoHolder([tracker(second)], target)).toBeNull();
  });

  it("a covering allow rule makes a holder, which loses to an earlier Auto Squire", () => {
    const ruleHolder = squire("sq_rule", { steer: "recommend", createdAt: "2026-10-10T00:00:00Z" });
    const allow = rule("r_allow", ruleHolder, {
      targetKind: "project",
      targetId: target.projectId,
    });
    expect(
      decide(input({ squire: ruleHolder, rules: [allow], trackers: [tracker(first)] })),
    ).toEqual({ level: "recommend", reason: "single-auto" });
    const threads = [{ target: { ...target, threadId: threadA }, trackers: [tracker(first)] }];
    expect(conflicts(tracker(ruleHolder, [allow]), threads)).toEqual([
      { threadId: threadA, autoHolderSquireId: first.id },
    ]);
  });

  it("an earlier rule holder beats a later Auto Squire", () => {
    const ruleHolder = squire("sq_rule", { steer: "recommend", createdAt: "2026-08-01T00:00:00Z" });
    const allow = rule("r_allow", ruleHolder);
    const later = squire("sq_later", { steer: "auto", createdAt: "2026-10-05T00:00:00Z" });
    const trackers = [tracker(ruleHolder, [allow]), tracker(later)];
    expect(autoHolder(trackers, target)).toBe(ruleHolder.id);
    expect(decide(input({ squire: later, trackers })).reason).toBe("single-auto");
    expect(decide(input({ squire: ruleHolder, rules: [allow], trackers }))).toEqual({
      level: "auto",
      reason: "rule",
      ruleId: allow.id,
    });
  });

  it("rules that cannot match never make a holder", () => {
    const holder = squire("sq_rule", { steer: "recommend", createdAt: "2026-08-01T00:00:00Z" });
    const offHolder = squire("sq_off", { steer: "off", createdAt: "2026-08-01T00:00:00Z" });
    const never = [
      tracker(holder, [rule("r1", holder, { steerKind: "other" })]),
      tracker(holder, [rule("r2", holder, { status: "disabled" })]),
      tracker(holder, [rule("r3", holder, { effect: "ask-first" })]),
      tracker(holder, [rule("r4", holder, { targetId: "thr_elsewhere" })]),
      tracker(holder, [
        rule("r5", holder, {
          actionClass: "createThread",
          targetKind: "project",
          targetId: target.projectId,
        }),
      ]),
      tracker(offHolder, [rule("r6", offHolder)]),
    ];
    for (const candidate of never) expect(autoHolder([candidate], target)).toBeNull();
  });

  it("createThread ignores single-Auto", () => {
    const creator = squire("sq_c", { createThread: "auto", createdAt: "2026-10-05T00:00:00Z" });
    expect(
      decide(input({ actionClass: "createThread", squire: creator, trackers: [tracker(first)] }))
        .level,
    ).toBe("auto");
  });
});

describe("decide: rules (P8.1, D58) x origin x class", () => {
  const ruleSets = ["none", "allow", "ask-first", "both"] as const;
  const cases = (["steer", "createThread"] as const).flatMap((actionClass) =>
    levels.flatMap((level) =>
      ruleSets.flatMap((rules) =>
        allOrigins.map((origin) => ({ actionClass, level, rules, origin })),
      ),
    ),
  );

  it.each(cases)(
    "$actionClass $level rules=$rules origin=$origin",
    ({ actionClass, level, rules, origin }) => {
      const actor = squire("sq_self", { steer: level, createThread: level });
      const ruleTarget =
        actionClass === "steer"
          ? {}
          : { targetKind: "project" as const, targetId: target.projectId };
      const allow = rule("r_allow", actor, { actionClass, ...ruleTarget });
      const askFirst = rule("r_ask", actor, { actionClass, effect: "ask-first", ...ruleTarget });
      const active =
        rules === "allow"
          ? [allow]
          : rules === "ask-first"
            ? [askFirst]
            : rules === "both"
              ? [askFirst, allow]
              : [];
      const decision = decide(
        input({
          actionClass,
          squire: actor,
          rules: active,
          origin,
          target: actionClass === "steer" ? target : { ...target, threadId: null },
        }),
      );
      const hasAllow = rules === "allow" || rules === "both";
      const hasAsk = rules === "ask-first" || rules === "both";
      const rulesApply = normalOrigins.has(origin);
      if (level === "off") {
        expect(decision).toEqual({ level: "off", reason: "permission" });
      } else if (!rulesApply) {
        expect(decision).toEqual({
          level: "recommend",
          reason: level === "recommend" ? "permission" : origin === "voice" ? "voice" : "origin",
        });
      } else if (hasAsk && (level === "auto" || hasAllow)) {
        expect(decision).toEqual({ level: "recommend", reason: "rule", ruleId: askFirst.id });
      } else if (hasAllow && level === "recommend") {
        expect(decision).toEqual({ level: "auto", reason: "rule", ruleId: allow.id });
      } else {
        expect(decision).toEqual({ level, reason: "permission" });
      }
    },
  );

  const recommender = squire("sq_self", { steer: "recommend", createThread: "recommend" });
  const steerWith = (ruleRow: SquireRule, steerKind: SquireSteerKind = "rebase", t = target) =>
    decide(input({ squire: recommender, rules: [ruleRow], steerKind, target: t })).level;

  it("steer kinds match exactly and `other` never matches", () => {
    expect(steerWith(rule("r", recommender))).toBe("auto");
    expect(steerWith(rule("r", recommender), "continue")).toBe("recommend");
    expect(steerWith(rule("r", recommender, { steerKind: "other" }), "other")).toBe("recommend");
    expect(
      decide(input({ squire: recommender, rules: [rule("r", recommender)], steerKind: undefined }))
        .level,
    ).toBe("recommend");
  });

  it.each([
    ["thread", threadA],
    ["project", "proj_a"],
    ["staveSpace", "space_a"],
    ["staveSaga", "saga_a"],
  ] as const)("a %s rule matches its container and nothing else", (targetKind, targetId) => {
    const ruleRow = rule("r", recommender, { targetKind, targetId });
    expect(steerWith(ruleRow)).toBe("auto");
    expect(steerWith(ruleRow, "rebase", otherTarget)).toBe("recommend");
  });

  it("a saga rule never matches a thread outside any saga", () => {
    const ruleRow = rule("r", recommender, { targetKind: "staveSaga", targetId: "saga_a" });
    expect(steerWith(ruleRow, "rebase", { ...target, staveSagaId: null })).toBe("recommend");
  });

  it("ignores disabled rules, other Squires' rules, and the other class's rules", () => {
    const stranger = squire("sq_stranger");
    expect(steerWith(rule("r", recommender, { status: "disabled" }))).toBe("recommend");
    expect(steerWith(rule("r", stranger))).toBe("recommend");
    const createRule = rule("r", recommender, {
      actionClass: "createThread",
      targetKind: "project",
      targetId: target.projectId,
    });
    expect(steerWith(createRule)).toBe("recommend");
  });

  it("an allow-raised Auto still meets budgets, without the rule id", () => {
    const tight = squire("sq_self", { steer: "recommend", budgets: { steersPerDay: 2 } });
    expect(
      decide(input({ squire: tight, rules: [rule("r", tight)], budgetRows: steerRows(2, 120) })),
    ).toEqual({
      level: "recommend",
      reason: "budget",
      recommendingUntil: minutesAhead(24 * 60 - 121),
    });
  });

  it("a removed rule turns a re-validated hold into a recommendation (D58)", () => {
    const allow = rule("r", recommender);
    expect(decide(input({ squire: recommender, rules: [allow] })).level).toBe("auto");
    expect(decide(input({ squire: recommender, rules: [] }))).toEqual({
      level: "recommend",
      reason: "permission",
    });
  });
});

describe("budgets (P9.2)", () => {
  const budgetFor = (
    rows: ReadonlyArray<SquirePolicyBudgetRow>,
    budgets: Partial<SquirePolicySquire["budgets"]> = {},
    actionClass: "steer" | "createThread" = "steer",
    threadId: ThreadId | null = threadA,
  ) =>
    checkBudget({
      actionClass,
      budgets: { ...DEFAULT_SQUIRE_BUDGETS, ...budgets },
      threadId,
      budgetRows: rows,
      now: NOW,
    });

  it("per thread per hour frees when the oldest counted row leaves the hour", () => {
    expect(budgetFor(steerRows(1, 10))).toEqual({ exhausted: false });
    expect(budgetFor(steerRows(2, 10))).toEqual({
      exhausted: true,
      recommendingUntil: minutesAhead(60 - 11),
    });
    expect(budgetFor(steerRows(2, 61))).toEqual({ exhausted: false });
    expect(budgetFor(steerRows(2, 10, ThreadId.make("thr_b")))).toEqual({ exhausted: false });
    expect(budgetFor(steerRows(5, 10), {}, "steer", null)).toEqual({ exhausted: false });
  });

  it("per Squire per day counts steers on every thread", () => {
    const rows = [
      ...steerRows(5, 120, ThreadId.make("thr_b")),
      ...steerRows(5, 300, ThreadId.make("thr_c")),
    ];
    expect(budgetFor(rows)).toEqual({
      exhausted: true,
      recommendingUntil: minutesAhead(24 * 60 - 304),
    });
    expect(budgetFor(rows.slice(1))).toEqual({ exhausted: false });
  });

  it("reports the later time when both windows are exhausted", () => {
    const rows = [...steerRows(2, 5), ...steerRows(8, 600, ThreadId.make("thr_b"))];
    expect(budgetFor(rows)).toEqual({
      exhausted: true,
      recommendingUntil: minutesAhead(24 * 60 - 607),
    });
  });

  it("counts only thread rows for createThread", () => {
    const threadRows = Array.from({ length: 3 }, (_, index) => ({
      kind: "thread" as const,
      threadId: null,
      executedAt: minutesAgo(60 + index),
    }));
    expect(budgetFor(steerRows(3, 10), {}, "createThread")).toEqual({ exhausted: false });
    expect(budgetFor(threadRows, {}, "createThread")).toEqual({
      exhausted: true,
      recommendingUntil: minutesAhead(24 * 60 - 62),
    });
    const messageRows = [{ kind: "message" as const, threadId: null, executedAt: minutesAgo(1) }];
    expect(budgetFor(messageRows, { threadsPerDay: 1 }, "createThread")).toEqual({
      exhausted: false,
    });
  });

  it("a zero budget is exhausted with no end time", () => {
    expect(budgetFor([], { steersPerThreadPerHour: 0 })).toEqual({ exhausted: true });
    expect(
      decide(input({ squire: squire("sq_self", { steer: "auto", budgets: { steersPerDay: 0 } }) })),
    ).toEqual({ level: "recommend", reason: "budget" });
  });

  it("decide downgrades with recommendingUntil and leaves non-Auto levels alone", () => {
    expect(decide(input({ budgetRows: steerRows(2, 10) }))).toEqual({
      level: "recommend",
      reason: "budget",
      recommendingUntil: minutesAhead(49),
    });
    const recommender = squire("sq_self", { steer: "recommend" });
    expect(decide(input({ squire: recommender, budgetRows: steerRows(2, 10) }))).toEqual({
      level: "recommend",
      reason: "permission",
    });
  });
});

describe("conflicts", () => {
  it("lists only threads where this Squire wants Auto and another holds it", () => {
    const first = squire("sq_first", { steer: "auto", createdAt: "2026-09-01T00:00:00Z" });
    const later = squire("sq_later", { steer: "auto", createdAt: "2026-10-05T00:00:00Z" });
    const recommender = squire("sq_rec", { createdAt: "2026-10-05T00:00:00Z" });
    const firstTracker: SquirePolicyTracker = { squire: first, rules: [] };
    const threads = [
      { target: { ...target, threadId: threadA }, trackers: [firstTracker] },
      { target: { ...otherTarget, threadId: ThreadId.make("thr_b") }, trackers: [] },
    ];
    expect(conflicts({ squire: later, rules: [] }, threads)).toEqual([
      { threadId: threadA, autoHolderSquireId: first.id },
    ]);
    expect(conflicts({ squire: recommender, rules: [] }, threads)).toEqual([]);
  });
});
