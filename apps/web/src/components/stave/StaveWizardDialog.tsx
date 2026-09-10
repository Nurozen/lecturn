import { useStaveStatus } from "../../state/stave";
import { staveOperationUnavailableReason } from "./staveCompatibility.logic";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { notifyStaveMutation } from "../../staveMutation";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { openExistingProjectAndThread } from "../../lib/addProject";
import { cn, randomUUID } from "../../lib/utils";
import { staveOperations } from "../../state/staveOperations";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  closeStaveWizard,
  readStaveWizardState,
  type StaveWizardRequest,
  subscribeStaveWizard,
} from "../../staveWizard";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  buildCreateSpaceOperation,
  canAdvance,
  createInitialWizardState,
  nextWizardStep,
  preselectSaga,
  previousWizardStep,
  STAVE_WIZARD_STEP_LABELS,
  syncRepoRows,
  toggleMemorySpec,
  updateWizardState,
  wizardSteps,
} from "./staveSpaceWizard.logic";
import { StaveOperationProgress } from "./StaveOperationProgress";
import { IdentityStep } from "./steps/IdentityStep";
import { MemoryStep } from "./steps/MemoryStep";
import { ReposStep } from "./steps/ReposStep";
import { ReviewStep } from "./steps/ReviewStep";
import { SagaCreateForm } from "./steps/SagaCreateForm";
import { SagaStep } from "./steps/SagaStep";
import { useStaveWizardData } from "./useStaveWizardData";

/** No create started yet: the placeholder atom stays `idle`. */
const IDLE_OPERATION_ID = "stave-space-wizard:idle";

/** Controls whose Enter is their own click, never the wizard's "Next". */
const ENTER_OWNED_SELECTOR =
  "textarea, button, a, [role='button'], [role='checkbox'], [role='switch'], [role='combobox'], [role='option']";

function describeFailure(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Opening the new project failed.";
}

/**
 * Host for the Stave wizard, mounted once in `__root.tsx` and driven by the
 * `staveWizard` bus. Each request gets a fresh inner component; the dialog
 * refuses to close while a create is running so the operation stays observed.
 */
export function StaveWizardDialog() {
  const wizard = useSyncExternalStore(
    subscribeStaveWizard,
    readStaveWizardState,
    readStaveWizardState,
  );
  const request = wizard.status === "open" ? wizard.request : null;
  // The last request survives the close animation; a new one remounts the content.
  const [tracked, setTracked] = useState<{
    readonly request: StaveWizardRequest | null;
    readonly key: number;
  }>({ request: null, key: 0 });
  if (request !== null && tracked.request !== request) {
    setTracked({ request, key: tracked.key + 1 });
  }
  const [busy, setBusy] = useState(false);
  const shown = request ?? tracked.request;
  const compatibility = useStaveStatus(shown?.environmentId ?? null);
  const unavailableReason =
    shown === null
      ? null
      : staveOperationUnavailableReason(
          compatibility.data,
          shown.kind === "saga" ? "createSaga" : "createSpace",
        );

  return (
    <Dialog
      open={wizard.status === "open"}
      onOpenChange={(open) => {
        if (open || busy) return;
        closeStaveWizard();
      }}
    >
      <DialogPopup className="max-w-2xl" showCloseButton={!busy}>
        {shown === null ? null : unavailableReason && !busy ? (
          <>
            <DialogHeader>
              <DialogTitle>Stave action unavailable</DialogTitle>
              <DialogDescription>{unavailableReason}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={closeStaveWizard}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : shown.kind === "saga" ? (
          <SagaCreateForm
            key={tracked.key}
            environmentId={shown.environmentId}
            onBusyChange={setBusy}
          />
        ) : (
          <SpaceWizard
            key={tracked.key}
            environmentId={shown.environmentId}
            request={shown}
            onBusyChange={setBusy}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function SpaceWizard(props: {
  readonly environmentId: EnvironmentId;
  readonly request: StaveWizardRequest;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const { environmentId, request, onBusyChange } = props;
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const data = useStaveWizardData(environmentId);
  const { context } = data;
  const [state, setState] = useState(createInitialWizardState);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [dryRunPending, setDryRunPending] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const runOperation = useAtomCommand(staveOperations.run, { reportFailure: false });
  const operationState = useAtomValue(staveOperations.stateAtom(operationId ?? IDLE_OPERATION_ID));
  const running = operationState.status === "running" || operationState.status === "disconnected";
  const terminal = operationState.status === "finished" || operationState.status === "failed";

  useEffect(() => {
    onBusyChange(running);
    return () => onBusyChange(false);
  }, [onBusyChange, running]);

  // Registry rows follow the registry (an inline register adds a row) and the
  // launch request's saga is applied once the saga list arrives; both adjust
  // the wizard state in render, when the context they derive from changes.
  const [seenRepos, setSeenRepos] = useState(context.repos);
  if (seenRepos !== context.repos) {
    setSeenRepos(context.repos);
    setState((current) =>
      updateWizardState(current, { repos: syncRepoRows(current.repos, context.repos) }),
    );
  }
  const sagaRoot = request.saga?.root;
  const [seenSagas, setSeenSagas] = useState(context.sagas);
  if (seenSagas !== context.sagas) {
    setSeenSagas(context.sagas);
    setState((current) => preselectSaga(current, context.sagas, sagaRoot));
  }

  const operation = useMemo(() => buildCreateSpaceOperation(state), [state]);
  const steps = wizardSteps(context);
  const gate = canAdvance(state, context);
  const previous = previousWizardStep(state.step, context);
  const next = nextWizardStep(state.step, context);
  const stepIndex = steps.indexOf(state.step);

  const goBack = () => {
    if (previous === null) return;
    setState((current) => updateWizardState(current, { step: previous }));
  };
  const goNext = () => {
    if (!gate.ok || next === null || next === "progress") return;
    setState((current) => updateWizardState(current, { step: next }));
  };
  const create = () => {
    if (state.step !== "review" || dryRunPending || operationId !== null) return;
    const id = randomUUID();
    setOperationId(id);
    setState((current) => updateWizardState(current, { step: "progress" }));
    void runOperation({ environmentId, operationId: id, operation });
  };

  // Open the project the server created, once, then dismiss the wizard.
  const openedRef = useRef(false);
  const result = operationState.status === "finished" ? operationState.result : undefined;
  useEffect(() => {
    if (result === undefined || result.kind !== "createSpace" || openedRef.current) return;
    openedRef.current = true;
    notifyStaveMutation(environmentId);
    void openExistingProjectAndThread({
      environmentId,
      projectId: result.result.projectId,
      sequence: result.result.sequence,
      navigate,
      handleNewThread,
    }).then((outcome) => {
      if (outcome.status === "failed") {
        setOpenError(describeFailure(outcome.error));
        return;
      }
      closeStaveWizard();
    });
  }, [environmentId, handleNewThread, navigate, result]);

  return (
    <div
      className="contents"
      onKeyDown={(event) => {
        if (
          event.key !== "Enter" ||
          event.nativeEvent.isComposing ||
          event.shiftKey ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        ) {
          return;
        }
        const target = event.target;
        if (!(target instanceof HTMLElement) || target.closest(ENTER_OWNED_SELECTOR) !== null) {
          return;
        }
        if (state.step === "review") {
          event.preventDefault();
          create();
        } else if (gate.ok && state.step !== "progress") {
          event.preventDefault();
          goNext();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>New Stave space</DialogTitle>
        <DialogDescription>
          Worktrees for the repos you pick, a spec and memory, grouped under one Lecturn project.
        </DialogDescription>
        <ol aria-label="Steps" className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
          {steps.map((step, index) => (
            <li
              key={step}
              aria-current={step === state.step ? "step" : undefined}
              className={cn(
                "rounded-md px-2 py-0.5 tabular-nums",
                step === state.step
                  ? "bg-primary text-primary-foreground"
                  : index < stepIndex
                    ? "text-foreground"
                    : "text-muted-foreground",
              )}
            >
              {index + 1}. {STAVE_WIZARD_STEP_LABELS[step]}
            </li>
          ))}
        </ol>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {data.error !== null && state.step !== "progress" ? (
            <Alert variant="error">
              <AlertTitle>Could not read the Stave registry</AlertTitle>
              <AlertDescription>{data.error}</AlertDescription>
            </Alert>
          ) : data.isPending && state.step !== "progress" ? (
            <p className="text-xs text-muted-foreground">Loading Stave registry…</p>
          ) : null}
          {state.step === "identity" ? (
            <IdentityStep state={state} context={context} onChange={setState} />
          ) : state.step === "repos" ? (
            <ReposStep
              environmentId={environmentId}
              state={state}
              context={context}
              onChange={setState}
              onRepoRegistered={data.refreshRepos}
            />
          ) : state.step === "memory" ? (
            <MemoryStep
              memory={state.memory}
              context={context}
              onToggle={(spec) => setState((current) => toggleMemorySpec(current, spec))}
            />
          ) : state.step === "saga" ? (
            <SagaStep state={state} context={context} onChange={setState} />
          ) : state.step === "review" ? (
            <ReviewStep
              environmentId={environmentId}
              operation={operation}
              onDryRunPendingChange={setDryRunPending}
            />
          ) : operationId !== null ? (
            <div className="flex flex-col gap-3">
              <StaveOperationProgress
                environmentId={environmentId}
                operationId={operationId}
                spaceId={state.spaceId.trim()}
              />
              {openError !== null ? (
                <Alert variant="error">
                  <AlertTitle>The space was created, but opening it failed</AlertTitle>
                  <AlertDescription>{openError}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        {state.step === "progress" ? (
          terminal ? (
            <Button variant="outline" onClick={closeStaveWizard}>
              Close
            </Button>
          ) : (
            <Button disabled>Creating…</Button>
          )
        ) : (
          <>
            {!gate.ok && gate.message !== undefined ? (
              <p className="self-center text-xs text-muted-foreground sm:me-auto">{gate.message}</p>
            ) : null}
            <Button variant="outline" disabled={previous === null} onClick={goBack}>
              Back
            </Button>
            {state.step === "review" ? (
              <Button disabled={dryRunPending} onClick={create}>
                Create
              </Button>
            ) : (
              <Button disabled={!gate.ok} onClick={goNext}>
                Next
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </div>
  );
}
