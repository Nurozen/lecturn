import {
  squireOverlapThreadLine,
  squireOverlapView,
  squirePairedHoldText,
  squireQuestionRecommendation,
  squireSupersededNote,
} from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  MessageId,
  SquireCard,
  SquireCardId,
  SquireCardKind,
  SquireCardRow,
  SquireCardStatus,
  SquireId,
  SquireTaskId,
  ThreadId,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  squireCardMarkers,
  squireOpenInThreadTarget,
  squireQuestionMode,
  squireQueueView,
  squireHeaderCounts,
  squireHoldPairing,
  squireReceiptRows,
  squireSteerKindLabel,
  squireTitleBesideKind,
  squireUserInputAnswer,
  squireCardPrimaryLabel,
  squireRowMeta,
  squireQueueEmptyText,
  squireCardSubtitle,
  squireRepositoryLabel,
  squireFyiNeedsText,
  squireFyiRowText,
} from "./squireQueue.logic";
import { createSquireOpenedTracker } from "./squireOpened.logic";

const ENV = "env-1" as EnvironmentId;
const LEAD = "lead" as SquireId;
const RELEASE = "release" as SquireId;
const DOCS = "docs" as SquireId;
const THREAD = "thread-1" as ThreadId;

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
    status: "open" as SquireCardStatus,
    title: `${kind} ${sequence}`,
    targetThreadId: THREAD,
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

describe("queue grouping and counts", () => {
  it("groups decisions before FYI and counts every chip before the chip filter", () => {
    const rows = [row("fyi"), row("steer"), row("question"), row("fyi"), row("proposal")];
    const view = squireQueueView(rows, {
      chip: "all",
      teamFilter: null,
      selected: null,
      hasMore: false,
    });
    expect(view.decision?.label).toBe("Needs a decision");
    expect(view.decision?.items.map((r) => r.kind)).toEqual(["steer", "question", "proposal"]);
    expect(view.fyi?.items).toHaveLength(2);
    expect(Object.fromEntries(view.chips.map((c) => [c.chip, c.countLabel]))).toEqual({
      all: "5",
      steer: "1",
      question: "1",
      overlap: "0",
      proposal: "1",
      fyi: "2",
    });

    const fyiOnly = squireQueueView(rows, {
      chip: "fyi",
      teamFilter: null,
      selected: null,
      hasMore: false,
    });
    expect(fyiOnly.decision).toBeNull();
    expect(fyiOnly.chips.find((c) => c.chip === "steer")?.count).toBe(1);
  });

  it("filters the Lead's combined queue by the team strip, raiser or owner", () => {
    const rows = [
      row("steer", { squireId: RELEASE, ownerSquireId: RELEASE }),
      row("overlap", { squireId: LEAD, ownerSquireId: DOCS }),
      row("steer", { squireId: DOCS, ownerSquireId: DOCS }),
    ];
    const view = squireQueueView(rows, {
      chip: "all",
      teamFilter: DOCS,
      selected: null,
      hasMore: false,
    });
    expect(view.decision?.items.map((r) => r.kind)).toEqual(["overlap", "steer"]);
    expect(view.chips[0]?.count).toBe(2);
  });

  it("marks counts that older pages could raise as floors", () => {
    const view = squireQueueView([row("steer"), row("fyi")], {
      chip: "all",
      teamFilter: null,
      selected: null,
      hasMore: true,
    });
    const labels = Object.fromEntries(view.chips.map((c) => [c.chip, c.countLabel]));
    expect(labels.all).toBe("2+");
    expect(labels.fyi).toBe("1+");
    expect(labels.steer).toBe("1");
  });

  it("keeps a deep-linked open card in place when no loaded page holds it", () => {
    const open = row("steer");
    const linked = row("question");
    const view = squireQueueView([open], {
      chip: "all",
      teamFilter: null,
      selected: linked,
      hasMore: false,
    });
    expect(view.decision?.items.map((r) => r.id)).toEqual([linked.id, open.id]);
    expect(view.confirmation).toBeNull();
  });

  it("answering in place leaves the decision group at once and the counts follow", () => {
    const question = row("question", { id: "card-q" });
    const steer = row("steer");
    const proposal = row("proposal");
    const fyi = row("fyi");
    const rows = [question, steer, proposal, fyi];
    const counts = (view: ReturnType<typeof squireQueueView>) =>
      Object.fromEntries(view.chips.map((chip) => [chip.chip, chip.count]));

    // Before: the question is expanded among the open decisions.
    const before = squireQueueView(rows, {
      chip: "all",
      teamFilter: null,
      selected: question,
      hasMore: false,
    });
    expect(before.decision?.items.map((r) => r.id)).toContain("card-q");
    expect(counts(before)).toMatchObject({ all: 4, question: 1 });
    expect(before.confirmation).toBeNull();

    // The answer succeeded; the server has not resolved the card yet.
    const answered = new Map([[question.id, "Answered"]]);
    const pending = squireQueueView(rows, {
      chip: "all",
      teamFilter: null,
      selected: question,
      hasMore: false,
      acted: answered,
    });
    expect(pending.decision?.items.map((r) => r.id)).not.toContain("card-q");
    expect(counts(pending)).toMatchObject({ all: 3, question: 0, steer: 1, proposal: 1 });
    expect(pending.confirmation).toMatchObject({ label: "Answered", row: { id: "card-q" } });

    // The detail says resolved while the page is still stale.
    const resolved = { ...question, status: "resolved" as const, resolution: "answered" as const };
    const stale = squireQueueView(rows, {
      chip: "all",
      teamFilter: null,
      selected: resolved,
      hasMore: false,
    });
    expect(stale.decision?.items.map((r) => r.id)).not.toContain("card-q");
    expect(counts(stale)).toMatchObject({ all: 3, question: 0 });
    expect(stale.confirmation?.label).toBe("Answered");

    // The refetch on itemsRevision no longer lists it.
    const after = squireQueueView([steer, proposal, fyi], {
      chip: "all",
      teamFilter: null,
      selected: resolved,
      hasMore: false,
      acted: answered,
    });
    expect(counts(after)).toMatchObject({ all: 3, question: 0 });
    expect(after.decision?.items).toHaveLength(2);
    expect(after.confirmation?.label).toBe("Answered");
  });

  it("shows the server's newer state over the user's act once it moves on", () => {
    const steer = row("steer", { id: "card-s", status: "held" });
    const view = squireQueueView([steer], {
      chip: "all",
      teamFilter: null,
      selected: null,
      hasMore: false,
      acted: new Map([[steer.id, "Sent"]]),
    });
    expect(view.held?.items.map((r) => r.status)).toEqual(["held"]);
    expect(view.decision).toBeNull();
  });

  it("groups holds apart from decisions, and the header counts each group's rows", () => {
    const rows = [
      row("steer", { status: "held" }),
      row("proposal"),
      // Lead-raised on this Squire's thread: the sidebar badge leaves it to the Lead.
      row("overlap", { squireId: LEAD, targetThreadId: null }),
      row("question", { status: "accepting" }),
      row("fyi"),
    ];
    const view = squireQueueView(rows, {
      chip: "all",
      teamFilter: null,
      selected: null,
      hasMore: false,
    });
    expect(view.held?.items).toEqual([rows[0]]);
    expect(view.decision?.items.map((r) => r.kind)).toEqual(["proposal", "overlap", "question"]);
    expect(squireHeaderCounts(rows)).toEqual({
      decisions: view.decision?.items.length,
      held: view.held?.items.length,
    });
  });

  it("shows a hold under the open card it sits beside, and a lone hold as its own row", () => {
    const open = row("steer", { id: "open" });
    const paired = row("steer", { id: "paired", status: "held" });
    const lone = row("steer", { id: "lone", status: "held" });
    // Its card is not listed (filtered or just acted on), so the hold stays visible on its own.
    const orphan = row("steer", { id: "orphan", status: "held" });
    const second = row("steer", { id: "second", status: "held" });
    const over: Record<string, string> = { paired: "open", orphan: "gone", second: "open" };
    const pairing = squireHoldPairing(
      [paired, lone, orphan, second],
      [open, row("question")],
      (id) => over[id] as SquireCardId | undefined,
    );
    expect([...pairing.byOpen]).toEqual([["open", paired]]);
    // One block per open card: a second hold over the same card is never hidden.
    expect(pairing.lone.map((r) => r.id)).toEqual(["lone", "orphan", "second"]);
  });

  it("words the paired hold and the open card it is about to supersede", () => {
    expect(squirePairedHoldText("steer", 52)).toBe("Newer steer held · sending in 52s");
    expect(squirePairedHoldText("steer", 0)).toBe("Newer steer held · sending now");
    expect(squireSupersededNote("steer")).toBe("A newer steer is about to send");
    expect(squireSupersededNote("proposal")).toBe("A newer thread is about to start");
  });

  it("leaves settled rows out of the header's counts", () => {
    expect(
      squireHeaderCounts([
        row("steer", { status: "executed" }),
        row("proposal", { status: "dismissed" }),
        row("fyi"),
      ]),
    ).toEqual({ decisions: 0, held: 0 });
  });
});

describe("row markers and actions", () => {
  it("marks outdated, updated, and held cards", () => {
    expect(squireCardMarkers(row("steer", { replacedCount: 2 }))).toEqual(["updated"]);
    expect(squireCardMarkers(row("steer", { status: "outdated", replacedCount: 2 }))).toEqual([
      "outdated",
    ]);
    expect(squireCardMarkers(row("steer", { status: "held" }))).toEqual(["held"]);
    expect(squireCardMarkers(row("steer", { status: "executing" }))).toEqual(["sending"]);
    expect(squireCardMarkers(row("steer"))).toEqual([]);
  });

  it("labels steer kinds, except other", () => {
    expect(squireSteerKindLabel("rerun-checks")).toBe("Rerun checks");
    expect(squireSteerKindLabel("other")).toBeNull();
    expect(squireSteerKindLabel(null)).toBeNull();
  });
});

describe("markOpened", () => {
  const A = "card-a" as SquireCardId;
  const B = "card-b" as SquireCardId;

  it("sends once per item per session, across expand, select, and child-row select", () => {
    const tracker = createSquireOpenedTracker();
    expect(tracker.take(ENV, A, null)).toBe(true);
    expect(tracker.take(ENV, A, null)).toBe(false);
    expect(tracker.take(ENV, B, null)).toBe(true);
    expect(tracker.take("env-2" as EnvironmentId, A, null)).toBe(true);
  });

  it("sends nothing for a card another surface already opened", () => {
    const tracker = createSquireOpenedTracker();
    expect(tracker.take(ENV, A, "2026-11-01T10:05:00.000Z")).toBe(false);
    expect(tracker.take(ENV, A, null)).toBe(false);
  });

  it("retries after a failed send", () => {
    const tracker = createSquireOpenedTracker();
    expect(tracker.take(ENV, A, null)).toBe(true);
    tracker.release(ENV, A);
    expect(tracker.take(ENV, A, null)).toBe(true);
  });
});

describe("evidence", () => {
  it("deep-links to the triggering message by its quote, else opens the thread", () => {
    const base = { targetThreadId: THREAD, trigger: {} } satisfies Pick<
      SquireCard,
      "targetThreadId" | "trigger"
    >;
    expect(squireOpenInThreadTarget(ENV, base)).toEqual({ type: "thread", threadId: THREAD });
    const linked = squireOpenInThreadTarget(ENV, {
      targetThreadId: THREAD,
      trigger: { triggerMessageId: "msg-1" as MessageId, quote: "api-e2e failed" },
    });
    expect(linked).toMatchObject({
      type: "citation",
      citation: { threadId: THREAD, messageId: "msg-1", text: "api-e2e failed", start: 0, end: 14 },
    });
    expect(
      squireOpenInThreadTarget(ENV, {
        targetThreadId: THREAD,
        trigger: { triggerMessageId: "msg-1" as MessageId },
      }),
    ).toEqual({ type: "thread", threadId: THREAD });
    expect(squireOpenInThreadTarget(ENV, { targetThreadId: null, trigger: {} })).toBeNull();
  });
});

describe("question cards", () => {
  const questionPayload = (
    request: Extract<SquireCard["payload"], { readonly type: "question" }>["request"],
    requestKind: "runtime" | "secret" = "runtime",
  ) => ({
    type: "question" as const,
    threadId: THREAD,
    requestKind,
    requestId: "req-1",
    question: "Deploy to staging now?",
    options: [],
    ...(request === undefined ? {} : { request }),
  });
  const deploy = {
    id: "q1",
    header: "Deploy",
    question: "Deploy to staging now?",
    options: [
      { label: "Yes", description: "Ship it" },
      { label: "No", description: "Wait", value: "no-wait" },
    ],
  };

  it("shows the Squire's recommendation above the options only when it has one", () => {
    const base = questionPayload({ type: "approval", canRespond: true });
    const title = "Release approval";
    expect(
      squireQuestionRecommendation({ ...base, recommendation: "  Answer Offline-only.  " }, title),
    ).toBe("Answer Offline-only.");
    expect(squireQuestionRecommendation({ ...base, recommendation: "   " }, title)).toBeNull();
    expect(squireQuestionRecommendation(base, title)).toBeNull();
    // One that only repeats the title or the question adds nothing.
    expect(squireQuestionRecommendation({ ...base, recommendation: title }, title)).toBeNull();
    expect(
      squireQuestionRecommendation({ ...base, recommendation: base.question }, title),
    ).toBeNull();
    expect(
      squireQuestionRecommendation(
        { type: "steer", threadId: THREAD, steer: "Rerun", steerKind: "other" },
        title,
      ),
    ).toBeNull();
  });

  it("answers in place with the thread's own shape, or sends the user to the thread", () => {
    expect(squireQuestionMode(questionPayload({ type: "approval", canRespond: true }))).toEqual({
      type: "approval",
    });
    expect(
      squireQuestionMode(
        questionPayload({ type: "user-input", questions: [deploy], canRespond: true }),
      ),
    ).toEqual({ type: "user-input" });
    expect(squireQuestionMode(questionPayload(undefined, "secret"))).toEqual({ type: "secret" });
    expect(squireQuestionMode(questionPayload(undefined))?.type).toBe("in-thread");
    expect(
      squireQuestionMode(
        questionPayload({
          type: "user-input",
          questions: [{ ...deploy, options: [] }],
          canRespond: true,
        }),
      )?.type,
    ).toBe("in-thread");
  });

  it("keys a user-input answer by question id with the option's value", () => {
    const questions = [
      { ...deploy, multiSelect: false },
      { ...deploy, id: "q2", multiSelect: true },
    ];
    expect(
      squireUserInputAnswer(questions, { q1: { selectedOptionValues: ["no-wait"] } }),
    ).toBeNull();
    expect(
      squireUserInputAnswer(questions, {
        q1: { selectedOptionValues: ["no-wait"] },
        q2: { selectedOptionValues: ["Yes", "no-wait"] },
      }),
    ).toEqual({ answers: { q1: "no-wait", q2: ["Yes", "no-wait"] } });
  });
});

describe("routing receipts", () => {
  it("reads each receipt in place and settles once its items do", () => {
    const rows = squireReceiptRows(
      [
        {
          taskId: "task-1" as SquireTaskId,
          toSquireId: RELEASE,
          text: "Rerun api-e2e on #318",
          status: "acted",
          quietReason: null,
          items: [{ cardId: "card-9" as SquireCardId, kind: "proposal", status: "resolved" }],
          createdAt: "2026-11-01T10:00:00.000Z",
        },
        {
          taskId: "task-2" as SquireTaskId,
          toSquireId: DOCS,
          text: "Update the changelog",
          status: "sent",
          quietReason: null,
          items: [],
          createdAt: "2026-11-01T10:01:00.000Z",
        },
      ],
      (id) => (id === RELEASE ? "Release" : "Docs"),
    );
    expect(rows.map((r) => [r.text, r.settled])).toEqual([
      ["Sent to Release as a proposal: Rerun api-e2e on #318", true],
      ["Sent to Docs", false],
    ]);
  });
});

describe("overlap card", () => {
  const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];

  it("caps the shared files and folds the rest into +N more until expanded", () => {
    const view = squireOverlapView({ paths, recommendation: " Land #318 first. " });
    expect(view.shownPaths).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    expect(view.moreLabel).toBe("+2 more");
    expect(view.recommendation).toBe("Land #318 first.");
    const all = squireOverlapView({ paths, recommendation: "" }, { showAllPaths: true });
    expect(all.shownPaths).toEqual(paths);
    expect(all.moreLabel).toBeNull();
    expect(all.recommendation).toBeNull();
    expect(squireOverlapView({ paths: ["a.ts"], recommendation: "x" }).moreLabel).toBeNull();
  });

  it("names each thread by title, provider instance or driver, and branch", () => {
    const driverName = (driver: string) => (driver === "codex" ? "Codex" : undefined);
    const thread = { provider: "codex", branch: "fix/rounding" } as Parameters<
      typeof squireOverlapThreadLine
    >[0];
    expect(
      squireOverlapThreadLine(thread, {
        title: "Fix invoice rounding",
        instanceName: "Codex (work)",
        driverName,
      }),
    ).toEqual({
      label: "Fix invoice rounding",
      provider: "Codex (work)",
      branch: "fix/rounding",
      pullRequest: null,
    });
    expect(
      squireOverlapThreadLine(
        { ...thread, pullRequest: 321 },
        {
          title: "Fix invoice rounding",
          instanceName: null,
          driverName,
        },
      ).pullRequest,
    ).toBe("#321");
    expect(
      squireOverlapThreadLine({ ...thread, provider: "acme", branch: " " } as typeof thread, {
        title: null,
        instanceName: null,
        driverName,
      }),
    ).toEqual({ label: "Untitled thread", provider: "acme", branch: null, pullRequest: null });
  });

  it("offers Review as its primary", () => {
    expect(
      squireCardPrimaryLabel({
        type: "overlap",
        repository: "repo",
        threads: [],
        paths: ["a.ts"],
        recommendation: "",
      } as unknown as Parameters<typeof squireCardPrimaryLabel>[0]),
    ).toBe("Review");
  });
});

describe("row meta", () => {
  const release = { name: "Release", role: "squire" as const };
  const lead = { name: "Captain", role: "lead" as const };

  it("reads raiser then thread in the Lead view", () => {
    expect(
      squireRowMeta({
        title: "billing-service #321: required checks failing",
        raiser: release,
        targetName: "Fix invoice rounding",
      }),
    ).toEqual({ raiser: "Release", target: "Fix invoice rounding" });
  });

  it("labels the Lead's own items Lead, whatever the Lead is named", () => {
    expect(
      squireRowMeta({
        title: "Overlap: Fix invoice rounding and Currency display cleanup",
        raiser: lead,
        targetName: "billing-service",
      }),
    ).toEqual({ raiser: "Lead", target: "billing-service" });
  });

  it("keeps the raiser when the target only repeats the title", () => {
    expect(
      squireRowMeta({
        title: "Currency display cleanup",
        raiser: null,
        targetName: " currency display  cleanup",
      }),
    ).toBeNull();
    expect(
      squireRowMeta({
        title: "Currency display cleanup",
        raiser: { name: "Research", role: "squire" },
        targetName: "Currency display cleanup",
      }),
    ).toEqual({ raiser: "Research", target: null });
  });
});

describe("onboarding proposals shown above the queue", () => {
  const proposals = [
    row("proposal", { id: "p1", squireId: LEAD, ownerSquireId: LEAD }),
    row("proposal", { id: "p2", squireId: LEAD, ownerSquireId: LEAD }),
    row("proposal", { id: "p3", squireId: LEAD, ownerSquireId: LEAD }),
  ];
  const above = new Set(["p1", "p2", "p3"]);
  const options = { chip: "all" as const, teamFilter: null, selected: null, hasMore: false };
  const countOf = (view: ReturnType<typeof squireQueueView>, chip: string) =>
    view.chips.find((candidate) => candidate.chip === chip)?.count;

  it("counts them in the chips while leaving them out of the groups", () => {
    const view = squireQueueView(proposals, { ...options, shownAbove: above });
    expect(countOf(view, "all")).toBe(3);
    expect(countOf(view, "proposal")).toBe(3);
    expect(view.decision).toBeNull();
    expect(view.aboveCount).toBe(3);
    expect(squireQueueEmptyText("all", view.aboveCount)).toBe("3 proposals above");
  });

  it("keeps other rows listed and counts only what the chip shows above", () => {
    const steer = row("steer");
    const view = squireQueueView([...proposals, steer], {
      ...options,
      chip: "steer",
      shownAbove: above,
    });
    expect(view.decision?.items).toEqual([steer]);
    expect(view.aboveCount).toBe(0);
    const proposalView = squireQueueView([...proposals, steer], {
      ...options,
      chip: "proposal",
      shownAbove: new Set(["p1"]),
    });
    expect(proposalView.aboveCount).toBe(1);
    expect(proposalView.decision?.items.map((item) => item.id)).toEqual(["p2", "p3"]);
    expect(squireQueueEmptyText("proposal", 1)).toBe("1 proposal above");
  });

  it("hides the chips and empty line only while every open item shows above", () => {
    expect(squireQueueView(proposals, { ...options, shownAbove: above }).onlyAbove).toBe(true);
    // Under any chip: the rule is about the open items, not what the chip lists.
    expect(
      squireQueueView(proposals, { ...options, chip: "steer", shownAbove: above }).onlyAbove,
    ).toBe(true);
    // Another open item, a proposal the panel does not show, or an unloaded page keeps them.
    expect(
      squireQueueView([...proposals, row("fyi")], { ...options, shownAbove: above }).onlyAbove,
    ).toBe(false);
    expect(
      squireQueueView(proposals, { ...options, shownAbove: new Set(["p1", "p2"]) }).onlyAbove,
    ).toBe(false);
    expect(
      squireQueueView(proposals, { ...options, hasMore: true, shownAbove: above }).onlyAbove,
    ).toBe(false);
    // Outside onboarding, an empty queue still shows its chips and says nothing waits.
    expect(squireQueueView([], options).onlyAbove).toBe(false);
    expect(squireQueueView([], { ...options, shownAbove: above }).onlyAbove).toBe(false);
  });

  it("says nothing waits only when nothing shows above either", () => {
    expect(squireQueueEmptyText("all", 0)).toBe("Nothing is waiting on you.");
    expect(squireQueueEmptyText("overlap", 0)).toBe("No open overlap items.");
  });
});

describe("inbox detail subtitle", () => {
  const names = {
    threadTitle: "Fix invoice rounding",
    provider: "Codex",
    projectTitle: "billing-service",
    proposalScope: "billing-service · Observatory",
    squireName: (id: SquireId) => (id === RELEASE ? "Release" : "A Squire"),
  };
  const onThread = { targetThreadId: THREAD };
  const offThread = { targetThreadId: null };

  it("names an overlap by its repository and how many threads collide", () => {
    const overlap = {
      type: "overlap",
      repository: "acme/billing-service",
      threads: [{}, {}],
      paths: ["src/a.ts"],
      recommendation: "",
    } as never;
    expect(squireCardSubtitle(offThread, overlap, names)).toEqual(["billing-service", "2 threads"]);
    expect(
      squireCardSubtitle(
        offThread,
        { ...(overlap as object), repository: "project-fixture-api-1a2b" } as never,
        { ...names, projectTitle: null },
      ),
    ).toEqual(["project-fixture-api-1a2b", "2 threads"]);
  });

  it("names a proposal by what it would create and where", () => {
    expect(squireCardSubtitle(offThread, { type: "thread-proposal" } as never, names)).toEqual([
      "New thread",
      "billing-service",
    ]);
    expect(squireCardSubtitle(offThread, { type: "squire-proposal" } as never, names)).toEqual([
      "New Squire",
      "billing-service · Observatory",
    ]);
    expect(
      squireCardSubtitle(offThread, { type: "squire-proposal" } as never, {
        ...names,
        proposalScope: null,
      }),
    ).toEqual(["New Squire"]);
  });

  it("names a steer or question by its thread and provider", () => {
    expect(squireCardSubtitle(onThread, { type: "steer" } as never, names)).toEqual([
      "Fix invoice rounding",
      "Codex",
    ]);
    expect(
      squireCardSubtitle(onThread, { type: "question" } as never, {
        ...names,
        threadTitle: null,
        provider: null,
      }),
    ).toEqual(["Thread"]);
  });

  it("names a control proposal by the Squire it acts on", () => {
    expect(
      squireCardSubtitle(offThread, { type: "control", squireId: RELEASE } as never, names),
    ).toEqual(["Release"]);
    expect(
      squireCardSubtitle(offThread, { type: "control", squireId: null } as never, names),
    ).toEqual([]);
  });
});

describe("FYI row text", () => {
  it("reads only a turn summary's card, since its title is the thread alone", () => {
    expect(squireFyiNeedsText(row("fyi", { fyiSource: "summary" }))).toBe(true);
    expect(squireFyiNeedsText(row("fyi", { fyiSource: "notify" }))).toBe(false);
    expect(squireFyiNeedsText(row("fyi"))).toBe(false);
  });

  it("adds what happened after the thread's name", () => {
    expect(squireFyiRowText("Fix invoice rounding", "Fix invoice rounding: checks passed")).toBe(
      "Fix invoice rounding · checks passed",
    );
    expect(squireFyiRowText("Fix invoice rounding", "PR merged\nmore detail")).toBe(
      "Fix invoice rounding · PR merged",
    );
  });

  it("keeps the title when the text is missing or says nothing more", () => {
    expect(squireFyiRowText("Fix invoice rounding", null)).toBe("Fix invoice rounding");
    expect(squireFyiRowText("Fix invoice rounding", "fix invoice rounding")).toBe(
      "Fix invoice rounding",
    );
    expect(squireFyiRowText("Fix invoice rounding", "Fix invoice rounding:  ")).toBe(
      "Fix invoice rounding",
    );
  });
});

describe("title beside its kind label", () => {
  it("drops a leading kind label the row already shows", () => {
    expect(squireTitleBesideKind("Overlap: Fix invoice rounding and Currency", "overlap")).toBe(
      "Fix invoice rounding and Currency",
    );
    expect(squireTitleBesideKind("question:  Ship offline-only?", "question")).toBe(
      "Ship offline-only?",
    );
  });

  it("keeps titles that do not start with the label, or are only the label", () => {
    expect(squireTitleBesideKind("Overlapping edits in billing", "overlap")).toBe(
      "Overlapping edits in billing",
    );
    expect(squireTitleBesideKind("Overlap: Fix rounding", "question")).toBe(
      "Overlap: Fix rounding",
    );
    expect(squireTitleBesideKind("Overlap:", "overlap")).toBe("Overlap:");
  });
});

describe("squireRepositoryLabel", () => {
  it("names an overlap's repository by its project, else its folder or repo name", () => {
    expect(
      squireRepositoryLabel("project-fixture-billing-service-435326b9", "billing-service"),
    ).toBe("billing-service");
    expect(squireRepositoryLabel("/Users/me/code/billing-service/", null)).toBe("billing-service");
    expect(squireRepositoryLabel("github.com/acme/billing-service.git", null)).toBe(
      "billing-service",
    );
    expect(squireRepositoryLabel("git@github.com:acme/api.git", " ")).toBe("api");
  });
});
