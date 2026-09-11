import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import type { EnvironmentId, StaveCreateSpaceOperation } from "@lecturn/contracts";
import { useEffect, useState } from "react";

import { staveDryRun } from "../../../state/stave";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { reviewCommandLines } from "../staveSpaceWizard.logic";

type DryRunResult =
  | { readonly status: "ok"; readonly plan: ReadonlyArray<string> }
  | { readonly status: "failed"; readonly message: string };

type DryRunView = DryRunResult | { readonly status: "pending" };

function describeFailure(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The dry run failed.";
}

/**
 * `stave ... --dry-run` for `operation`, re-run whenever it changes or on
 * retry. The settled result remembers which request it answers, so a stale
 * answer reads as pending instead of being cleared in an effect.
 */
function useDryRun(environmentId: EnvironmentId, operation: StaveCreateSpaceOperation) {
  const dryRun = useAtomCommand(staveDryRun, { reportFailure: false });
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{
    readonly operation: StaveCreateSpaceOperation;
    readonly attempt: number;
    readonly result: DryRunResult;
  } | null>(null);

  useEffect(() => {
    let stale = false;
    void dryRun({ environmentId, input: { operation } }).then((result) => {
      if (stale) return;
      setSettled({
        operation,
        attempt,
        result:
          result._tag === "Success"
            ? { status: "ok", plan: result.value.plan }
            : { status: "failed", message: describeFailure(squashAtomCommandFailure(result)) },
      });
    });
    return () => {
      stale = true;
    };
  }, [attempt, dryRun, environmentId, operation]);

  const view: DryRunView =
    settled !== null && settled.operation === operation && settled.attempt === attempt
      ? settled.result
      : { status: "pending" };
  return { view, retry: () => setAttempt((count) => count + 1) };
}

/** The command Lecturn will run and Stave's dry-run plan for it. */
export function ReviewStep(props: {
  readonly environmentId: EnvironmentId;
  readonly operation: StaveCreateSpaceOperation;
  readonly onDryRunPendingChange: (pending: boolean) => void;
}) {
  const { environmentId, operation, onDryRunPendingChange } = props;
  const { view, retry } = useDryRun(environmentId, operation);
  const pending = view.status === "pending";
  useEffect(() => {
    onDryRunPendingChange(pending);
  }, [onDryRunPendingChange, pending]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">Command</p>
        <div className="rounded-lg border border-border/70 bg-muted/35 p-2.5">
          {reviewCommandLines(operation).map((line) => (
            <code key={line} className="block break-all font-mono text-xs">
              {line}
            </code>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Plan</p>
          {view.status === "failed" ? (
            <Button size="xs" variant="outline" onClick={retry}>
              Retry
            </Button>
          ) : null}
        </div>
        {view.status === "pending" ? (
          <p className="text-xs text-muted-foreground">Running dry run…</p>
        ) : view.status === "failed" ? (
          <p className="text-xs text-destructive-foreground">{view.message}</p>
        ) : view.plan.length === 0 ? (
          <p className="text-xs text-muted-foreground">Stave reported an empty plan.</p>
        ) : (
          <pre className="max-h-64 overflow-auto rounded-lg border border-border/70 bg-muted/35 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {view.plan.join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}
