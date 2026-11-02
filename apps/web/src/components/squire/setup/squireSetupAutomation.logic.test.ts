import {
  SQUIRE_MAX_TRIGGERS,
  SquireId,
  SquireTriggerId,
  type SquireActionLogEntry,
  type SquireTrigger,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  squireCanAddTrigger,
  squireLeadSweepOutcomeText,
  squireScheduleSentence,
  squireSecretRevealReducer,
  squireSweepAcceptance,
  squireSweepAcceptanceText,
  squireTriggerControls,
  squireTriggerDraftInput,
  EMPTY_SQUIRE_TRIGGER_DRAFT,
  squireTriggerLimitText,
  squireTriggerRunLabel,
  squireTriggerSentence,
  type SquireSecretReveal,
} from "./squireSetupAutomation.logic";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const at = (iso: string) => `at ${iso.slice(11, 16)}`;

const trigger = (overrides: Partial<SquireTrigger> = {}): SquireTrigger => ({
  id: SquireTriggerId.make("trigger-1"),
  squireId: SquireId.make("squire-1"),
  name: "When Sentry reports a new error in billing-service",
  kind: "webhook",
  instruction: "Check the release threads",
  status: "active",
  schedule: null,
  nextSlotAt: null,
  secretGeneration: 1,
  limitedUntil: null,
  createdAt: "2026-10-31T09:00:00.000Z",
  ...overrides,
});

const WEBHOOK_ADVANCED = ["url", "secret", "rotate", "revoke", "test"] as const;

describe("trigger intent sentences", () => {
  it("renders interval, daily, and weekday schedules from their slots", () => {
    expect(squireScheduleSentence({ kind: "interval", hours: 2 })).toBe("Every 2 hours");
    expect(squireScheduleSentence({ kind: "interval", hours: 1 })).toBe("Every hour");
    expect(squireScheduleSentence({ kind: "daily", time: "09:00", weekdaysOnly: false })).toBe(
      "Daily at 9:00",
    );
    expect(squireScheduleSentence({ kind: "daily", time: "09:00", weekdaysOnly: true })).toBe(
      "Weekdays at 9:00",
    );
  });

  it("follows the client's 12 h clock", () => {
    expect(squireScheduleSentence({ kind: "daily", time: "17:30", weekdaysOnly: true }, true)).toBe(
      "Weekdays at 5:30 PM",
    );
    expect(
      squireScheduleSentence({ kind: "daily", time: "00:05", weekdaysOnly: false }, true),
    ).toBe("Daily at 12:05 AM");
  });

  it("reads a schedule from its slots, not its stored name, and a webhook by its sentence", () => {
    expect(
      squireTriggerSentence(
        trigger({ kind: "schedule", name: "old", schedule: { kind: "interval", hours: 3 } }),
      ),
    ).toBe("Every 3 hours");
    expect(squireTriggerSentence(trigger())).toBe(
      "When Sentry reports a new error in billing-service",
    );
  });
});

describe("custom webhook disclosure", () => {
  it("keeps every webhook control out of the default view, including a just-created trigger", () => {
    const created = trigger({ secretGeneration: 1 });
    const collapsed = squireTriggerControls(created, false);
    for (const control of WEBHOOK_ADVANCED) expect(collapsed).not.toContain(control);
    expect(collapsed).toContain("advanced");
    expect(squireTriggerControls(created, true)).toEqual(
      expect.arrayContaining([...WEBHOOK_ADVANCED]),
    );
  });

  it("shows a schedule's Test now in the default view", () => {
    const schedule = trigger({ kind: "schedule", schedule: { kind: "interval", hours: 2 } });
    const controls = squireTriggerControls(schedule, false);
    expect(controls).toContain("test");
    expect(controls).not.toContain("advanced");
    expect(controls).not.toContain("url");
  });

  it("offers Resume for a paused trigger and nothing but history for a revoked one", () => {
    expect(squireTriggerControls(trigger({ status: "paused" }), false)).toContain("resume");
    expect(squireTriggerControls(trigger({ status: "revoked" }), true)).toEqual(["runs"]);
  });

  it("caps live triggers and never offers them on the Lead", () => {
    const live = Array.from({ length: SQUIRE_MAX_TRIGGERS }, () => trigger());
    expect(squireCanAddTrigger("squire", live)).toBe(false);
    expect(squireCanAddTrigger("squire", [...live.slice(1), trigger({ status: "revoked" })])).toBe(
      true,
    );
    expect(squireCanAddTrigger("lead", [])).toBe(false);
  });
});

describe("secret reveal", () => {
  const webhook = { secret: "s3cret", path: "/api/squire/hooks/trigger-1" };

  it("shows the secret on create or rotate and drops it for good on close", () => {
    let state: SquireSecretReveal | null = null;
    state = squireSecretRevealReducer(state, { type: "created", trigger: trigger(), webhook });
    expect(state?.webhook.secret).toBe("s3cret");
    state = squireSecretRevealReducer(state, { type: "closed" });
    expect(state).toBeNull();
    state = squireSecretRevealReducer(state, { type: "triggers-updated" });
    expect(state).toBeNull();

    state = squireSecretRevealReducer(state, {
      type: "rotated",
      trigger: trigger(),
      webhook: { ...webhook, secret: "next" },
    });
    expect(state).toMatchObject({ reason: "rotated", webhook: { secret: "next" } });
    state = squireSecretRevealReducer(state, { type: "closed" });
    state = squireSecretRevealReducer(state, { type: "triggers-updated" });
    expect(state).toBeNull();
  });

  it("opens nothing for a schedule, which has no secret", () => {
    expect(
      squireSecretRevealReducer(null, {
        type: "created",
        trigger: trigger({ kind: "schedule" }),
        webhook: null,
      }),
    ).toBeNull();
  });
});

describe("runs, limits, and adding", () => {
  it("labels a run with its time, origin, outcome, and item count", () => {
    expect(
      squireTriggerRunLabel(
        { at: "2026-11-01T09:00:00.000Z", origin: "test", outcome: "items-raised", itemCount: 2 },
        at,
      ),
    ).toBe("at 09:00 · Test · 2 items raised");
    expect(
      squireTriggerRunLabel(
        { at: "2026-11-01T10:00:00.000Z", origin: "event", outcome: "quiet", itemCount: 0 },
        at,
      ),
    ).toBe("at 10:00 · Scheduled · Quiet");
    expect(
      squireTriggerRunLabel(
        {
          at: "2026-11-01T11:00:00.000Z",
          origin: "webhook",
          outcome: "rate-limited",
          itemCount: 0,
        },
        at,
      ),
    ).toBe("at 11:00 · Webhook · Rate limited");
  });

  it("shows the run limit only while it holds", () => {
    expect(
      squireTriggerLimitText(trigger({ limitedUntil: "2026-11-01T13:00:00.000Z" }), NOW, at),
    ).toBe("limit reached until at 13:00");
    expect(
      squireTriggerLimitText(trigger({ limitedUntil: "2026-11-01T11:00:00.000Z" }), NOW, at),
    ).toBeNull();
  });

  it("names a schedule by its slots and refuses an empty webhook sentence", () => {
    const squireId = SquireId.make("squire-1");
    expect(
      squireTriggerDraftInput(
        { ...EMPTY_SQUIRE_TRIGGER_DRAFT, instruction: "Check releases" },
        squireId,
      ),
    ).toEqual({
      input: {
        kind: "schedule",
        squireId,
        name: "Weekdays at 9:00",
        instruction: "Check releases",
        schedule: { kind: "daily", time: "09:00", weekdaysOnly: true },
      },
    });
    expect(
      squireTriggerDraftInput(
        { ...EMPTY_SQUIRE_TRIGGER_DRAFT, kind: "webhook", instruction: "Triage" },
        squireId,
      ),
    ).toHaveProperty("error");
    expect(
      squireTriggerDraftInput(
        {
          ...EMPTY_SQUIRE_TRIGGER_DRAFT,
          scheduleKind: "interval",
          hours: 0,
          instruction: "Check releases",
        },
        squireId,
      ),
    ).toHaveProperty("error");
  });
});

describe("sweep", () => {
  const finding = (
    outcome: string,
    createdAt: string,
  ): Pick<SquireActionLogEntry, "kind" | "data" | "createdAt"> => ({
    kind: "sweep.finding",
    data: { outcome, findingKey: "k" },
    createdAt,
  });

  it("counts accepted findings over the last 30 days only", () => {
    const rate = squireSweepAcceptance(
      [
        finding("accepted", "2026-10-30T00:00:00.000Z"),
        finding("dismissed", "2026-10-29T00:00:00.000Z"),
        finding("outdated", "2026-10-20T00:00:00.000Z"),
        finding("accepted", "2026-09-01T00:00:00.000Z"),
        { kind: "sweep.ran", data: { outcome: "queued" }, createdAt: "2026-10-30T00:00:00.000Z" },
      ],
      NOW,
    );
    expect(rate).toEqual({ accepted: 1, total: 3 });
    expect(squireSweepAcceptanceText(rate)).toBe("Accepted 1 of 3 in the last 30 days");
    expect(squireSweepAcceptanceText({ accepted: 0, total: 0 })).toBe(
      "No findings in the last 30 days",
    );
  });

  it("explains each Find work outcome", () => {
    expect(squireLeadSweepOutcomeText({ outcome: "empty", retryAt: null }, at)).toBe(
      "Nothing to find",
    );
    expect(
      squireLeadSweepOutcomeText(
        { outcome: "budget-reached", retryAt: "2026-11-02T08:00:00.000Z" },
        at,
      ),
    ).toBe("Sweep budget reached until at 08:00");
  });
});
