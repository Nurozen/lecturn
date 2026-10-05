import {
  deleteStaveArchive,
  existingStaveSpaceDetail,
  existingStaveSpaces,
  type ExistingStaveSpace,
  type ExistingStaveSpaceKind,
  restoreStaveArchive,
  type StaveArchiveTaskState,
} from "@lecturn/client-runtime/state/stave-archive";
import type { EnvironmentId } from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { addProjectAndOpenThread, openExistingProjectAndThread } from "../../lib/addProject";
import { webStaveArchiveClient } from "../../lib/staveArchiveClient";
import { useProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { staveSpaces, useStaveStatus } from "../../state/stave";
import { useAtomCommand } from "../../state/use-atom-command";
import { notifyStaveMutation, subscribeStaveMutation } from "../../staveMutation";
import { closeStaveWizard } from "../../staveWizard";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DialogFooter, DialogPanel } from "../ui/dialog";
import { GoldThreadSpinner } from "../ui/gold-thread-spinner";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  deleteStaveArchiveCopy,
  existingStaveSpaceEmptyMessage,
  showArchivedLabel,
  staveArchiveTaskLabel,
} from "./existingStaveSpace.logic";
import { staveOperationUnavailableReason } from "./staveCompatibility.logic";
import { StaveOperationProgress } from "./StaveOperationProgress";

export type StaveWizardMode = "new" | "existing";

/** "New space | Existing space" above a wizard's steps. */
export function StaveWizardModeToggle(props: {
  readonly kind: ExistingStaveSpaceKind;
  readonly mode: StaveWizardMode;
  readonly onChange: (mode: StaveWizardMode) => void;
}) {
  const noun = props.kind === "saga" ? "saga" : "space";
  return (
    <ToggleGroup
      aria-label={`New or existing ${noun}`}
      variant="segmented"
      className="mt-1"
      value={[props.mode]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "new" || value === "existing") props.onChange(value);
      }}
    >
      <Toggle value="new">New {noun}</Toggle>
      <Toggle value="existing">Existing {noun}</Toggle>
    </ToggleGroup>
  );
}

type PickerAction = "add" | "restore" | "delete";

type PickerTask =
  | {
      readonly status: "running";
      readonly action: PickerAction;
      readonly label: string;
      readonly operationId: string | null;
    }
  | {
      readonly status: "failed";
      readonly action: PickerAction;
      readonly title: string;
      readonly message: string;
      readonly operationId: string | null;
    };

const EMPTY: ReadonlyArray<never> = [];

const RUNNING_BUTTON: Record<PickerAction, string> = {
  add: "Adding…",
  restore: "Restoring…",
  delete: "Deleting…",
};

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * Existing Stave spaces (or sagas) of an environment that are not open as
 * projects: active ones are added as a project, archives are restored into
 * their project (a saga with its archived members) or deleted permanently.
 * Renders the dialog panel and footer; the host wizard owns the header.
 */
export function ExistingStaveSpacePicker(props: {
  readonly environmentId: EnvironmentId;
  readonly kind: ExistingStaveSpaceKind;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const { environmentId, kind, onBusyChange } = props;
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const spaces = useEnvironmentQuery(
    staveSpaces({ environmentId, input: { includeArchived: true } }),
  );
  const refreshSpaces = spaces.refresh;
  useEffect(
    () =>
      subscribeStaveMutation((changed) => {
        if (changed === environmentId) refreshSpaces();
      }),
    [environmentId, refreshSpaces],
  );
  const compatibility = useStaveStatus(environmentId);
  const restoreUnavailable = staveOperationUnavailableReason(compatibility.data, "restoreSpace");
  const deleteUnavailable =
    restoreUnavailable ??
    staveOperationUnavailableReason(
      compatibility.data,
      kind === "saga" ? "sagaDestroy" : "destroySpace",
    );

  const [showArchived, setShowArchived] = useState(false);
  const rows = spaces.data ?? EMPTY;
  const { entries, archivedCount } = useMemo(
    () => existingStaveSpaces({ rows, projects, kind, showArchived }),
    [rows, projects, kind, showArchived],
  );
  const [task, setTask] = useState<PickerTask | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The entry outlives `confirmingDelete` so the dialog keeps its copy while closing.
  const [deleting, setDeleting] = useState<ExistingStaveSpace | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const running = task?.status === "running";
  useEffect(() => {
    onBusyChange(running);
    return () => onBusyChange(false);
  }, [onBusyChange, running]);

  /** Follows an archive runner, remembering its last operation for the failure view. */
  const follow = (action: PickerAction) => {
    let operationId: string | null = null;
    return {
      onState: (state: StaveArchiveTaskState) => {
        if (state.status !== "running") return;
        operationId = state.operationId ?? operationId;
        setTask({ status: "running", action, label: staveArchiveTaskLabel(state), operationId });
      },
      lastOperationId: () => operationId,
    };
  };

  const add = async (entry: ExistingStaveSpace) => {
    if (task !== null) return;
    setNotice(null);
    setTask({
      status: "running",
      action: "add",
      label: `Adding ${entry.spaceId}`,
      operationId: null,
    });
    const outcome = await addProjectAndOpenThread({
      environmentId,
      workspaceRoot: entry.path,
      title: entry.spaceId,
      createWorkspaceRootIfMissing: false,
      projects: allProjects,
      createProject,
      navigate,
      handleNewThread,
    });
    if (outcome.status === "opened") closeStaveWizard();
    else if (outcome.status === "interrupted") setTask(null);
    else
      setTask({
        status: "failed",
        action: "add",
        title: `Could not add ${entry.spaceId}`,
        message: describe(outcome.error, "Adding the project failed."),
        operationId: null,
      });
  };

  const restore = async (entry: ExistingStaveSpace) => {
    if (task !== null) return;
    setNotice(null);
    const progress = follow("restore");
    const final = await restoreStaveArchive(
      webStaveArchiveClient(environmentId),
      { row: entry.row, rows },
      progress.onState,
    );
    notifyStaveMutation(environmentId);
    const operationId = progress.lastOperationId();
    if (final.status !== "finished") {
      setTask({
        status: "failed",
        action: "restore",
        title: `Could not restore ${entry.spaceId}`,
        message: final.status === "failed" ? final.message : "The restore did not finish.",
        operationId,
      });
      return;
    }
    if (final.projectId === null) {
      setTask({
        status: "failed",
        action: "restore",
        title: `Restored ${entry.spaceId}, but it has no project`,
        message: "Add it from the list to open it as a project.",
        operationId,
      });
      return;
    }
    setTask({
      status: "running",
      action: "restore",
      label: `Opening ${entry.spaceId}`,
      operationId,
    });
    const outcome = await openExistingProjectAndThread({
      environmentId,
      projectId: final.projectId,
      ...(final.sequence === null ? {} : { sequence: final.sequence }),
      navigate,
      handleNewThread,
    });
    if (outcome.status === "failed") {
      setTask({
        status: "failed",
        action: "restore",
        title: `Restored ${entry.spaceId}, but opening it failed`,
        message: describe(outcome.error, "Opening the project failed."),
        operationId,
      });
      return;
    }
    closeStaveWizard();
  };

  const destroy = async (entry: ExistingStaveSpace) => {
    if (task !== null) return;
    setNotice(null);
    const progress = follow("delete");
    const final = await deleteStaveArchive(
      webStaveArchiveClient(environmentId),
      entry.row,
      progress.onState,
    );
    notifyStaveMutation(environmentId);
    if (final.status === "finished") {
      setTask(null);
      setNotice(`Deleted ${entry.spaceId}.`);
      return;
    }
    setTask({
      status: "failed",
      action: "delete",
      title: `Could not delete ${entry.spaceId}`,
      message: final.status === "failed" ? final.message : "The delete did not finish.",
      operationId: progress.lastOperationId(),
    });
  };

  const deleteCopy =
    deleting === null
      ? null
      : deleteStaveArchiveCopy({ ...deleting, memberOf: deleting.row.memberOf });

  return (
    <>
      <DialogPanel>
        {task !== null ? (
          <div className="flex flex-col gap-3">
            {task.status === "running" ? (
              <p aria-live="polite" className="flex items-center gap-3 text-sm font-medium">
                {task.operationId === null ? <GoldThreadSpinner /> : null}
                {task.label}
              </p>
            ) : (
              <Alert variant="error">
                <AlertTitle>{task.title}</AlertTitle>
                <AlertDescription>{task.message}</AlertDescription>
              </Alert>
            )}
            {task.operationId !== null ? (
              <StaveOperationProgress
                environmentId={environmentId}
                operationId={task.operationId}
              />
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {kind === "saga" ? "Sagas" : "Spaces"} on this environment that are not open as
                projects.
              </p>
              <Label className="gap-2 text-xs font-normal">
                <Switch
                  size="sm"
                  checked={showArchived}
                  onCheckedChange={(checked) => setShowArchived(checked)}
                />
                {showArchivedLabel(archivedCount)}
              </Label>
            </div>
            {showArchived && (restoreUnavailable ?? deleteUnavailable) !== null ? (
              <p className="text-xs text-muted-foreground">
                {restoreUnavailable ?? deleteUnavailable}
              </p>
            ) : null}
            {notice !== null ? (
              <Alert variant="success">
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            ) : null}
            {spaces.error !== null ? (
              <Alert variant="error">
                <AlertTitle>Could not read Stave spaces</AlertTitle>
                <AlertDescription>
                  <span>{spaces.error}</span>
                  <div>
                    <Button size="xs" variant="outline" onClick={refreshSpaces}>
                      Retry
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : spaces.data === null ? (
              <p className="text-xs text-muted-foreground">
                {spaces.isPending ? "Loading Stave spaces…" : null}
              </p>
            ) : entries.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {existingStaveSpaceEmptyMessage({ kind, showArchived, archivedCount })}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {entries.map((entry) => (
                  <li
                    key={entry.key}
                    className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-sm">{entry.spaceId}</span>
                        <Badge size="sm" variant={entry.archived ? "outline" : "success"}>
                          {entry.archived ? "Archived" : "Active"}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {existingStaveSpaceDetail(entry)}
                      </p>
                    </div>
                    {entry.archived ? (
                      <div className="flex gap-2">
                        <Button
                          size="xs"
                          variant="destructive-outline"
                          disabled={deleteUnavailable !== null}
                          onClick={() => {
                            setDeleting(entry);
                            setConfirmingDelete(true);
                          }}
                        >
                          Delete permanently
                        </Button>
                        <Button
                          size="xs"
                          disabled={restoreUnavailable !== null}
                          onClick={() => void restore(entry)}
                        >
                          Restore
                        </Button>
                      </div>
                    ) : (
                      <Button size="xs" onClick={() => void add(entry)}>
                        Add
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </DialogPanel>
      <DialogFooter>
        {task?.status === "running" ? (
          <Button disabled>{RUNNING_BUTTON[task.action]}</Button>
        ) : task?.status === "failed" ? (
          <>
            <Button variant="outline" onClick={closeStaveWizard}>
              Close
            </Button>
            <Button onClick={() => setTask(null)}>Back to list</Button>
          </>
        ) : (
          <Button variant="outline" onClick={closeStaveWizard}>
            Cancel
          </Button>
        )}
      </DialogFooter>
      <AlertDialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(false);
        }}
      >
        <AlertDialogPopup className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteCopy?.title}</AlertDialogTitle>
            {deleteCopy?.paragraphs.map((paragraph) => (
              <AlertDialogDescription key={paragraph}>{paragraph}</AlertDialogDescription>
            ))}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmingDelete(false);
                if (deleting !== null) void destroy(deleting);
              }}
            >
              Delete permanently
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
