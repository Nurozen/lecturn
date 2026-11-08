import { squireQuestionRecommendation } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, MessageId, SquireCard, ThreadId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  squireOpenInThreadTarget,
  squireQuestionMode,
  squireUserInputAnswer,
} from "./squireCard.logic";

const ENV = "env-1" as EnvironmentId;
const THREAD = "thread-1" as ThreadId;

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
