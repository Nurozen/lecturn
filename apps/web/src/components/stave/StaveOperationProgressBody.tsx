import { useAtomValue } from "@effect/atom-react";
import type {
  StaveOperationOutputLine,
  StaveOperationPhaseState,
} from "@t3tools/client-runtime/state/stave-operation";
import type { EnvironmentId, StaveOperationError } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { staveOperations } from "../../state/staveOperations";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { GoldThreadSpinner } from "../ui/gold-thread-spinner";
import {
  describeOperationError,
  formatPhaseDuration,
  outputRuns,
  overallStatusLabel,
  phaseStatus,
  truncatedNotice,
  type StavePhaseStatus,
} from "./staveOperationProgress.logic";

interface StaveOperationProgressProps {
  readonly environmentId: EnvironmentId;
  readonly operationId: string;
  /** The space a `createSpace` is making; enables the "Remove partial space" recovery on failure. */
  readonly spaceId?: string;
  /** Nested rendering (the removal under a failed create): tighter, no status heading. */
  readonly compact?: boolean;
}

/**
 * Live view of one streamed Stave operation: every phase with its command
 * line, retained output and duration, plus the recovery controls for a stream
 * that dropped (reattach) or a create that failed (remove the partial space).
 */
export function StaveOperationProgress({
  environmentId,
  operationId,
  compact = false,
}: StaveOperationProgressProps) {
  const state = useAtomValue(staveOperations.stateAtom(operationId));
  const reattach = useAtomCommand(staveOperations.reattach, { reportFailure: false });
  const notice = truncatedNotice(state);

  return (
    <div className={cn("flex flex-col", compact ? "gap-2" : "gap-3")}>
      {compact ? null : (
        <p
          aria-live="polite"
          className="flex items-center gap-3 text-sm font-medium text-foreground"
        >
          {state.status === "running" ? <GoldThreadSpinner /> : null}
          {overallStatusLabel(state)}
        </p>
      )}
      {notice === null ? null : <p className="text-xs text-muted-foreground">{notice}</p>}
      {state.phases.length > 0 ? (
        <ol className={cn("flex flex-col", compact ? "gap-2" : "gap-3")}>
          {state.phases.map((phase, index) => (
            <PhaseRow
              key={`${phase.phase}:${phase.startedAt}`}
              phase={phase}
              status={phaseStatus(phase, index, state)}
              compact={compact}
            />
          ))}
        </ol>
      ) : null}
      {state.status === "disconnected" ? (
        <Alert variant="warning">
          <AlertTitle>Connection lost</AlertTitle>
          <AlertDescription>
            <span>
              {state.disconnectReason ?? "The operation stream ended before it finished."}
            </span>
            <div>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void reattach({ environmentId, operationId });
                }}
              >
                Reattach
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {state.status === "failed" && state.error !== undefined ? (
        <FailureBlock error={state.error} />
      ) : null}
    </div>
  );
}

const PHASE_BADGE: Record<
  StavePhaseStatus,
  { readonly label: string; readonly variant: "info" | "success" | "error" | "warning" }
> = {
  running: { label: "running", variant: "info" },
  done: { label: "done", variant: "success" },
  failed: { label: "failed", variant: "error" },
  interrupted: { label: "interrupted", variant: "warning" },
};

function PhaseRow({
  phase,
  status,
  compact,
}: {
  readonly phase: StaveOperationPhaseState;
  readonly status: StavePhaseStatus;
  readonly compact: boolean;
}) {
  const badge = PHASE_BADGE[status];
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge size="sm" variant={badge.variant}>
          {badge.label}
        </Badge>
        <span className="font-medium text-foreground">{phase.phase}</span>
        {phase.durationMs === undefined ? null : (
          <span className="tabular-nums text-xs text-muted-foreground">
            {formatPhaseDuration(phase.durationMs)}
          </span>
        )}
      </div>
      {phase.commandLine === undefined ? null : (
        <code className="block truncate font-mono text-xs text-muted-foreground">
          {phase.commandLine}
        </code>
      )}
      {phase.lines.length > 0 ? <OutputBlock lines={phase.lines} compact={compact} /> : null}
    </li>
  );
}

const STREAM_CLASS: Record<StaveOperationOutputLine["stream"], string> = {
  stdout: "text-foreground",
  stderr: "text-destructive-foreground",
  notes: "italic text-muted-foreground",
  plan: "text-info-foreground",
};

function OutputBlock({
  lines,
  compact,
}: {
  readonly lines: ReadonlyArray<StaveOperationOutputLine>;
  readonly compact: boolean;
}) {
  return (
    <pre
      className={cn(
        "overflow-auto rounded-md border border-border/70 bg-muted/35 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap",
        compact ? "max-h-40" : "max-h-64",
      )}
    >
      {outputRuns(lines).map((run) => (
        <span
          key={`${run.startLine}:${run.stream}`}
          className={cn("block", STREAM_CLASS[run.stream])}
        >
          {run.text}
        </span>
      ))}
    </pre>
  );
}

function FailureBlock({ error }: { readonly error: StaveOperationError }) {
  const description = describeOperationError(error);
  return (
    <div className="flex flex-col gap-2">
      <Alert variant="error" controlAlignment="first-line">
        <AlertTitle>{description.title}</AlertTitle>
        <AlertDescription>
          <span className="whitespace-pre-wrap">{description.detail}</span>
        </AlertDescription>
      </Alert>
    </div>
  );
}
