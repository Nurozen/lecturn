import {
  squirePairedHoldText,
  squireQuestionRecommendation,
  type SquireSnapshotEntry,
  squireSupersededNote,
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
  squireActedLabel,
  squireApprovalAnswer,
  squireHeaderActions,
  squireHeldRows,
  squireHoldPairing,
  squireHoldSeconds,
  squireHoldText,
  squireItemsActInput,
  squireQuestionMode,
  squireQueueView,
  squireScreenState,
  squireTeamFilterToggle,
  squireUserInputAnswer,
  squireUserInputQuestions,
  type SquireKnownPayload,
  type SquireUserInputRequest,
  squireRowTitle,
} from "./squireQueue.logic";

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

describe("squireQueueView", () => {
  it("lists decisions before FYI, keeps server order, and counts chips before the chip filter", () => {
    const newest = row("steer");
    const fyi = row("fyi", { fyiSource: "summary" });
    const question = row("question");
    const view = squireQueueView([newest, fyi, question], {
      chip: "question",
      teamFilter: null,
      selected: null,
      hasMore: true,
    });
    expect(view.decision?.items.map((item) => item.id)).toEqual([question.id]);
    expect(view.fyi).toBeNull();
    const counts = Object.fromEntries(view.chips.map((chip) => [chip.chip, chip.countLabel]));
    expect(counts).toMatchObject({ all: "3+", steer: "1", question: "1", fyi: "1+" });

    const all = squireQueueView([newest, fyi, question], {
      chip: "all",
      teamFilter: null,
      selected: null,
      hasMore: false,
    });
    expect(all.decision?.items.map((item) => item.id)).toEqual([newest.id, question.id]);
    expect(all.fyi?.items.map((item) => item.id)).toEqual([fyi.id]);
  });

  it("filters the Lead's combined queue to one Squire's raised or owned items", () => {
    const docsRaised = row("steer", { squireId: DOCS, ownerSquireId: DOCS });
    const leadOnRelease = row("proposal", { squireId: LEAD, ownerSquireId: RELEASE });
    const view = squireQueueView([docsRaised, leadOnRelease], {
      chip: "all",
      teamFilter: RELEASE,
      selected: null,
      hasMore: false,
    });
    expect(view.decision?.items.map((item) => item.id)).toEqual([leadOnRelease.id]);
  });

  it("moves a row the user just acted on out of the groups into a one-line confirmation", () => {
    const steer = row("steer");
    const other = row("question");
    const acted = new Map([[steer.id, squireActedLabel(steer, "accept")]]);
    const view = squireQueueView([steer, other], {
      chip: "all",
      teamFilter: null,
      selected: null,
      hasMore: false,
      acted,
    });
    expect(view.decision?.items.map((item) => item.id)).toEqual([other.id]);
    expect(view.confirmations).toEqual([{ row: steer, label: "Sent" }]);
    expect(view.chips.find((chip) => chip.chip === "all")?.count).toBe(1);

    // Once the server moves it on (here: still listed but executing), its word wins.
    const moved = squireQueueView([{ ...steer, status: "executing" }, other], {
      chip: "all",
      teamFilter: null,
      selected: null,
      hasMore: false,
      acted,
    });
    expect(moved.confirmations).toEqual([]);
    expect(moved.decision?.items.map((item) => item.id)).toEqual([steer.id, other.id]);
  });

  it("pins an open linked card that is not on a loaded page, and confirms a settled one", () => {
    const loaded = row("steer");
    const linked = { ...row("question"), resolution: null };
    const pinned = squireQueueView([loaded], {
      chip: "all",
      teamFilter: null,
      selected: linked,
      hasMore: true,
    });
    expect(pinned.decision?.items.map((item) => item.id)).toEqual([linked.id, loaded.id]);

    const settled = squireQueueView([loaded], {
      chip: "all",
      teamFilter: null,
      selected: { ...linked, status: "resolved", resolution: "answered" },
      hasMore: false,
    });
    expect(settled.confirmations.map((entry) => entry.label)).toEqual(["Answered"]);
    expect(settled.decision?.items.map((item) => item.id)).toEqual([loaded.id]);
  });
});

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

describe("holds", () => {
  it("collects the Lead's and its team's holds under the team filter", () => {
    const hold = (cardId: string) => ({
      cardId: cardId as SquireCardId,
      kind: "steer" as const,
      targetThreadId: TARGET,
      executesInMs: 10_000,
    });
    const lead = entry(LEAD, "lead", { held: [hold("a")] });
    const release = entry(RELEASE, "squire", { held: [hold("b")], receivedAt: 5_000 });
    expect(squireHeldRows(lead, [release], null).map((row) => row.cardId)).toEqual(["a", "b"]);
    const filtered = squireHeldRows(lead, [release], RELEASE);
    expect(filtered).toEqual([{ ...hold("b"), squireId: RELEASE, receivedAt: 5_000 }]);
  });

  it("counts down from when the snapshot arrived", () => {
    expect(squireHoldSeconds(1_000, 10_000, 1_000)).toBe(10);
    expect(squireHoldSeconds(1_000, 10_000, 4_500)).toBe(7);
    expect(squireHoldSeconds(1_000, 10_000, 20_000)).toBe(0);
    expect(squireHoldText("steer", "Fix CI", 7)).toBe("Sending a steer to Fix CI in 7s");
    expect(squireHoldText("proposal", null, 0)).toBe("Creating a thread now");
  });
});

describe("hold pairing (P7.6)", () => {
  const held = (cardId: string, heldOverCardId?: string) => ({
    cardId: cardId as SquireCardId,
    kind: "steer" as const,
    targetThreadId: TARGET,
    squireId: RELEASE,
    receivedAt: 1_000,
    executesInMs: 52_000,
    ...(heldOverCardId === undefined ? {} : { heldOverCardId: heldOverCardId as SquireCardId }),
  });

  it("shows a hold under its open card, dropping the held card's own row and banner", () => {
    const open = row("steer", { id: "open" });
    const heldRow = row("steer", { id: "paired", status: "held" });
    const loneRow = row("steer", { id: "lone", status: "held" });
    const pairing = squireHoldPairing(
      [heldRow, open, loneRow],
      [held("paired", "open"), held("lone")],
    );
    expect(pairing.byOpen.get("open" as SquireCardId)?.cardId).toBe("paired");
    expect(pairing.rows.map((r) => r.id)).toEqual(["open", "lone"]);
    expect(pairing.lone.map((hold) => hold.cardId)).toEqual(["lone"]);
  });

  it("keeps a hold as a banner when its open card is not listed or not open", () => {
    const filtered = squireHoldPairing([row("question")], [held("paired", "open")]);
    expect(filtered.byOpen.size).toBe(0);
    expect(filtered.lone.map((hold) => hold.cardId)).toEqual(["paired"]);
    const settling = squireHoldPairing(
      [row("steer", { id: "open", status: "accepting" })],
      [held("paired", "open")],
    );
    expect(settling.lone).toHaveLength(1);
  });

  it("words the paired hold and the card it is about to supersede", () => {
    expect(squirePairedHoldText("steer", 52)).toBe("Newer steer held · sending in 52s");
    expect(squirePairedHoldText("steer", 0)).toBe("Newer steer held · sending now");
    expect(squireSupersededNote("steer")).toBe("A newer steer is about to send");
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

  it("clears the team filter when the selected portrait is tapped again", () => {
    expect(squireTeamFilterToggle(null, RELEASE)).toBe(RELEASE);
    expect(squireTeamFilterToggle(RELEASE, DOCS)).toBe(DOCS);
    expect(squireTeamFilterToggle(RELEASE, RELEASE)).toBeNull();
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

describe("rule offers (P8.1)", () => {
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

describe("question recommendation (P7.3)", () => {
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

describe("squireRowTitle", () => {
  it("adds a summary FYI's outcome to its thread name and leaves other rows alone", () => {
    expect(
      squireRowTitle({ title: "Fix invoice rounding", kind: "fyi", outcome: "checks passed" }),
    ).toBe("Fix invoice rounding · checks passed");
    expect(squireRowTitle({ title: "Fix invoice rounding", kind: "fyi" })).toBe(
      "Fix invoice rounding",
    );
    expect(squireRowTitle({ title: "Rerun api-e2e", kind: "steer", outcome: "x" })).toBe(
      "Rerun api-e2e",
    );
  });
});
