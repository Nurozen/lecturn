import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import type { EnvironmentId, SquireCardId, SquireId, SquireRuleOffer } from "@lecturn/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { uuidv4 } from "../../lib/uuid";
import { squireEnvironment } from "../../state/squire";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "../threads/RequestActionButton";
import { squireOfferRuleInput, type SquireRuleOfferPromptView } from "./squireApproval.logic";

/**
 * "Always allow this" after an accept, or "Always ask first for this" after an Undo: the
 * exact rule text, then save or leave it. It lives outside the card, so it outlasts the row.
 */
export function SquireRuleOfferPrompt(props: {
  readonly environmentId: EnvironmentId;
  readonly card: { readonly id: SquireCardId; readonly squireId: SquireId };
  readonly offer: SquireRuleOffer;
  /** `squireAcceptOffer` or `squireUndoOffer` of the offer; null renders nothing. */
  readonly prompt: SquireRuleOfferPromptView | null;
  readonly onClose: () => void;
}) {
  const canCreate = useAtomValue(squireEnvironment.ruleCreate.permissionAtom(props.environmentId));
  const create = useAtomCommand(squireEnvironment.ruleCreate, { reportFailure: false });
  const [target, setTarget] = useState<"offer" | "alternative">("offer");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { prompt } = props;
  if (prompt === null || !canCreate) return null;
  const text =
    target === "alternative" && prompt.alternative !== null ? prompt.alternative.text : prompt.text;

  const save = async () => {
    setSaving(true);
    setError(null);
    const result = await create({
      environmentId: props.environmentId,
      input: { requestId: uuidv4(), ...squireOfferRuleInput(props.offer, target, props.card) },
    });
    setSaving(false);
    if (result._tag === "Success") {
      props.onClose();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(
      failure instanceof Error && failure.message.trim() !== ""
        ? failure.message
        : "The rule could not be saved. Try again.",
    );
  };

  return (
    <View
      accessibilityLiveRegion="polite"
      className="gap-2 rounded-2xl border border-border bg-subtle px-3 py-2.5"
    >
      <Text className="font-lecturn-bold text-sm text-foreground">{prompt.action}</Text>
      <Text className="font-sans text-sm leading-5 text-foreground-secondary">{text}</Text>
      {error === null ? null : (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      )}
      <View className="flex-row flex-wrap gap-2">
        {prompt.canSave ? (
          <RequestActionButton label="Save rule" disabled={saving} onPress={() => void save()} />
        ) : null}
        {prompt.alternative === null ? null : (
          <RequestActionButton
            label={target === "offer" ? "Widen to the container" : "Only this thread"}
            tone="secondary"
            disabled={saving}
            onPress={() => setTarget(target === "offer" ? "alternative" : "offer")}
          />
        )}
        <RequestActionButton
          label={prompt.canSave ? "Not now" : "OK"}
          tone="secondary"
          onPress={props.onClose}
        />
      </View>
    </View>
  );
}
