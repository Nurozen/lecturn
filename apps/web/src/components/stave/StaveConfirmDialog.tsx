import { useAtomValue } from "@effect/atom-react";
import { staveRpcErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  StaveOperation,
  StaveSagaMembership,
  StaveSagaReview,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { notifyStaveMutation } from "../../staveMutation";
import { staveSagaReviewLines } from "../../lib/staveProjectDeletion.logic";
import { randomUUID } from "../../lib/utils";
import { staveOperationUnavailableReason } from "./staveCompatibility.logic";
import { staveDryRun, staveSpaceStatusRead, useStaveStatus } from "../../state/stave";
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
  bindStaveSagaReview,
  canForceStaveOperation,
  forceStaveOperation,
  staveOperationLossCopy,
  staveRefusalCode,
} from "./staveConfirm.logic";

type Preview = {
  key: string;
  plan?: readonly string[];
  sagaReview?: StaveSagaReview | undefined;
  error?: string;
  code?: string | undefined;
};

/** A confirmation is bound to the exact payload whose dry run is displayed. */
export function StaveConfirmDialog({
  environmentId,
  operation: initial,
  title,
  onClose,
  onFinished,
  membershipWorkspaceRoot,
  lifecycleIsSaga,
}: {
  environmentId: EnvironmentId;
  operation: StaveOperation;
  title: string;
  onClose: () => void;
  onFinished: () => void;
  membershipWorkspaceRoot?: string | undefined;
  lifecycleIsSaga?: boolean | undefined;
}) {
  const [forced, setForced] = useState("force" in initial && initial.force);
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
    if (
      (next.kind === "destroySpace" ||
        next.kind === "removePartialSpace" ||
        (next.kind === "lifecycleAction" &&
          next.action === "retry" &&
          next.target === "destroy")) &&
      sagaConfirmed
    )
      next = { ...next, sagaRemoveConfirmed: true };
    if (next.kind === "destroySpace" || next.kind === "sagaDestroy") next = { ...next, memory };
    if (next.kind === "archiveSpace" || next.kind === "sagaArchive") {
      next = { ...next, memory: memory === "destroy" ? "keep" : memory };
    }
    if (
      next.kind === "lifecycleAction" &&
      (next.action === "retry" || next.action === "archiveNow")
    ) {
      next = {
        ...next,
        memory:
          next.action === "archiveNow" || next.target === "archive"
            ? memory === "destroy"
              ? "keep"
              : memory
            : memory,
      };
    }
    return forced ? forceStaveOperation(next) : next;
  }, [initial, memory, forced, sagaConfirmed]);
  const status = useStaveStatus(environmentId);
  const unavailableReason = staveOperationUnavailableReason(
    status.data,
    operation,
    lifecycleIsSaga,
  );
  const key = JSON.stringify([environmentId, operation, attempt, unavailableReason]);
  const state = useAtomValue(staveOperations.stateAtom(operationId));
  const dryRun = useAtomCommand(staveDryRun, { reportFailure: false });
  const run = useAtomCommand(staveOperations.run, { reportFailure: false });
  const readStatus = useAtomCommand(staveSpaceStatusRead, { reportFailure: false });
  const notified = useRef<string | null>(null);

  useEffect(() => {
    let stale = false;
    if (started) return;
    if (unavailableReason) return;
    void dryRun({ environmentId, input: { operation } }).then((result) => {
      if (stale) return;
      if (result._tag === "Success")
        setPreview({ key, plan: result.value.plan, sagaReview: result.value.sagaReview });
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
  }, [environmentId, operation, key, dryRun, started, unavailableReason]);

  useEffect(() => {
    if (
      (state.status === "finished" || state.status === "failed") &&
      notified.current !== operationId
    ) {
      notified.current = operationId;
      notifyStaveMutation(environmentId);
      if (state.status === "finished") onFinished();
    }
  }, [state.status, operationId, onFinished, environmentId]);

  const currentPreview = unavailableReason
    ? { key, error: unavailableReason }
    : preview?.key === key
      ? preview
      : null;
  const reviewedOperation = bindStaveSagaReview(
    operation,
    currentPreview?.sagaReview,
    lifecycleIsSaga,
  );
  const busy =
    started &&
    (state.status === "idle" || state.status === "running" || state.status === "disconnected");
  const refusal = started ? state.error?.code : currentPreview?.code;
  useEffect(() => {
    let stale = false;
    const workspaceRoot =
      initial.kind === "destroySpace" || initial.kind === "lifecycleAction"
        ? initial.workspaceRoot
        : membershipWorkspaceRoot;
    const destroys =
      initial.kind === "destroySpace" ||
      initial.kind === "removePartialSpace" ||
      (initial.kind === "lifecycleAction" &&
        initial.action === "retry" &&
        initial.target === "destroy");
    if (!destroys || refusal !== "saga_member" || workspaceRoot === undefined) return;
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
    operation.kind === "sagaArchive" ||
    (operation.kind === "lifecycleAction" &&
      (operation.action === "retry" || operation.action === "archiveNow"));
  const canDestroyMemory =
    operation.kind === "destroySpace" ||
    operation.kind === "sagaDestroy" ||
    (operation.kind === "lifecycleAction" &&
      operation.action === "retry" &&
      operation.target === "destroy");

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
          {!started && currentPreview?.sagaReview ? (
            <div className="whitespace-pre-wrap text-sm">
              {staveSagaReviewLines(currentPreview.sagaReview).join("\n")}
            </div>
          ) : null}
          {!started && currentPreview?.plan && reviewedOperation === null ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              A matching saga review is required. Refresh the plan before confirming.
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
              variant={
                operation.kind === "lifecycleAction" &&
                (operation.action === "keep" || operation.action === "dismiss")
                  ? "default"
                  : "destructive"
              }
              disabled={
                currentPreview?.plan === undefined ||
                unavailableReason !== null ||
                reviewedOperation === null
              }
              onClick={() => {
                if (!reviewedOperation) return;
                setStarted(true);
                void run({ environmentId, operationId, operation: reviewedOperation });
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
