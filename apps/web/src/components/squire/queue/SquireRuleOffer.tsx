import { useAtomValue } from "@effect/atom-react";
import type { squireRuleOfferPrompt } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireCardRow, SquireRuleOffer } from "@lecturn/contracts";
import { useState } from "react";

import { randomUUID } from "../../../lib/utils";
import { squireEnvironment } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { squireOfferRuleInput } from "./squireQueue.logic";

/**
 * "Always allow this" after an accept, or "Always ask first for this" after an Undo: the
 * exact rule text, then save or leave it.
 */
export function SquireRuleOfferPrompt(props: {
  readonly environmentId: EnvironmentId;
  readonly card: Pick<SquireCardRow, "id" | "squireId">;
  readonly offer: SquireRuleOffer;
  /** `squireAcceptOffer` or `squireUndoOffer` of the offer; null renders nothing. */
  readonly prompt: ReturnType<typeof squireRuleOfferPrompt> | null;
  readonly onClose: () => void;
}) {
  const canCreate = useAtomValue(squireEnvironment.ruleCreate.permissionAtom(props.environmentId));
  const create = useAtomCommand(squireEnvironment.ruleCreate);
  const [target, setTarget] = useState<"offer" | "alternative">("offer");
  const [saving, setSaving] = useState(false);
  const { prompt } = props;
  if (prompt === null || !canCreate) return null;
  const text =
    target === "alternative" && prompt.alternative !== null ? prompt.alternative.text : prompt.text;

  const save = async () => {
    setSaving(true);
    const result = await create({
      environmentId: props.environmentId,
      input: {
        requestId: randomUUID(),
        ...squireOfferRuleInput(props.offer, target, props.card),
      },
    });
    setSaving(false);
    if (result._tag === "Success") props.onClose();
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
    >
      <span className="font-medium text-foreground">{prompt.action}</span>
      <span className="min-w-0 flex-1 text-muted-foreground">{text}</span>
      {prompt.alternative === null ? null : (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setTarget(target === "offer" ? "alternative" : "offer")}
        >
          {target === "offer" ? "Widen to the container" : "Only this thread"}
        </Button>
      )}
      {prompt.canSave ? (
        <Button size="xs" disabled={saving} onClick={() => void save()}>
          Save rule
        </Button>
      ) : null}
      <Button size="xs" variant="outline" onClick={props.onClose}>
        {prompt.canSave ? "Not now" : "OK"}
      </Button>
    </div>
  );
}
