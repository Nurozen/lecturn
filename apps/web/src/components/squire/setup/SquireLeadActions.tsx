import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SquireActionLogKind, SquireId } from "@lecturn/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { useClientSettings } from "../../../hooks/useSettings";
import { randomUUID } from "../../../lib/utils";
import { squireEnvironment } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { formatDayAwareTimestamp } from "../../../timestampFormat";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import {
  squireCommandError,
  squireLeadActionRows,
  squireLeadActionText,
  type SquireLeadActionRow,
} from "./squireSetup.logic";
import { SetupSection } from "./SquireSetupLayout";

const CONTROL_KINDS: ReadonlyArray<SquireActionLogKind> = ["action.executed", "control.reverted"];
const PAGE = 50;

/** What the Lead did to its Squires, each with Revert. */
export function SquireLeadActions(props: {
  readonly environmentId: EnvironmentId;
  readonly leadId: SquireId;
}) {
  const { environmentId, leadId } = props;
  const result = useAtomValue(
    squireEnvironment.actionLog({
      environmentId,
      input: { squireId: leadId, kinds: CONTROL_KINDS, limit: PAGE },
    }),
  );
  const state = useAtomValue(squireEnvironment.state(environmentId));
  const canRevert = useAtomValue(squireEnvironment.controlRevert.permissionAtom(environmentId));
  const entries = Option.getOrNull(AsyncResult.value(result))?.entries ?? null;
  const nameOf = (id: SquireId) =>
    state?.squires.find((entry) => entry.squire.id === id)?.squire.name ?? "a removed Squire";
  const rows = entries === null ? [] : squireLeadActionRows(entries);
  return (
    <SetupSection
      title="Lead actions"
      description="Pauses, rescopes, forwards, and merges the Lead made. Revert restores what it replaced."
    >
      {entries === null ? (
        result._tag === "Failure" ? (
          <p className="text-sm text-muted-foreground">Lead actions could not be loaded.</p>
        ) : (
          <Spinner />
        )
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">The Lead has not changed any Squire yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <LeadActionRow
              key={row.logEntryId}
              environmentId={environmentId}
              row={row}
              text={squireLeadActionText(row, nameOf)}
              canRevert={canRevert}
            />
          ))}
        </ul>
      )}
    </SetupSection>
  );
}

function LeadActionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: SquireLeadActionRow;
  readonly text: string;
  readonly canRevert: boolean;
}) {
  const { row } = props;
  const revert = useAtomCommand(squireEnvironment.controlRevert, { reportFailure: false });
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const onRevert = async () => {
    setPending(true);
    setError(null);
    const result = await revert({
      environmentId: props.environmentId,
      input: { requestId: randomUUID(), logEntryId: row.logEntryId },
    });
    setPending(false);
    if (result._tag === "Success") setDone(true);
    else setError(squireCommandError(result, "This action could not be reverted."));
  };

  const reverted = row.reverted || done;
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm text-foreground">{props.text}</span>
          <span className="text-xs text-muted-foreground">
            {formatDayAwareTimestamp(row.at, timestampFormat)}
            {row.reason === null ? "" : ` · ${row.reason}`}
          </span>
        </div>
        {reverted ? (
          <span className="shrink-0 text-xs text-muted-foreground">Reverted</span>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={!props.canRevert || pending}
            onClick={() => void onRevert()}
          >
            Revert
          </Button>
        )}
      </div>
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
    </li>
  );
}
