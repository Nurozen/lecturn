import { useAtomValue } from "@effect/atom-react";
import { staveRpcErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, StaveOperation, StaveSagaMembership } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { staveDryRun, staveSpaceStatusRead } from "../../state/stave";
import { staveOperations } from "../../state/staveOperations";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { StaveOperationProgress } from "./StaveOperationProgressBody";
import {
  canForceStaveOperation,
  forceStaveOperation,
  staveOperationLossCopy,
  staveRefusalCode,
} from "./staveConfirm.logic";

type Preview = { key: string; plan?: readonly string[]; error?: string; code?: string | undefined };

/** A confirmation is bound to the exact payload whose dry run is displayed. */
export function StaveConfirmDialog({
  environmentId,
  operation: initial,
  title,
  onClose,
  onFinished,
  membershipWorkspaceRoot,
}: {
  environmentId: EnvironmentId;
  operation: StaveOperation;
  title: string;
  onClose: () => void;
  onFinished: () => void;
  membershipWorkspaceRoot?: string | undefined;
}) {
  const [forced, setForced] = useState(false);
  const [sagaConfirmed, setSagaConfirmed] = useState(false);
  const [membership, setMembership] = useState<StaveSagaMembership | null>(null);
  const [memory, setMemory] = useState<"keep" | "contribute" | "destroy">(
    "memory" in initial && typeof initial.memory === "string" ? initial.memory : "keep",
  );
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [operationId, setOperationId] = useState(randomUUID);
  const [started, setStarted] = useState(false);
  const operation = useMemo((): StaveOperation => {
    let next = initial;
    if ((next.kind === "destroySpace" || next.kind === "removePartialSpace") && sagaConfirmed)
      next = { ...next, sagaRemoveConfirmed: true };
    if (next.kind === "destroySpace" || next.kind === "sagaDestroy") next = { ...next, memory };
    if (next.kind === "archiveSpace" || next.kind === "sagaArchive") {
      next = { ...next, memory: memory === "destroy" ? "keep" : memory };
    }
    return forced ? forceStaveOperation(next) : next;
  }, [initial, memory, forced, sagaConfirmed]);
  const key = JSON.stringify([environmentId, operation, attempt]);
  const state = useAtomValue(staveOperations.stateAtom(operationId));
  const dryRun = useAtomCommand(staveDryRun, { reportFailure: false });
  const run = useAtomCommand(staveOperations.run, { reportFailure: false });
  const readStatus = useAtomCommand(staveSpaceStatusRead, { reportFailure: false });
  const notified = useRef<string | null>(null);

  useEffect(() => {
    let stale = false;
    if (started) return;
    void dryRun({ environmentId, input: { operation } }).then((result) => {
      if (stale) return;
      if (result._tag === "Success") setPreview({ key, plan: result.value.plan });
      else {
        const error = squashAtomCommandFailure(result);
        setPreview({
          key,
          error:
            staveRpcErrorMessage(error) ??
            (error instanceof Error ? error.message : "The dry run failed."),
          code: staveRefusalCode(error),
        });
      }
    });
    return () => {
      stale = true;
    };
  }, [environmentId, operation, key, dryRun, started]);

  useEffect(() => {
    if (state.status === "finished" && notified.current !== operationId) {
      notified.current = operationId;
      onFinished();
    }
  }, [state.status, operationId, onFinished]);

  const currentPreview = preview?.key === key ? preview : null;
  const busy =
    started &&
    (state.status === "idle" || state.status === "running" || state.status === "disconnected");
  const refusal = started ? state.error?.code : currentPreview?.code;
  useEffect(() => {
    let stale = false;
    const workspaceRoot =
      initial.kind === "destroySpace" ? initial.workspaceRoot : membershipWorkspaceRoot;
    if (refusal !== "saga_member" || workspaceRoot === undefined) return;
    void readStatus({ environmentId, input: { workspaceRoot } }).then((result) => {
      if (!stale && result._tag === "Success" && !result.value.membershipUnknown) {
        setMembership(result.value.sagaMembership ?? null);
      }
    });
    return () => {
      stale = true;
    };
  }, [environmentId, initial, readStatus, refusal, attempt, membershipWorkspaceRoot]);
  const forceAvailable = canForceStaveOperation(operation, refusal);
  const changesMemory =
    operation.kind === "destroySpace" ||
    operation.kind === "sagaDestroy" ||
    operation.kind === "archiveSpace" ||
    operation.kind === "sagaArchive";
  const canDestroyMemory = operation.kind === "destroySpace" || operation.kind === "sagaDestroy";

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogPopup className="max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{staveOperationLossCopy(operation)}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-6 pb-6">
          {changesMemory && !started ? (
            <Label className="flex items-center justify-between gap-3">
              Memory fate
              <Select
                value={memory}
                onValueChange={(value) => {
                  if (
                    value === "keep" ||
                    value === "contribute" ||
                    (value === "destroy" && canDestroyMemory)
                  )
                    setMemory(value);
                }}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="keep">Keep</SelectItem>
                  <SelectItem value="contribute">Contribute and keep</SelectItem>
                  {canDestroyMemory ? (
                    <SelectItem value="destroy">Destroy owned memory</SelectItem>
                  ) : null}
                </SelectPopup>
              </Select>
            </Label>
          ) : null}
          {memory === "destroy" && changesMemory ? (
            <p className="text-sm text-destructive-foreground">
              Owned memory stores will be permanently destroyed.
            </p>
          ) : null}
          {operation.kind === "removePartialSpace" ? (
            <p className="text-sm text-destructive-foreground">
              Owned memory created for this partial space will be destroyed. Stores owned elsewhere
              are kept.
            </p>
          ) : null}
          {forced ? (
            <p className="text-sm font-medium text-destructive-foreground">
              Force may discard uncommitted changes and affect dependent spaces. Memory-in-use
              guards still apply.
            </p>
          ) : null}
          {membership && (refusal === "saga_member" || sagaConfirmed) ? (
            <p className="text-sm text-destructive-foreground">
              This space belongs to saga {membership.sagaId}. Removing it also drops{" "}
              {membership.dependentEdges.length} dependent ordering edges. If destruction fails, use
              the reported edges to repair membership manually.
            </p>
          ) : null}
          {!started ? (
            currentPreview === null ? (
              <p className="text-sm text-muted-foreground">Preparing the dry-run plan…</p>
            ) : currentPreview.error ? (
              <p role="alert" className="whitespace-pre-wrap text-sm text-destructive-foreground">
                {currentPreview.error}
              </p>
            ) : (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/35 p-3 text-xs">
                {currentPreview.plan?.join("\n") || "Stave reported no planned changes."}
              </pre>
            )
          ) : (
            <StaveOperationProgress environmentId={environmentId} operationId={operationId} />
          )}
        </div>
        <AlertDialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {state.status === "finished" ? "Done" : "Cancel"}
          </Button>
          {forceAvailable ? (
            <Button
              variant="destructive-outline"
              onClick={() => {
                setForced(true);
                setStarted(false);
                setOperationId(randomUUID());
              }}
            >
              Review forced operation
            </Button>
          ) : null}
          {refusal === "saga_member" && membership && !sagaConfirmed ? (
            <Button
              variant="destructive-outline"
              onClick={() => {
                setSagaConfirmed(true);
                setStarted(false);
                setOperationId(randomUUID());
              }}
            >
              Review removal from saga and destroy
            </Button>
          ) : null}
          {!started && currentPreview?.error ? (
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              Retry dry run
            </Button>
          ) : null}
          {!started ? (
            <Button
              variant="destructive"
              disabled={currentPreview?.plan === undefined}
              onClick={() => {
                setStarted(true);
                void run({ environmentId, operationId, operation });
              }}
            >
              {forced ? "Confirm force" : "Confirm"}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
