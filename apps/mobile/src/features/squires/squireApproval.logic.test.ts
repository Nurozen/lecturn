import {
  squireQuestionRecommendation,
  type SquireApprovalEntry,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import {
  UnknownUnionMember,
  type EnvironmentId,
  type SquireCardId,
  type SquireCardKind,
  type SquireCardRow,
  type SquireId,
  type SquireRuleOffer,
  type ThreadId,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { togglePendingUserInputOptionSelection } from "../../lib/threadActivity";
import {
  createSquireOpenedTracker,
  squireActOutcome,
  squireApprovalAnswer,
  squireChatControls,
  squireHeaderActions,
  squireItemsActInput,
  squireQuestionMode,
  squireRouteDestination,
  squireScreenState,
  squireWithInactivityChecks,
  squireUserInputAnswer,
  squireUserInputQuestions,
  type SquireKnownPayload,
  type SquireUserInputRequest,
} from "./squireApproval.logic";

const ENV = "env-1" as EnvironmentId;
const LEAD = "lead" as SquireId;
const RELEASE = "release" as SquireId;
const DOCS = "docs" as SquireId;
const TARGET = "thread-target" as ThreadId;

let sequence = 0;
function row(
  kind: SquireCardKind,
  overrides: Partial<Omit<SquireCardRow, "id">> & { readonly id?: string } = {},
): SquireCardRow {
  sequence += 1;
  const { id, ...rest } = overrides;
  return {
    id: (id ?? `card-${sequence}`) as SquireCardId,
    squireId: RELEASE,
    ownerSquireId: RELEASE,
    kind,
    status: "open",
    title: `${kind} ${sequence}`,
    targetThreadId: TARGET,
    projectId: null,
    origin: "event",
    steerKind: kind === "steer" ? "rebase" : null,
    ruleId: null,
    routedTaskId: null,
    caption: null,
    replacedCount: 0,
    executesAt: null,
    openedAt: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...rest,
  };
}

function questionPayload(
  request: Extract<SquireKnownPayload, { type: "question" }>["request"],
  overrides: Partial<Extract<SquireKnownPayload, { type: "question" }>> = {},
): Extract<SquireKnownPayload, { type: "question" }> {
  return {
    type: "question",
    threadId: TARGET,
    requestKind: "runtime",
    requestId: "runtime-request-1",
    question: "Run the migration?",
    options: [],
    ...(request === undefined ? {} : { request }),
    ...overrides,
  };
}

function entry(
  id: SquireId,
  role: "lead" | "squire",
  overrides: Partial<SquireSnapshotEntry> = {},
): SquireSnapshotEntry {
  return {
    squire: { id, role, name: id, status: "active", lifecycle: "ready", homeThreadId: null },
    held: [],
    receivedAt: 1_000,
    ...overrides,
  } as unknown as SquireSnapshotEntry;
}

const MULTI_QUESTION: SquireUserInputRequest = {
  type: "user-input",
  canRespond: true,
  questions: [
    {
      id: "target",
      header: "Target",
      question: "Which branch should the fix land on?",
      options: [
        { label: "main", description: "The default branch" },
        { label: "release", description: "The release branch", value: "release/1.4" },
      ],
    },
    {
      id: "checks",
      header: "Checks",
      question: "Which checks should run?",
      multiSelect: true,
      options: [
        { label: "Unit", description: "Unit tests" },
        { label: "E2E", description: "Browser tests" },
        { label: "Lint", description: "Lint" },
      ],
    },
  ],
};

describe("squireQuestionMode", () => {
  it("answers approvals and all-option questions in place", () => {
    expect(squireQuestionMode(questionPayload({ type: "approval", canRespond: true }))).toEqual({
      type: "approval",
    });
    expect(squireQuestionMode(questionPayload(MULTI_QUESTION))).toEqual({ type: "user-input" });
  });

  it("sends free-text, secret, missing, unknown, and provider-gone requests to the thread", () => {
    const freeText: SquireUserInputRequest = {
      type: "user-input",
      canRespond: true,
      questions: [{ id: "why", header: "Why", question: "Explain the failure", options: [] }],
    };
    expect(squireQuestionMode(questionPayload(freeText))).toMatchObject({ type: "in-thread" });
    expect(squireQuestionMode(questionPayload(undefined, { requestKind: "secret" }))).toEqual({
      type: "secret",
    });
    expect(squireQuestionMode(questionPayload(undefined))).toEqual({
      type: "in-thread",
      reason: "This question is no longer waiting here.",
    });
    expect(
      squireQuestionMode(questionPayload(new UnknownUnionMember("type", "elicitation"))),
    ).toMatchObject({ type: "in-thread" });
    const gone = squireQuestionMode(questionPayload({ type: "approval", canRespond: false }));
    expect(gone).toMatchObject({ type: "in-thread" });
    expect(gone?.type === "in-thread" ? gone.reason : "").toMatch(/Open the thread/);
    expect(
      squireQuestionMode(questionPayload({ ...MULTI_QUESTION, canRespond: false })),
    ).toMatchObject({ type: "in-thread" });
  });

  it("is not a question mode for other payloads", () => {
    expect(
      squireQuestionMode({ type: "steer", threadId: TARGET, steer: "Rebase", steerKind: "rebase" }),
    ).toBeNull();
  });
});

describe("answering a question card for a thread that is not selected", () => {
  // The phone has some other thread open; the card's answer never names one.
  const card = row("question", { targetThreadId: TARGET });

  it("sends an approval decision through squire.items.act on the card", () => {
    const input = squireItemsActInput("req-1", [card.id], "accept", {
      answer: squireApprovalAnswer("acceptForSession"),
    });
    expect(input).toEqual({
      requestId: "req-1",
      cardIds: [card.id],
      action: "accept",
      answer: { decision: "acceptForSession" },
    });
  });

  it("sends every answer of a multi-question input keyed by question id", () => {
    const questions = squireUserInputQuestions(MULTI_QUESTION, card.title);
    const [target, checks] = questions;
    let drafts = {};
    drafts = {
      ...drafts,
      target: togglePendingUserInputOptionSelection(target!, undefined, "release/1.4"),
    };
    // Unanswered questions hold the answer back, as in the thread.
    expect(squireUserInputAnswer(questions, drafts)).toBeNull();
    let checksDraft = togglePendingUserInputOptionSelection(checks!, undefined, "Unit");
    checksDraft = togglePendingUserInputOptionSelection(checks!, checksDraft, "Lint");
    drafts = { ...drafts, checks: checksDraft };

    const answer = squireUserInputAnswer(questions, drafts);
    expect(answer).toEqual({ answers: { target: "release/1.4", checks: ["Unit", "Lint"] } });
    expect(squireItemsActInput("req-2", [card.id], "accept", { answer: answer! })).toEqual({
      requestId: "req-2",
      cardIds: [card.id],
      action: "accept",
      answer: { answers: { target: "release/1.4", checks: ["Unit", "Lint"] } },
    });
  });

  it("counts a question's initial answer as answered, as the thread seeds it", () => {
    const request: SquireUserInputRequest = {
      type: "user-input",
      canRespond: true,
      questions: [
        {
          id: "name",
          header: "Name",
          question: "Branch name?",
          options: [{ label: "fix/ci", description: "Suggested" }],
          initialAnswer: "fix/flaky-ci",
        },
      ],
    };
    const questions = squireUserInputQuestions(request, "Pick a branch");
    expect(squireUserInputAnswer(questions, {})).toEqual({ answers: { name: "fix/flaky-ci" } });
  });

  it("blanks a lone question that only repeats the card title, keeping its id", () => {
    const request: SquireUserInputRequest = {
      ...MULTI_QUESTION,
      questions: [MULTI_QUESTION.questions[0]!],
    };
    const [only] = squireUserInputQuestions(request, "Which branch should the fix land on?");
    expect(only).toMatchObject({ id: "target", question: "", multiSelect: false });
  });
});

describe("acting", () => {
  it("leaves out text and answer when there are none", () => {
    expect(squireItemsActInput("req", [row("steer").id], "dismiss")).not.toHaveProperty("text");
    expect(squireItemsActInput("req", [row("steer").id], "dismiss")).not.toHaveProperty("answer");
  });

  it("reads a per-card refusal from results[].error and a transport failure as an error", () => {
    const card = row("steer");
    expect(
      squireActOutcome(
        {
          _tag: "Success",
          value: { results: [{ cardId: card.id, error: { message: "Budget reached" } }] },
        },
        card.id,
        null,
      ),
    ).toEqual({ ok: false, error: "Budget reached" });
    expect(
      squireActOutcome(
        { _tag: "Success", value: { results: [{ cardId: card.id, error: null }] } },
        card.id,
        null,
      ),
    ).toEqual({ ok: true });
    expect(squireActOutcome({ _tag: "Failure" }, card.id, null)).toMatchObject({ ok: false });
  });
});

describe("screen", () => {
  it("shows nothing Squire-shaped on a server without the capability", () => {
    expect(squireScreenState(false, null, RELEASE)).toEqual({ status: "unsupported" });
    expect(squireScreenState(true, null, RELEASE)).toEqual({ status: "loading" });
    expect(squireScreenState(true, { lead: null, squires: [], rooms: [] }, RELEASE)).toEqual({
      status: "missing",
    });
  });

  it("gives the Lead its team strip", () => {
    const lead = entry(LEAD, "lead");
    const release = entry(RELEASE, "squire");
    const state = { lead: LEAD, squires: [lead, release], rooms: [] };
    expect(squireScreenState(true, state, LEAD)).toMatchObject({ isLead: true, team: [release] });
    expect(squireScreenState(true, state, RELEASE)).toMatchObject({ isLead: false, team: [] });
  });

  it("offers setup instead of Chat to a Lead waiting on a provider", () => {
    const home = "home" as ThreadId;
    expect(
      squireHeaderActions({ status: "active", lifecycle: "needs_provider", homeThreadId: null }),
    ).toMatchObject({
      chatThreadId: null,
      setupPrompt: "Choose a provider on desktop or the web.",
    });
    expect(
      squireHeaderActions({ status: "paused", lifecycle: "ready", homeThreadId: home }),
    ).toEqual({
      chatThreadId: home,
      setupPrompt: null,
      pause: { label: "Resume", next: "active" },
    });
  });
});

describe("createSquireOpenedTracker", () => {
  it("marks a card opened once per session, skips one already opened, and retries a failure", () => {
    const tracker = createSquireOpenedTracker();
    const card = "card" as SquireCardId;
    expect(tracker.take(ENV, card, null)).toBe(true);
    expect(tracker.take(ENV, card, null)).toBe(false);
    tracker.release(ENV, card);
    expect(tracker.take(ENV, card, null)).toBe(true);
    expect(tracker.take(ENV, "seen" as SquireCardId, "2026-11-01T10:00:00.000Z")).toBe(false);
  });
});

describe("rule offers", () => {
  function offer(overrides: Partial<SquireRuleOffer> = {}): SquireRuleOffer {
    return {
      effect: "allow",
      actionClass: "steer",
      targetKind: "thread",
      targetId: TARGET,
      steerKind: "rebase",
      text: 'Release may auto-send rebase steers on "Fix invoices"',
      alternative: {
        targetKind: "project",
        targetId: "billing",
        text: "Release may auto-send rebase steers on threads in billing",
      },
      capReached: false,
      ...overrides,
    };
  }

  it("carries the accepted card's offer out of the act result", () => {
    const card = row("steer");
    expect(
      squireActOutcome(
        {
          _tag: "Success",
          value: { results: [{ cardId: card.id, error: null, ruleOffer: offer() }] },
        },
        card.id,
        null,
      ),
    ).toEqual({ ok: true, ruleOffer: offer() });
  });
});

describe("question recommendation", () => {
  it("shows the Squire's suggestion only when it adds something", () => {
    const title = "Migration question";
    const ask = (recommendation: string | undefined) =>
      squireQuestionRecommendation(
        questionPayload(undefined, recommendation === undefined ? {} : { recommendation }),
        title,
      );
    expect(ask("  Answer yes; the backup finished.  ")).toBe("Answer yes; the backup finished.");
    expect(ask(undefined)).toBeNull();
    expect(ask("   ")).toBeNull();
    expect(ask(" Run the migration? ")).toBeNull();
    expect(ask(title)).toBeNull();
    expect(
      squireQuestionRecommendation(
        { type: "steer", threadId: TARGET, steer: "Rebase onto main", steerKind: "rebase" },
        title,
      ),
    ).toBeNull();
  });
});

const OFFER = { effect: "allow", capReached: false } as unknown as SquireRuleOffer;

describe("squireChatControls", () => {
  const base = { payload: null, canAct: true, canSaveRule: true, ruleSaved: false };
  const card = (kind: SquireCardKind, extra: Partial<SquireCardRow> = {}) =>
    ({ id: "c", squireId: RELEASE, kind, ...extra }) as SquireCardRow;
  const open = (row: SquireCardRow) =>
    ({ row, createdAt: "", phase: "open", outcome: null, expired: false }) as const;
  const closed = (row: SquireCardRow, expired: boolean) =>
    ({ row, createdAt: "", phase: "closed", outcome: "Expired", expired }) as const;

  it("offers Always allow only where a rule can apply", () => {
    expect(squireChatControls({ ...base, entry: open(card("steer")) })).toEqual({
      kind: "approve",
      allowLabel: "Allow once",
      alwaysAllow: false,
    });
    expect(
      squireChatControls({ ...base, entry: open(card("steer", { allowRuleOffer: OFFER })) }),
    ).toMatchObject({ kind: "approve", alwaysAllow: true });
    expect(
      squireChatControls({
        ...base,
        entry: open(card("proposal", { allowRuleOffer: { ...OFFER, capReached: true } })),
      }),
    ).toMatchObject({ kind: "approve", alwaysAllow: false });
    expect(
      squireChatControls({
        ...base,
        canSaveRule: false,
        entry: open(card("steer", { allowRuleOffer: OFFER })),
      }),
    ).toMatchObject({ kind: "approve", alwaysAllow: false });
  });

  it("names a proposal's accept as web does", () => {
    const entry = open(card("proposal"));
    const label = (type: string) =>
      squireChatControls({ ...base, entry, payload: { type } as SquireKnownPayload });
    expect(label("squire-proposal")).toMatchObject({ allowLabel: "Accept" });
    expect(label("room-proposal")).toMatchObject({ allowLabel: "Open room" });
    expect(label("thread-proposal")).toMatchObject({ allowLabel: "Allow once" });
  });

  it("keeps question answers, overlap Dismiss, and the inactivity check's Keep and Pause", () => {
    expect(squireChatControls({ ...base, entry: open(card("question")) })).toEqual({
      kind: "answer",
    });
    expect(squireChatControls({ ...base, entry: open(card("overlap")) })).toEqual({
      kind: "dismiss",
    });
    expect(
      squireChatControls({ ...base, entry: open(card("fyi", { fyiSource: "inactivity" })) }),
    ).toEqual({ kind: "inactivity" });
    expect(squireChatControls({ ...base, entry: open(card("fyi")) })).toEqual({ kind: "none" });
  });

  it("offers the rule alone once expired, and nothing once it is saved", () => {
    const row = card("steer", { allowRuleOffer: OFFER });
    expect(squireChatControls({ ...base, entry: closed(row, true) })).toEqual({
      kind: "expired",
      allowNextTime: true,
    });
    expect(squireChatControls({ ...base, ruleSaved: true, entry: closed(row, true) })).toEqual({
      kind: "expired",
      allowNextTime: false,
    });
    expect(squireChatControls({ ...base, entry: closed(row, false) })).toEqual({ kind: "none" });
  });

  it("offers no controls to a viewer who cannot act", () => {
    expect(squireChatControls({ ...base, canAct: false, entry: open(card("steer")) })).toEqual({
      kind: "none",
    });
  });
});

describe("squireWithInactivityChecks", () => {
  const fyi = (id: string, extra: Partial<SquireCardRow>) =>
    ({
      id,
      kind: "fyi",
      status: "open",
      squireId: RELEASE,
      createdAt: "2026-11-05T00:00:02.000Z",
      ...extra,
    }) as SquireCardRow;
  const chat = { squireId: RELEASE, isLead: false, chatFirst: true };
  const steer = {
    row: { id: "s" },
    createdAt: "2026-11-05T00:00:03.000Z",
    phase: "open",
    outcome: null,
    expired: false,
  } as unknown as SquireApprovalEntry<SquireCardRow>;

  it("joins only an open inactivity check raised here, in time order", () => {
    const check = fyi("check", { fyiSource: "inactivity" });
    const merged = squireWithInactivityChecks(
      [steer],
      [
        check,
        fyi("summary", {}),
        fyi("closed", { fyiSource: "inactivity", status: "resolved" }),
        fyi("other", { fyiSource: "inactivity", squireId: DOCS }),
      ],
      chat,
    );
    expect(merged.map((entry) => (entry.row as SquireCardRow).id)).toEqual(["check", "s"]);
    expect(merged[0]).toMatchObject({ phase: "open", outcome: null, expired: false });
  });

  it("returns the entries untouched when no check is open", () => {
    const entries = [steer];
    expect(squireWithInactivityChecks(entries, [fyi("summary", {})], chat)).toBe(entries);
  });
});

describe("squireRouteDestination", () => {
  const home = "home-thread" as ThreadId;
  const squire = {
    role: "squire",
    status: "active",
    lifecycle: "ready",
    homeThreadId: home,
    onboardedAt: "2026-11-01T00:00:00.000Z",
  } as Parameters<typeof squireRouteDestination>[0]["squire"];
  const go = (over: object, count: number | null = 3, detailsRequested = false) =>
    squireRouteDestination({
      squire: { ...squire, ...over },
      detailsRequested,
      homeVisibleItemCount: count,
    });

  it("is the chat, unless details were asked for", () => {
    expect(go({})).toEqual({ kind: "chat", threadId: home });
    expect(go({}, 3, true)).toEqual({ kind: "details" });
  });

  it("keeps details for a Squire with no chat yet", () => {
    expect(go({ homeThreadId: null })).toEqual({ kind: "details" });
    expect(go({ lifecycle: "needs_provider" })).toEqual({ kind: "details" });
  });

  it("holds the Lead's introduction until its thread has a message", () => {
    const lead = { role: "lead", onboardedAt: null };
    expect(go(lead, 0)).toEqual({ kind: "details" });
    expect(go(lead, null)).toEqual({ kind: "details" });
    expect(go(lead, 2)).toEqual({ kind: "chat", threadId: home });
    expect(go({ role: "lead" }, null)).toEqual({ kind: "chat", threadId: home });
  });
});
