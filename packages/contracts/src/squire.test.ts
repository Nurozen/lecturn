import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { isUnknownUnionMember } from "./baseSchemas.ts";
import {
  DEFAULT_SQUIRE_BUDGETS,
  DEFAULT_SQUIRE_COMPANION,
  DEFAULT_SQUIRE_PERMISSIONS,
  SquireCompanion,
  SquireCompanionChoice,
  SquireError,
  SquireEvent,
  SquireLeadOpenInput,
  SquireOnboardingContext,
  Squire,
  SquireSteerKind,
  SquireTurnSummary,
  SQUIRE_LEAD_COMPANION,
  squireDistinctChoice,
  squireDistinctCompanion,
} from "./squire.ts";
import {
  SquireFakeScript,
  SquireFixtureScenario,
  SquireSummaryGoldFixture,
  SquireSummaryStressFixture,
} from "./squireFixture.ts";

// Contracts has no Node types; Vite expands the glob, so new fixture files are covered.
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true; import: "default" }): Record<string, unknown>;
  }
}

const jsonFiles = (modules: Record<string, unknown>) =>
  Object.entries(modules).map(([path, json]) => ({ name: path.split("/").at(-1)!, json }));

const scenarioFiles = jsonFiles(
  import.meta.glob("../../../apps/server/src/squire/testdata/scenarios/*.json", {
    eager: true,
    import: "default",
  }),
);
const fakeFiles = jsonFiles(
  import.meta.glob("../../../apps/server/src/squire/testdata/fake/*.json", {
    eager: true,
    import: "default",
  }),
);

const schemaForScenarioFile = (name: string) =>
  name === "summary-gold.json"
    ? SquireSummaryGoldFixture
    : name === "summary-stress.json"
      ? SquireSummaryStressFixture
      : SquireFixtureScenario;

const roundTrip = <S extends Schema.Codec<unknown, unknown>>(schema: S, json: unknown) => {
  const decode = Schema.decodeUnknownSync(schema);
  const decoded = decode(json);
  const again = decode(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(decoded))));
  return { decoded, again };
};

const decodeScenario = Schema.decodeUnknownSync(SquireFixtureScenario);
const decodeSummary = Schema.decodeUnknownSync(SquireTurnSummary);
const decodeEvent = Schema.decodeUnknownSync(SquireEvent);
const decodeCompanion = Schema.decodeUnknownSync(SquireCompanion);
const decodeFake = Schema.decodeUnknownSync(SquireFakeScript);
const decodeGold = Schema.decodeUnknownSync(SquireSummaryGoldFixture);
const decodeStress = Schema.decodeUnknownSync(SquireSummaryStressFixture);
const decodeCompanionChoice = Schema.decodeUnknownSync(SquireCompanionChoice);
const decodeError = Schema.decodeUnknownSync(SquireError);
const decodeSteerKind = Schema.decodeUnknownSync(SquireSteerKind);
const decodeOnboardingContext = Schema.decodeUnknownSync(SquireOnboardingContext);

const scenario = (name: string) => {
  const file = scenarioFiles.find((candidate) => candidate.name === name);
  if (!file) throw new Error(`missing fixture ${name}`);
  return file.json as Record<string, unknown>;
};

describe("tracked Squire fixtures", () => {
  it("include every B2 oracle scenario", () => {
    const ids = scenarioFiles.map((file) => file.name.replace(/\.json$/, ""));
    for (const id of [
      "00-lead-onboarding",
      "07-overlap-risk",
      "08-auto-hold-executes",
      "09-auto-hold-undo",
      "10-budget-exhausted-after-hold",
      "11-overdue-hold",
      "research-idle",
      "lead-fake",
      "summary-stress",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it.each(scenarioFiles)("round-trips scenario $name", ({ name, json }) => {
    const { decoded, again } = roundTrip(schemaForScenarioFile(name), json);
    expect(again).toEqual(decoded);
    expect((decoded as { schemaVersion?: number }).schemaVersion).toBe(2);
  });

  it.each(fakeFiles)("round-trips fake script $name", ({ json }) => {
    const { decoded, again } = roundTrip(SquireFakeScript, json);
    expect(again).toEqual(decoded);
  });

  it("names a fake script that exists", () => {
    const fakes = new Set(fakeFiles.map((file) => file.name.replace(/\.json$/, "")));
    for (const { name, json } of scenarioFiles) {
      if (schemaForScenarioFile(name) !== SquireFixtureScenario) continue;
      const fixture = decodeScenario(json);
      if (fixture.fake !== undefined) expect(fakes).toContain(fixture.fake);
    }
  });

  it("decodes every scenario event summary and the gold as SquireTurnSummary", () => {
    const gold = scenario("summary-gold.json") as { gold: unknown };
    expect(decodeSummary(gold.gold).turnId).toBe("t_42");
    let summaries = 0;
    for (const { name, json } of scenarioFiles) {
      if (schemaForScenarioFile(name) !== SquireFixtureScenario) continue;
      for (const event of (json as { events: Array<{ summary?: unknown }> }).events) {
        if (event.summary === undefined) continue;
        decodeSummary(event.summary);
        summaries++;
      }
    }
    expect(summaries).toBeGreaterThanOrEqual(10);
  });

  it("decodes a v1 scenario that has no schemaVersion", () => {
    const { schemaVersion: _, ...v1 } = scenario("01-ci-failure-recommend.json");
    expect(decodeScenario(v1).schemaVersion).toBeUndefined();
  });

  it("keeps the summary gold input in v2 run vocabulary", () => {
    const gold = decodeGold(scenario("summary-gold.json"));
    expect(gold.fixture.session).toEqual({
      status: "completed",
      pendingRuntimeRequest: null,
      interruptedBy: null,
    });
    const v1Session = {
      ...(scenario("summary-gold.json") as Record<string, Record<string, unknown>>),
    };
    v1Session.fixture = {
      ...v1Session.fixture,
      session: { status: "ready", completedTurnId: "t_42", pendingApprovals: [] },
    };
    expect(() => decodeGold(v1Session)).toThrow();
  });

  it("puts the stress summary at every schema maximum, and one past it fails", () => {
    const stress = decodeStress(scenario("summary-stress.json")).summary;
    expect(stress.completed).toHaveLength(5);
    expect(stress.remaining).toHaveLength(3);
    expect(stress.blocked).toHaveLength(3);
    expect(stress.files.entries).toHaveLength(10);
    expect(stress.commands).toHaveLength(5);
    expect(stress.pullRequest?.checks.failingJobs.length).toBeGreaterThan(0);
    const tooMany = {
      ...stress,
      files: { ...stress.files, entries: [...stress.files.entries, stress.files.entries[0]] },
    };
    expect(() => decodeSummary(tooMany)).toThrow();
  });

  it("templates the PR number in both fake 01 scripts", () => {
    for (const name of ["01-ci-failure-recommend.json", "01-ci-failure-recommend-auto.json"]) {
      const text = JSON.stringify(fakeFiles.find((file) => file.name === name)?.json);
      expect(text).toContain("#{{event.summary.pullRequest.number}}");
      expect(text).not.toContain("318");
    }
  });

  it("rejects a fake template that does not read the event", () => {
    const script = {
      steps: [
        {
          onEvent: "turn-finished",
          toolCalls: [{ name: "squire_stay_quiet", args: { reason: "{{summary.goal}}" } }],
        },
      ],
    };
    expect(() => decodeFake(script)).toThrow();
    expect(() => decodeFake({ steps: [{ onEvent: "*" }] })).toThrow();
  });
});

describe("SquireCompanion", () => {
  it("reads a v5 exported appearance as a figure and drops its runtime keys", () => {
    const companion = decodeCompanion({
      presence: "companion",
      appearance: "male",
      hood: "up",
      equipment: "lance",
      frame: "orbit",
      weight: "regular",
      glow: "soft",
      palette: "sage",
      motion: "still",
      gaze: "auto",
      state: "thinking",
      transitions: "on",
      debug: "false",
    });
    expect(companion).toEqual({
      presence: "figure",
      appearance: "male",
      hood: "up",
      equipment: "lance",
      frame: "orbit",
      weight: "regular",
      glow: "soft",
      palette: "sage",
      motion: "still",
    });
  });

  it("defaults every key and reads unknown values as the default", () => {
    expect(decodeCompanion(undefined)).toEqual(DEFAULT_SQUIRE_COMPANION);
    const companion = decodeCompanion({ equipment: "trident", palette: "cobalt", hood: "up" });
    expect(companion.equipment).toBe(DEFAULT_SQUIRE_COMPANION.equipment);
    expect(companion.palette).toBe(DEFAULT_SQUIRE_COMPANION.palette);
    expect(companion.hood).toBe("up");
  });

  it("keeps gold for the Lead", () => {
    expect(decodeCompanion({ palette: "gold" }).palette).toBe("gold");
    expect(() => decodeCompanionChoice({ palette: "gold" })).toThrow();
    expect(decodeCompanionChoice({ palette: "rose" }).palette).toBe("rose");
  });

  it("keeps the Lead's equipment for the Lead", () => {
    const lead = SQUIRE_LEAD_COMPANION.equipment;
    const taken: Array<SquireCompanion> = [];
    for (let i = 0; i < 6; i++) {
      const next = squireDistinctCompanion(taken);
      expect(next.equipment).not.toBe(lead);
      taken.push(next);
    }
    const chosen = { ...DEFAULT_SQUIRE_COMPANION, hood: "up" as const, palette: "rose" as const };
    const kept = squireDistinctChoice([], { ...chosen, equipment: lead });
    expect(kept).toEqual({ ...chosen, equipment: "helmet" });
    // A Lead already stored with other equipment keeps that one to itself.
    const helmeted = { ...SQUIRE_LEAD_COMPANION, equipment: "helmet" as const };
    expect(squireDistinctChoice([helmeted], { ...chosen, equipment: "helmet" }).equipment).toBe(
      "lance",
    );
    expect(squireDistinctChoice([helmeted], { ...chosen, equipment: lead }).equipment).toBe(lead);
  });
});

describe("Lead onboarding contracts (7.1)", () => {
  const context = {
    projects: [
      {
        projectId: "billing-service",
        name: "billing-service",
        staveSpaceId: "space-1",
        lastActivityAt: "2026-10-31T17:00:00.000Z",
        threadCount: 2,
        threads: [
          {
            threadId: "thr_fix_invoice_rounding",
            title: "Fix invoice rounding",
            status: "idle",
            lastActivityAt: "2026-10-31T17:00:00.000Z",
            pullRequests: [{ number: 318, state: "open" }],
            headline: "Round half-even in the invoice total",
          },
        ],
      },
    ],
  };

  it("round-trips an onboarding event with and without its context", () => {
    for (const event of [{ type: "onboarding" }, { type: "onboarding", context }]) {
      const { decoded, again } = roundTrip(SquireEvent, event);
      expect(again).toEqual(decoded);
      expect(decoded).toEqual(event);
    }
  });

  it("bounds the onboarding context", () => {
    const thread = context.projects[0]!.threads[0]!;
    const project = { ...context.projects[0]!, threads: Array.from({ length: 9 }, () => thread) };
    expect(() => decodeOnboardingContext({ projects: [project] })).toThrow();
    expect(() =>
      decodeOnboardingContext({
        projects: Array.from({ length: 21 }, () => context.projects[0]),
      }),
    ).toThrow();
  });

  it("takes the client's timezone on open, optionally", () => {
    const decode = Schema.decodeUnknownSync(SquireLeadOpenInput);
    expect(decode({ requestId: "r-1" })).toEqual({ requestId: "r-1" });
    expect(
      roundTrip(SquireLeadOpenInput, { requestId: "r-1", timezone: "Europe/Berlin" }).again,
    ).toEqual({ requestId: "r-1", timezone: "Europe/Berlin" });
  });

  it("keeps the Lead's timezone on the record, not in the digest", () => {
    expect(Squire.fields.timezone).toBeDefined();
    expect(Object.keys(Squire.fields.digest.members[0].fields)).toEqual(["time", "push"]);
  });
});

describe("Squire forward compatibility", () => {
  it("decodes an unknown event type as an unknown member", () => {
    expect(isUnknownUnionMember(decodeEvent({ type: "calendar-due", at: "2027-01-01" }))).toBe(
      true,
    );
  });

  it("still fails a known event with a broken payload", () => {
    expect(() => decodeEvent({ type: "voice-note", transcript: "hi" })).toThrow();
  });

  it("reads unknown error codes and steer kinds as their fallbacks", () => {
    const error = decodeError({
      _tag: "SquireError",
      code: "quota_frozen",
      message: "later build",
    });
    expect(error.code).toBe("unknown");
    expect(decodeSteerKind("bisect")).toBe("other");
  });

  it("applies the P8 and P9 defaults", () => {
    expect(DEFAULT_SQUIRE_PERMISSIONS).toEqual({
      steer: "recommend",
      createThread: "recommend",
      notify: "on",
    });
    expect(DEFAULT_SQUIRE_BUDGETS).toMatchObject({
      steersPerDay: 10,
      threadsPerDay: 3,
      steersPerThreadPerHour: 2,
      messagesPerDay: 20,
    });
  });
});

describe("Squire fixture schema v2 focused-test additions", () => {
  const base = scenario("research-idle.json");

  it("decodes rules, triggers, sweep, and rooms in setup", () => {
    const fixture = decodeScenario({
      ...base,
      setup: {
        ...(base.setup as object),
        rules: [
          {
            effect: "allow",
            actionClass: "steer",
            target: { kind: "project", name: "billing-service" },
            steerKind: "rebase",
          },
        ],
        triggers: [
          {
            triggerId: "trg_weekday_review",
            kind: "schedule",
            name: "Weekdays at 9:00",
            instruction: "Check the release threads for PRs waiting on review",
            schedule: { kind: "daily", time: "09:00", weekdaysOnly: true },
          },
          { kind: "webhook", name: "When Sentry reports a new error", instruction: "Triage it" },
        ],
        sweep: { schedule: { kind: "interval", hours: 6 } },
        rooms: [{ topic: "Rounding rollout", members: ["Release", "Research"] }],
      },
    });
    expect(fixture.setup.triggers).toHaveLength(2);
    expect(fixture.setup.sweep?.findingsPerSweep).toBe(3);
  });

  it("drops a webhook secret from a fixture and refuses a sub-4-hour sweep", () => {
    const withSetup = (extra: object) =>
      decodeScenario({ ...base, setup: { ...(base.setup as object), ...extra } });
    expect(
      withSetup({
        triggers: [{ kind: "webhook", name: "n", instruction: "i", secret: "s" }],
      }).setup.triggers?.[0],
    ).not.toHaveProperty("secret");
    expect(() => withSetup({ sweep: { schedule: { kind: "interval", hours: 2 } } })).toThrow();
  });

  it.each([
    { type: "routed-task", taskId: "task_1", text: "Rerun api-e2e on #318", reason: "Release" },
    {
      type: "schedule-due",
      triggerId: "trg_1",
      slot: "2026-11-02T17:00:00Z",
      instruction: "Check PRs waiting on review",
    },
    {
      type: "webhook-received",
      triggerId: "trg_2",
      deliveryId: "d-1",
      instruction: "Triage new errors",
      payloadExcerpt: '{"level":"error"}',
    },
    {
      type: "sweep-due",
      sweepKey: "2026-11-02T16:00:00Z",
      source: "schedule",
      candidates: [
        {
          threadId: "thr_fix_invoice_rounding",
          kind: "idle-unmerged-pr",
          pullRequestNumber: 318,
          headSha: "9f2c4e1",
        },
      ],
    },
    {
      type: "message",
      messageKey: "key_1",
      from: { kind: "squire", squireId: "sq_release" },
      hop: 1,
      body: "Check whether #318 touches the currency formatter",
    },
    {
      type: "room-proposed",
      proposalId: "prop_1",
      fromSquireId: "sq_release",
      members: ["sq_release", "sq_research"],
      topic: "Rounding rollout",
      about: [{ kind: "pullRequest", number: 318 }],
      reason: "Both Squires track #318's files",
    },
  ])("injects a $type event", (event) => {
    const fixture = decodeScenario({ ...base, events: [event] });
    expect(fixture.events[0]).toMatchObject({ type: event.type });
  });
});
