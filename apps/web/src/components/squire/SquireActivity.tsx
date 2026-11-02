import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SquireActionLogEntry, SquireId } from "@lecturn/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import { DownloadIcon, HistoryIcon } from "lucide-react";
import { memo, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { squireEnvironment } from "../../state/squires";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { squireActionLogExport } from "./squireActionLogExport";
import { squireActionLogFileName } from "./squireActionLogExport.logic";
import { SQUIRE_ACTIVITY_KINDS, squireActivityLabel } from "./squirePage.logic";

const ACTIVITY_PAGE = 50;

/** D64: outcomes outside a turn, which the home thread cannot show. */
export const SquireActivity = memo(function SquireActivity(props: {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  readonly name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="xs" variant="ghost" />}>
        <HistoryIcon />
        Activity
      </PopoverTrigger>
      <PopoverPopup width="md" padding="compact" align="end">
        <PopoverTitle>Activity</PopoverTitle>
        {/* Mounted only while open, so the log is fetched and refreshed only while it is read. */}
        {open ? <SquireActivityList {...props} /> : null}
        <SquireActionLogExportButton {...props} />
      </PopoverPopup>
    </Popover>
  );
});

function SquireActivityList(props: {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
}) {
  const result = useAtomValue(
    squireEnvironment.actionLog({
      environmentId: props.environmentId,
      input: { squireId: props.squireId, kinds: SQUIRE_ACTIVITY_KINDS, limit: ACTIVITY_PAGE },
    }),
  );
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const entries = Option.getOrNull(AsyncResult.value(result))?.entries ?? null;
  if (entries === null) {
    return result._tag === "Failure" ? (
      <p className="mt-2 text-xs text-muted-foreground">Activity could not be loaded.</p>
    ) : (
      <div className="mt-2 flex justify-center">
        <Spinner />
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">Nothing has happened outside a turn yet.</p>
    );
  }
  return (
    <ol className="mt-2 flex max-h-80 flex-col gap-1 overflow-y-auto text-xs">
      {entries.map((entry: SquireActionLogEntry) => (
        <li key={entry.id} className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="truncate">{squireActivityLabel(entry)}</span>
          <time dateTime={entry.createdAt} className="shrink-0 text-muted-foreground tabular-nums">
            {formatDayAwareTimestamp(entry.createdAt, timestampFormat)}
          </time>
        </li>
      ))}
    </ol>
  );
}

/** P14.1: the full action log, every kind, as the server's NDJSON export. */
function SquireActionLogExportButton(props: {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  readonly name: string;
}) {
  const download = useAtomCommand(squireActionLogExport, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const result = await download({
      environmentId: props.environmentId,
      input: { squireId: props.squireId },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not export the action log",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }
    const url = URL.createObjectURL(result.value);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = squireActionLogFileName({ id: props.squireId, name: props.name });
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  return (
    <div className="mt-2 flex justify-end border-t border-border/60 pt-2">
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void save()}>
        {busy ? <Spinner /> : <DownloadIcon />}
        Export action log
      </Button>
    </div>
  );
}
