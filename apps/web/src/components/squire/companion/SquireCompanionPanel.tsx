import { squireFigureState, type SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SquireId } from "@lecturn/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useRef } from "react";

import { useQuietThreadShell } from "../../../state/entities";
import { squireEnvironment } from "../../../state/squires";
import { SquireCompanion, type SquireCompanionHandle } from "../SquireCompanion";
import { useSquireViewStateLine } from "../SquireHeader";
import { SQUIRE_QUEUE_PAGE_SIZE } from "../queue/squireQueue.logic";
import {
  SQUIRE_COMPANION_PANEL_PX,
  SQUIRE_RECENT_KINDS,
  SQUIRE_RECENT_LOG_LIMIT,
  squireRecentEntries,
  squireRecentFromSnapshot,
  squireRecentLabel,
  squireRecentRowText,
  type SquireRecentEntry,
} from "../squirePage.logic";
import { useActivityAge } from "./SquireHoverCard";
import { useSquireGestureRequests } from "../lead/squireGestureRequests";
import { useSquireGesturePlayer } from "./squireGesturePlayer";

/**
 * Spec P16.5(a): the selected Squire's full figure (the Lead's in the Lead view), mounted only
 * while the view is wide enough. Figure 300 px wide, so 375 px tall on the 1122 x 1402 stage.
 */
export function SquireCompanionPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly team: ReadonlyArray<SquireSnapshotEntry>;
}) {
  const { environmentId, entry, team } = props;
  const { squire } = entry;
  const isLead = squire.role === "lead";
  // The header's line, so the panel and header agree on the count.
  const { indicator, line: stateLine } = useSquireViewStateLine(environmentId, entry, team);
  const companion = useRef<SquireCompanionHandle>(null);
  useSquireGesturePlayer(squire.id, entry.recentActivity, companion, squire.role !== "lead");
  useSquireGestureRequests(squire.id, companion);

  return (
    <aside
      aria-label={`${squire.name} companion`}
      data-testid="squire-companion-panel"
      className="flex shrink-0 flex-col items-center gap-4 overflow-y-auto scrollbar-gutter-both border-l border-border px-5 pt-8 pb-6"
      style={{ width: SQUIRE_COMPANION_PANEL_PX }}
    >
      <SquireCompanion
        ref={companion}
        companion={squire.companion}
        state={squireFigureState(indicator.state)}
        placement="panel"
        crest={isLead}
        label={`${squire.name}: ${stateLine}`}
        className={squire.companion.presence === "figure" ? "w-75" : "w-60"}
        facesContent
      />
      <div className="flex w-full min-w-0 flex-col items-center gap-0.5 text-center">
        <p className="w-full truncate text-sm font-medium">{squire.name}</p>
        <p className="text-sm text-muted-foreground">{stateLine}</p>
      </div>
      <SquireRecentList
        environmentId={environmentId}
        squireId={squire.id}
        recentActivity={entry.recentActivity}
      />
    </aside>
  );
}

/**
 * The snapshot names only each entry's kind, so the list reads the action log for the detail
 * ("Sent a steer to <thread>"). The panel is mounted once (R37), and the log query refreshes only
 * when the snapshot's newest activity moves.
 */
function SquireRecentList(props: {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  readonly recentActivity: SquireSnapshotEntry["recentActivity"];
}) {
  const { environmentId, squireId } = props;
  const log = useAtomValue(
    squireEnvironment.actionLog({
      environmentId,
      input: { squireId, kinds: SQUIRE_RECENT_KINDS, limit: SQUIRE_RECENT_LOG_LIMIT },
    }),
  );
  // The queue's own first page (same key), so card titles cost no extra request.
  const queue = useAtomValue(
    squireEnvironment.items({
      environmentId,
      input: { squireId, scope: "open", limit: SQUIRE_QUEUE_PAGE_SIZE },
    }),
  );
  const entries = Option.getOrNull(AsyncResult.value(log))?.entries ?? null;
  const rows =
    entries === null
      ? squireRecentFromSnapshot(props.recentActivity)
      : squireRecentEntries(entries);
  const cards = Option.getOrNull(AsyncResult.value(queue))?.items ?? [];
  const cardTitle = (row: SquireRecentEntry) =>
    row.cardId === null ? null : (cards.find((card) => card.id === row.cardId)?.title ?? null);
  return (
    <section
      aria-label="Recent"
      className="flex w-full flex-col gap-1.5 border-t border-border pt-4"
    >
      <h3 className="text-xs font-medium text-muted-foreground">Recent</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <SquireRecentRow
              key={row.key}
              environmentId={environmentId}
              row={row}
              cardTitle={cardTitle(row)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SquireRecentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: SquireRecentEntry;
  readonly cardTitle: string | null;
}) {
  const { row } = props;
  const shell = useQuietThreadShell(
    row.threadId === null ? null : { environmentId: props.environmentId, threadId: row.threadId },
  );
  const label =
    squireRecentLabel(row, { threadTitle: shell?.title ?? null, cardTitle: props.cardTitle }) ?? "";
  const age = useActivityAge(row.at);
  return (
    <li className="flex items-baseline justify-between gap-3 text-sm">
      <span className="min-w-0 truncate">{squireRecentRowText(label, row.count)}</span>
      {age === null ? null : (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{age}</span>
      )}
    </li>
  );
}
