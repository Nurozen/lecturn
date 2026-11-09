import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import { UnknownUnionMember } from "@lecturn/contracts";
import type {
  EnvironmentId,
  ProviderApprovalDecision,
  RuntimeRequestId,
  SquireCard,
  SquireQuestionRequest,
} from "@lecturn/contracts";
import { useState } from "react";

import {
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@lecturn/client-runtime/state/pending-user-input";
import { findFirstUnansweredPendingUserInputQuestionIndex } from "../../../pendingUserInput";
import type { PendingUserInput } from "../../../session-logic";
import { ComposerPendingApprovalActions } from "../../chat/ComposerPendingApprovalActions";
import { ComposerPendingUserInputPanel } from "../../chat/ComposerPendingUserInputPanel";
import { Button } from "../../ui/button";
import {
  squireApprovalAnswer,
  squireQuestionPanelQuestions,
} from "@lecturn/client-runtime/state/squire";
import { squireUserInputAnswer } from "./squireCard.logic";

type QuestionPayload = Extract<SquireCard["payload"], { readonly type: "question" }>;

export type SquireAnswer =
  | { readonly decision: ProviderApprovalDecision }
  | { readonly answers: Record<string, unknown> };

/**
 * The thread's own pending-request controls, fed from the card's live copy of the
 * request instead of the thread's detail, and answered through `squire.items.act`.
 */
export function SquireQuestionAnswer(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: QuestionPayload;
  /** The card's title, which the header already shows. */
  readonly title: string;
  readonly disabled: boolean;
  readonly onAnswer: (answer: SquireAnswer) => Promise<boolean>;
}) {
  const request = props.payload.request;
  if (request === undefined || request instanceof UnknownUnionMember) return null;
  return request.type === "approval" ? (
    <ApprovalAnswer {...props} request={request} />
  ) : (
    <UserInputAnswer {...props} request={request} />
  );
}

function ApprovalAnswer(props: {
  readonly payload: QuestionPayload;
  readonly request: Extract<SquireQuestionRequest, { readonly type: "approval" }>;
  readonly disabled: boolean;
  readonly onAnswer: (answer: SquireAnswer) => Promise<boolean>;
}) {
  const [responding, setResponding] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ComposerPendingApprovalActions
        requestId={props.payload.requestId as RuntimeRequestId}
        isResponding={responding}
        canRespond={props.request.canRespond}
        disabled={props.disabled}
        options={props.request.options}
        onRespondToApproval={async (_requestId, decision) => {
          setResponding(true);
          await props.onAnswer(squireApprovalAnswer(decision));
          setResponding(false);
        }}
      />
      {props.request.canRespond ? null : (
        <span className="text-xs text-muted-foreground">
          The thread's session ended; answer it in the thread.
        </span>
      )}
    </div>
  );
}

function UserInputAnswer(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: QuestionPayload;
  readonly title: string;
  readonly request: Extract<SquireQuestionRequest, { readonly type: "user-input" }>;
  readonly disabled: boolean;
  readonly onAnswer: (answer: SquireAnswer) => Promise<boolean>;
}) {
  const { payload, request } = props;
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [responding, setResponding] = useState(false);
  const requestId = payload.requestId as RuntimeRequestId;
  const prompt: PendingUserInput = {
    requestId,
    createdAt: "",
    // Answers key by question id, so blanking the text the header already shows changes nothing.
    questions: squireQuestionPanelQuestions(request.questions, props.title).map((question) => ({
      ...question,
      multiSelect: question.multiSelect ?? false,
    })),
    responseCapability: request.canRespond ? "live" : "not_resumable",
    dismissible: false,
  };

  const submit = async (next: Record<string, PendingUserInputDraftAnswer>) => {
    const answer = squireUserInputAnswer(prompt.questions, next);
    if (answer === null) {
      setQuestionIndex(findFirstUnansweredPendingUserInputQuestionIndex(prompt.questions, next));
      return;
    }
    setResponding(true);
    const answered = await props.onAnswer(answer);
    setResponding(false);
    if (!answered) setQuestionIndex(0);
  };

  // The panel calls this after a single-select pick lands, so the drafts are current.
  const advance = () => {
    if (questionIndex < prompt.questions.length - 1) setQuestionIndex(questionIndex + 1);
    else void submit(drafts);
  };
  const activeIsMultiSelect =
    prompt.questions[Math.min(questionIndex, prompt.questions.length - 1)]?.multiSelect === true;

  return (
    // The panel's rows size their icon column from the composer banner's variable, which only
    // the composer defines; without it the grid's tracks stretch and center the header.
    <div className="overflow-hidden rounded-md border border-border [--composer-banner-icon-column:--spacing(6)] [--composer-banner-padding-block:--spacing(1)]">
      <ComposerPendingUserInputPanel
        pendingUserInputs={[prompt]}
        cwd={undefined}
        threadRef={scopeThreadRef(props.environmentId, payload.threadId)}
        disabled={props.disabled}
        respondingRequestIds={responding ? [requestId] : []}
        answers={drafts}
        questionIndex={questionIndex}
        onToggleOption={(questionId, optionValue) => {
          const question = prompt.questions.find((candidate) => candidate.id === questionId);
          if (question === undefined) return;
          setDrafts((current) => ({
            ...current,
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              current[questionId],
              optionValue,
            ),
          }));
        }}
        onAdvance={advance}
        onDismiss={() => {}}
      />
      {activeIsMultiSelect ? (
        <div className="flex justify-end border-t border-border px-2 py-1.5">
          <Button size="xs" disabled={props.disabled || responding} onClick={advance}>
            {questionIndex < prompt.questions.length - 1 ? "Next" : "Send answer"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
