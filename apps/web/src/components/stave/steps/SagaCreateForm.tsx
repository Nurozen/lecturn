import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { openExistingProjectAndThread } from "../../../lib/addProject";
import { notifyStaveMutation } from "../../../staveMutation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { staveDryRun } from "../../../state/stave";
import { randomUUID } from "../../../lib/utils";
import { staveOperations } from "../../../state/staveOperations";
import { useAtomCommand } from "../../../state/use-atom-command";
import { closeStaveWizard } from "../../../staveWizard";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Textarea } from "../../ui/textarea";
import {
  buildCreateSagaOperation,
  createInitialSagaWizardState,
  type StaveSagaWizardState,
  syncRepoRows,
  toggleMemoryEntry,
  validateSagaWizard,
  validateSpaceId,
} from "../staveSpaceWizard.logic";
import { StaveOperationProgress } from "../StaveOperationProgress";
import { useStaveWizardData } from "../useStaveWizardData";
import { MemoryStep } from "./MemoryStep";

/** No operation started yet: the placeholder atom stays `idle`. */
const IDLE_OPERATION_ID = "stave-saga-form:idle";

/**
 * The `kind: "saga"` wizard: one form for `stave saga create` (id, title,
 * spec, reference repos, memory) followed by the operation's progress.
 */
export function SagaCreateForm(props: {
  readonly environmentId: EnvironmentId;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const { environmentId, onBusyChange } = props;
  const data = useStaveWizardData(environmentId);
  const { context } = data;
  const [state, setState] = useState<StaveSagaWizardState>(() =>
    createInitialSagaWizardState(context.repos),
  );
  const [operationId, setOperationId] = useState<string | null>(null);
  const runOperation = useAtomCommand(staveOperations.run, { reportFailure: false });
  const operation = useAtomValue(staveOperations.stateAtom(operationId ?? IDLE_OPERATION_ID));
  const running =
    operationId !== null && operation.status !== "finished" && operation.status !== "failed";
  const terminal = operation.status === "finished" || operation.status === "failed";
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const opened = useRef(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const result = operation.status === "finished" ? operation.result : undefined;
  useEffect(() => {
    if (result?.kind !== "createSaga" || opened.current) return;
    opened.current = true;
    notifyStaveMutation(environmentId);
    void openExistingProjectAndThread({
      environmentId,
      projectId: result.result.projectId,
      sequence: result.result.sequence,
      navigate,
      handleNewThread,
    }).then((outcome) => {
      if (outcome.status === "failed") {
        setOpenError(
          outcome.error instanceof Error ? outcome.error.message : "Opening the saga failed.",
        );
      } else closeStaveWizard();
    });
  }, [environmentId, result, navigate, handleNewThread]);

  useEffect(() => {
    onBusyChange(running);
    return () => onBusyChange(false);
  }, [onBusyChange, running]);

  // Reference rows follow the registry, adjusted in render when it changes.
  const [seenRepos, setSeenRepos] = useState(context.repos);
  if (seenRepos !== context.repos) {
    setSeenRepos(context.repos);
    setState((current) => ({
      ...current,
      references: syncRepoRows(current.references, context.repos),
    }));
  }

  const dryRun = useAtomCommand(staveDryRun, { reportFailure: false });
  const payload = useMemo(() => buildCreateSagaOperation(state), [state]);
  const payloadKey = JSON.stringify([environmentId, payload]);
  const [preview, setPreview] = useState<{
    key: string;
    plan?: readonly string[];
    error?: string;
  } | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const currentPreview = preview?.key === payloadKey ? preview : null;
  const gate = validateSagaWizard(state, context.spaces);
  const id = validateSpaceId(state.sagaId, context.spaces);
  const idMessage = state.sagaId.length > 0 && !id.ok ? id.message : undefined;

  const create = () => {
    if (!gate.ok || operationId !== null || previewPending) return;
    if (!currentPreview?.plan) {
      setPreviewPending(true);
      void dryRun({ environmentId, input: { operation: payload } }).then((result) => {
        if (result._tag === "Success") setPreview({ key: payloadKey, plan: result.value.plan });
        else {
          const error = squashAtomCommandFailure(result);
          setPreview({
            key: payloadKey,
            error: error instanceof Error ? error.message : "Could not preview saga creation.",
          });
        }
        setPreviewPending(false);
      });
      return;
    }
    const nextId = randomUUID();
    setOperationId(nextId);
    void runOperation({
      environmentId,
      operationId: nextId,
      operation: payload,
    });
  };

  return (
    <div
      className="contents"
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        event.preventDefault();
        create();
      }}
    >
      <DialogHeader>
        <DialogTitle>New Stave saga</DialogTitle>
        <DialogDescription>
          A saga groups spaces that land in order. Members join it from the space wizard.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {operationId !== null ? (
          <div className="flex flex-col gap-3">
            <StaveOperationProgress
              environmentId={environmentId}
              operationId={operationId}
              spaceId={state.sagaId.trim()}
            />
            {openError ? (
              <Alert variant="error">
                <AlertTitle>Could not open saga</AlertTitle>
                <AlertDescription>{openError}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {data.error !== null ? (
              <Alert variant="error">
                <AlertTitle>Could not read the Stave registry</AlertTitle>
                <AlertDescription>{data.error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stave-saga-id">Saga id</Label>
              <Input
                id="stave-saga-id"
                autoFocus
                size="sm"
                value={state.sagaId}
                placeholder="my-saga"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={idMessage === undefined ? undefined : true}
                onChange={(event) => setState({ ...state, sagaId: event.target.value })}
              />
              {idMessage !== undefined ? (
                <p className="text-xs text-destructive-foreground">{idMessage}</p>
              ) : id.warning !== undefined ? (
                <p className="text-xs text-muted-foreground">{id.warning}</p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stave-saga-title">Title</Label>
              <Input
                id="stave-saga-title"
                size="sm"
                value={state.title}
                placeholder={
                  state.sagaId.trim().length > 0 ? state.sagaId.trim() : "defaults to id"
                }
                onChange={(event) => setState({ ...state, title: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stave-saga-spec">Spec</Label>
              <Textarea
                id="stave-saga-spec"
                size="sm"
                rows={4}
                value={state.specText}
                placeholder="What the saga delivers as a whole."
                onChange={(event) => setState({ ...state, specText: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium">References</p>
              {state.references.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {data.isPending ? "Loading registry…" : "No repos are registered with Stave yet."}
                </p>
              ) : (
                state.references.map((row) => (
                  <div key={row.repo} className="flex flex-wrap items-center gap-2">
                    <Label className="min-w-40 gap-1.5 font-normal">
                      <Checkbox
                        checked={row.mode === "reference"}
                        onCheckedChange={(checked) =>
                          setState({
                            ...state,
                            references: state.references.map((entry) =>
                              entry.repo === row.repo
                                ? { ...entry, mode: checked === true ? "reference" : "none" }
                                : entry,
                            ),
                          })
                        }
                      />
                      {row.repo}
                    </Label>
                    {row.mode === "reference" ? (
                      <Input
                        size="sm"
                        className="min-w-40 flex-1 font-mono"
                        value={row.ref}
                        placeholder="pin to a ref"
                        spellCheck={false}
                        aria-label={`${row.repo} reference`}
                        onChange={(event) =>
                          setState({
                            ...state,
                            references: state.references.map((entry) =>
                              entry.repo === row.repo
                                ? { ...entry, ref: event.target.value }
                                : entry,
                            ),
                          })
                        }
                      />
                    ) : null}
                  </div>
                ))
              )}
            </div>
            {context.memoryAvailable ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-sm font-medium">Memory</p>
                <MemoryStep
                  memory={state.memory}
                  context={context}
                  onToggle={(spec) =>
                    setState({ ...state, memory: toggleMemoryEntry(state.memory, spec) })
                  }
                />
              </div>
            ) : null}
          </div>
        )}
        {operationId === null && currentPreview?.plan ? (
          <div className="mt-4 rounded-lg border p-3">
            <p className="mb-2 text-sm font-medium">Creation plan</p>
            <ol className="list-decimal space-y-1 pl-5 text-xs">
              {currentPreview.plan.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        ) : null}
        {operationId === null && currentPreview?.error ? (
          <p className="mt-3 text-xs text-destructive-foreground">{currentPreview.error}</p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {operationId === null ? (
          <>
            {!gate.ok && state.sagaId.length > 0 ? (
              <p className="self-center text-xs text-muted-foreground sm:me-auto">{gate.message}</p>
            ) : null}
            <Button variant="outline" onClick={closeStaveWizard}>
              Cancel
            </Button>
            <Button disabled={!gate.ok || previewPending} onClick={create}>
              {previewPending
                ? "Reading plan…"
                : currentPreview?.plan
                  ? "Create saga"
                  : "Review plan"}
            </Button>
          </>
        ) : terminal ? (
          <Button variant="outline" onClick={closeStaveWizard}>
            Close
          </Button>
        ) : (
          <Button disabled>Creating…</Button>
        )}
      </DialogFooter>
    </div>
  );
}
