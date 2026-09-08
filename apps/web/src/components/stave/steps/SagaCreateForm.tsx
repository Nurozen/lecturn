import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

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
  isOperationNotImplemented,
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
  const [state, setState] = useState<StaveSagaWizardState>(createInitialSagaWizardState);
  const [operationId, setOperationId] = useState<string | null>(null);
  const runOperation = useAtomCommand(staveOperations.run, { reportFailure: false });
  const operation = useAtomValue(staveOperations.stateAtom(operationId ?? IDLE_OPERATION_ID));
  const running = operation.status === "running" || operation.status === "disconnected";
  const terminal = operation.status === "finished" || operation.status === "failed";
  const notImplemented =
    operation.status === "failed" &&
    operation.error !== undefined &&
    isOperationNotImplemented(operation.error);

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

  const gate = validateSagaWizard(state, context.spaces);
  const id = validateSpaceId(state.sagaId, context.spaces);
  const idMessage = state.sagaId.length > 0 && !id.ok ? id.message : undefined;

  const create = () => {
    if (!gate.ok || operationId !== null) return;
    const nextId = randomUUID();
    setOperationId(nextId);
    void runOperation({
      environmentId,
      operationId: nextId,
      operation: buildCreateSagaOperation(state),
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
            {notImplemented ? (
              <Alert variant="info">
                <AlertTitle>Creating sagas from Lecturn is coming soon</AlertTitle>
                <AlertDescription>
                  Run <code className="font-mono">stave saga create {state.sagaId.trim()}</code> in
                  a terminal for now.
                </AlertDescription>
              </Alert>
            ) : (
              <StaveOperationProgress environmentId={environmentId} operationId={operationId} />
            )}
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
            <Button disabled={!gate.ok} onClick={create}>
              Create
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
