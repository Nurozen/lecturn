import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@lecturn/contracts";
import { useMemo, useState } from "react";
import { staveOperations } from "../../state/staveOperations";
import { Button } from "../ui/button";
import { StaveConfirmDialog } from "./StaveConfirmDialog";
import { StaveOperationProgress as ProgressBody } from "./StaveOperationProgressBody";
import { removePartialSpaceAvailability } from "./staveOperationProgress.logic";
import { partialSpaceFromError } from "./staveSpaceWizard.logic";

export function StaveOperationProgress(props: {
  environmentId: EnvironmentId;
  operationId: string;
  spaceId?: string;
  compact?: boolean;
}) {
  const state = useAtomValue(staveOperations.stateAtom(props.operationId));
  const [confirming, setConfirming] = useState(false);
  const [removed, setRemoved] = useState(false);
  const availability = useMemo(
    () =>
      props.spaceId === undefined ? null : removePartialSpaceAvailability(state, props.spaceId),
    [state, props.spaceId],
  );
  const removal = useMemo(
    () => (availability?.kind === "available" ? { ...availability.operation, force: false } : null),
    [availability],
  );
  const partial = partialSpaceFromError(state.error, props.spaceId ?? "");
  return (
    <div className="flex flex-col gap-3">
      <ProgressBody {...props} />
      {state.status === "failed" && availability !== null ? (
        <div className="flex flex-col items-start gap-2">
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={removal === null || removed}
            onClick={() => setConfirming(true)}
          >
            {removed ? "Partial space removed" : "Remove partial space"}
          </Button>
          {availability.kind === "unavailable" ? (
            <p className="text-xs text-muted-foreground">{availability.hint}</p>
          ) : null}
        </div>
      ) : null}
      {confirming && removal !== null ? (
        <StaveConfirmDialog
          environmentId={props.environmentId}
          operation={removal}
          title="Remove partial space"
          membershipWorkspaceRoot={partial?.spacePath}
          onClose={() => setConfirming(false)}
          onFinished={() => setRemoved(true)}
        />
      ) : null}
    </div>
  );
}
