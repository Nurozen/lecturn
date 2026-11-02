import { UnknownUnionMember } from "@lecturn/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppTextInput as TextInput } from "../../components/ui/AppText";
import {
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../lib/threadActivity";
import { PendingApprovalOptions } from "../threads/PendingApprovalCard";
import { PendingUserInputQuestionList } from "../threads/PendingUserInputCard";
import { RequestActionButton } from "../threads/RequestActionButton";
import {
  squireApprovalAnswer,
  squireSeededDrafts,
  squireUserInputAnswer,
  squireUserInputQuestions,
  type SquireAnswer,
  type SquireQuestionPayload,
  type SquireUserInputRequest,
} from "./squireQueue.logic";

/**
 * The thread's own request controls, fed from the card's live copy of the request
 * and answered through `squire.items.act`, so the thread need not be the selected one.
 */
export function SquireQuestionAnswer(props: {
  readonly payload: SquireQuestionPayload;
  /** The card's title, which the card already shows. */
  readonly title: string;
  readonly disabled: boolean;
  readonly onAnswer: (answer: SquireAnswer) => Promise<boolean>;
}) {
  const request = props.payload.request;
  if (request === undefined || request instanceof UnknownUnionMember) return null;
  if (request.type === "approval") {
    return (
      <View className="gap-2.5">
        <PendingApprovalOptions
          options={request.options}
          disabled={props.disabled}
          onRespond={(decision) => void props.onAnswer(squireApprovalAnswer(decision))}
        />
      </View>
    );
  }
  return <UserInputAnswer {...props} request={request} />;
}

function UserInputAnswer(props: {
  readonly request: SquireUserInputRequest;
  readonly title: string;
  readonly disabled: boolean;
  readonly onAnswer: (answer: SquireAnswer) => Promise<boolean>;
}) {
  const questions = squireUserInputQuestions(props.request, props.title);
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const answer = squireUserInputAnswer(questions, drafts);
  const shown = squireSeededDrafts(questions, drafts);
  return (
    <View className="gap-3">
      <PendingUserInputQuestionList
        questions={questions}
        drafts={shown}
        disabled={props.disabled}
        onSelectOption={(question, optionValue) =>
          setDrafts((current) => ({
            ...current,
            [question.id]: togglePendingUserInputOptionSelection(
              question,
              current[question.id],
              optionValue,
            ),
          }))
        }
        // Question attachments bind to the selected thread, so the card takes text only.
        renderCustomAnswer={(question, draft) => (
          <TextInput
            accessibilityLabel={`Other answer for ${question.header}`}
            placeholder="Other answer"
            value={draft?.customAnswer ?? ""}
            editable={!props.disabled}
            onChangeText={(value) =>
              setDrafts((current) => ({
                ...current,
                [question.id]: setPendingUserInputCustomAnswer(
                  question,
                  current[question.id],
                  value,
                ),
              }))
            }
            className="text-sm"
          />
        )}
      />
      <RequestActionButton
        label="Submit answers"
        size="large"
        tone={answer === null ? "secondary" : "primary"}
        disabled={props.disabled || answer === null}
        onPress={() => {
          if (answer !== null) void props.onAnswer(answer);
        }}
      />
    </View>
  );
}
