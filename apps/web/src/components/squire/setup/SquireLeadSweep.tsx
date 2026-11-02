import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SquireId } from "@lecturn/contracts";
import { SearchIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "../../../hooks/useSettings";
import { randomUUID } from "../../../lib/utils";
import { useEnvironmentQuery } from "../../../state/query";
import { squireEnvironment, useSquireEnvironmentState } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { formatDayAwareTimestamp } from "../../../timestampFormat";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import {
  squireLeadSweepOutcomeText,
  squireSweepAcceptance,
  squireSweepAcceptanceText,
} from "./squireSetupAutomation.logic";

// Findings are capped per day (default 6), so 30 days fit in one page.
const SWEEP_FINDING_PAGE = 200;

/** P17.10 "Accepted 3 of 12 in the last 30 days", in the Lead's setup sheet. */
export function SquireSweepAcceptance(props: {
  readonly environmentId: EnvironmentId;
  readonly leadId: SquireId;
}) {
  const log = useEnvironmentQuery(
    squireEnvironment.actionLog({
      environmentId: props.environmentId,
      input: { squireId: props.leadId, kinds: ["sweep.finding"], limit: SWEEP_FINDING_PAGE },
    }),
  );
  if (log.data === null) return null;
  // The fetch time anchors the window, so the text matches the rows it counted.
  const rate = squireSweepAcceptance(log.data.entries, log.dataUpdatedAt);
  return <p className="text-xs text-muted-foreground">{squireSweepAcceptanceText(rate)}</p>;
}

/** P17.10 on-request sweep, in the Lead's view header. */
export function SquireFindWorkButton(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const state = useSquireEnvironmentState(environmentId);
  const canSweep = useAtomValue(squireEnvironment.leadSweep.permissionAtom(environmentId));
  const sweep = useAtomCommand(squireEnvironment.leadSweep);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [pending, setPending] = useState(false);
  if (state === null || state.lead === null || !canSweep) return null;
  const findWork = async () => {
    setPending(true);
    const result = await sweep({ environmentId, input: { requestId: randomUUID() } });
    setPending(false);
    if (result._tag !== "Success") return;
    const title = squireLeadSweepOutcomeText(result.value, (iso) =>
      formatDayAwareTimestamp(iso, timestampFormat),
    );
    toastManager.add({ type: result.value.outcome === "queued" ? "success" : "info", title });
  };
  return (
    <Button size="xs" variant="ghost" disabled={pending} onClick={() => void findWork()}>
      <SearchIcon />
      Find work
    </Button>
  );
}
