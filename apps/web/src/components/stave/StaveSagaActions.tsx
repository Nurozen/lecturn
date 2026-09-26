import { useSettingsAccountGlass } from "../settings/useSettingsAccountGlass";
import { useStaveStatus } from "../../state/stave";
import { staveOperationUnavailableReason } from "./staveCompatibility.logic";
import type {
  EnvironmentId,
  StaveOperation,
  StaveProjectInfo,
  StaveSpaceListRow,
} from "@lecturn/contracts";
import { useEffect, useState } from "react";
import { isValidStaveSpaceId } from "@lecturn/shared/stave";
import {
  restoreStaveArchive,
  type StaveArchiveTaskState,
} from "@lecturn/client-runtime/state/stave-archive";
import { webStaveArchiveClient } from "../../lib/staveArchiveClient";
import { staveSpaces, useStaveSagaStatus } from "../../state/stave";
import { useEnvironmentQuery } from "../../state/query";
import { openStaveWizard } from "../../staveWizard";
import { notifyStaveMutation, subscribeStaveMutation } from "../../staveMutation";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { StaveConfirmDialog } from "./StaveConfirmDialog";
import { StaveOperationProgress } from "./StaveOperationProgress";
import {
  archivedSagaRow,
  sagaAdoptCandidates,
  showArchivedLabel,
  staveArchiveTaskLabel,
} from "./existingStaveSpace.logic";
import { parseSagaAfter, resolveSagaMemberSpace, staveSagaMemberBadges } from "./staveSaga.logic";

export function StaveSagaActions({
  environmentId,
  sagaRoot,
  stave,
  memberRoot,
}: {
  environmentId: EnvironmentId;
  sagaRoot: string;
  stave: StaveProjectInfo;
  /** Space settings show its membership controls using the same roster editor. */
  memberRoot?: string;
}) {
  const archived = stave.state === "archived";
  const status = useStaveSagaStatus(environmentId, sagaRoot, !archived);
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
  const [editor, setEditor] = useState<{
    member?: StaveSpaceListRow;
    after: readonly string[];
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    operation: StaveOperation;
  } | null>(null);
  const [sagaRestore, setSagaRestore] = useState<ArchiveRestoreView | null>(null);
  const restoreSaga = async () => {
    const client = webStaveArchiveClient(environmentId);
    const progress = followArchiveRestore(setSagaRestore);
    setSagaRestore({ status: "running", label: "Reading archives", operationId: null });
    let rows: readonly StaveSpaceListRow[];
    try {
      rows = await client.listSpaces();
    } catch (error) {
      setSagaRestore({
        status: "failed",
        message: error instanceof Error ? error.message : "Could not read the Stave archives.",
        operationId: null,
      });
      return;
    }
    const row = archivedSagaRow(rows, sagaRoot);
    if (row === null) {
      setSagaRestore({
        status: "failed",
        message: "This saga's archive is gone; it may already have been restored.",
        operationId: null,
      });
      notifyStaveMutation(environmentId);
      return;
    }
    const final = await restoreStaveArchive(client, { row, rows }, progress.onState);
    notifyStaveMutation(environmentId);
    setSagaRestore(
      final.status === "failed"
        ? { status: "failed", message: final.message, operationId: progress.lastOperationId() }
        : null,
    );
  };
  const scope = {
    sagaRoot,
    ...(stave.createdAt ? { expectedManifestCreatedAt: stave.createdAt } : {}),
  };
  const bound = !!stave.createdAt;
  const compatibility = useStaveStatus(environmentId);
  const unsupported = (kind: StaveOperation["kind"]) =>
    staveOperationUnavailableReason(compatibility.data, kind) !== null;
  const review = (title: string, operation: StaveOperation) =>
    setConfirmation({ title, operation });
  const roster =
    status.data?.members.filter(
      (member) =>
        !memberRoot || resolveSagaMemberSpace(spaces.data ?? [], member.id)?.path === memberRoot,
    ) ?? [];
  return (
    <div className="flex flex-col gap-3 px-3 pb-4 sm:px-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {memberRoot ? `Saga ${stave.spaceId}` : "Saga members"}
        </p>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            status.refresh();
            spaces.refresh();
          }}
          disabled={status.isPending || archived}
        >
          Refresh
        </Button>
      </div>
      {!bound ? (
        <p className="text-xs text-muted-foreground">
          The saga manifest needs a creation timestamp before it can be changed here.
        </p>
      ) : null}
      {status.error ? <p className="text-xs text-destructive-foreground">{status.error}</p> : null}
      {archived ? (
        <p className="text-xs text-muted-foreground">
          This saga is archived. Restore it to resume work.
        </p>
      ) : null}
      {!memberRoot && !archived ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!bound || unsupported("createSpace")}
            onClick={() =>
              openStaveWizard({ environmentId, kind: "space", saga: { root: sagaRoot } })
            }
          >
            Create member
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!bound || unsupported("sagaAdd")}
            onClick={() => setEditor({ after: [] })}
          >
            Adopt existing space
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!bound || unsupported("sagaSync")}
            onClick={() => review("Sync saga", { kind: "sagaSync", ...scope })}
          >
            Sync saga
          </Button>
        </div>
      ) : null}
      {roster.map((member) => {
        const space = resolveSagaMemberSpace(spaces.data ?? [], member.id);
        const stamp = space?.manifestCreatedAt;
        return (
          <div
            key={member.id}
            className="flex flex-col gap-2 lecturn-glass-panel rounded-xl border border-border/40 p-4 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{member.id}</span>
              {staveSagaMemberBadges(member).map((badge) => (
                <Badge
                  key={badge}
                  variant={
                    badge === "dirty" || badge === "missing" || badge === "corrupt"
                      ? "warning"
                      : "outline"
                  }
                >
                  {badge}
                </Badge>
              ))}
            </div>
            <p className="text-muted-foreground">After: {member.after.join(", ") || "none"}</p>
            {member.error ? <p className="text-destructive-foreground">{member.error}</p> : null}
            <div className="flex gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={!bound || !stamp || archived || space?.archived || unsupported("sagaAdd")}
                onClick={() => {
                  if (space) setEditor({ member: space, after: member.after });
                }}
              >
                Edit dependencies
              </Button>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={!bound || !stamp || archived || unsupported("sagaRemove")}
                onClick={() => {
                  if (space && stamp)
                    review(`Remove ${member.id} from saga`, {
                      kind: "sagaRemove",
                      ...scope,
                      memberRoot: space.path,
                      expectedMemberCreatedAt: stamp,
                    });
                }}
              >
                Remove from saga
              </Button>
            </div>
          </div>
        );
      })}
      {status.data && roster.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {memberRoot ? "This space is not in the current roster." : "No members yet."}
        </p>
      ) : null}
      {status.data?.notes.map((note) => (
        <p
          key={`${note.kind}:${note.member ?? ""}:${note.text}`}
          className="text-xs text-muted-foreground"
        >
          {note.text}
        </p>
      ))}
      {!memberRoot && !archived ? (
        <div className="flex flex-wrap gap-2 border-t pt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={!bound || unsupported("sagaArchive")}
            onClick={() =>
              review("Archive saga", {
                kind: "sagaArchive",
                ...scope,
                force: false,
                memory: "keep",
              })
            }
          >
            Archive saga
          </Button>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={!bound || unsupported("sagaDestroy")}
            onClick={() =>
              review("Destroy saga", {
                kind: "sagaDestroy",
                ...scope,
                force: false,
                memory: "keep",
              })
            }
          >
            Destroy saga
          </Button>
        </div>
      ) : null}
      {archived && !memberRoot ? (
        <>
          <Button
            size="sm"
            className="self-start"
            disabled={sagaRestore?.status === "running" || unsupported("restoreSpace")}
            onClick={() => void restoreSaga()}
          >
            Restore saga
          </Button>
          {sagaRestore ? (
            <ArchiveRestoreProgress
              environmentId={environmentId}
              view={sagaRestore}
              failureTitle="Could not restore the saga"
            />
          ) : null}
        </>
      ) : null}
      {editor ? (
        <SagaMemberEditor
          environmentId={environmentId}
          spaces={spaces.data ?? []}
          editor={editor}
          sagaId={stave.spaceId}
          canRestore={!unsupported("restoreSpace")}
          onClose={() => setEditor(null)}
          onReview={(member, after, clearAfter) => {
            setEditor(null);
            review(editor.member ? "Update dependencies" : "Adopt space", {
              kind: "sagaAdd",
              ...scope,
              memberRoot: member.path,
              ...(member.manifestCreatedAt
                ? { expectedMemberCreatedAt: member.manifestCreatedAt }
                : {}),
              after,
              clearAfter,
            });
          }}
        />
      ) : null}
      {confirmation ? (
        <StaveConfirmDialog
          environmentId={environmentId}
          title={confirmation.title}
          operation={confirmation.operation}
          onClose={() => setConfirmation(null)}
          onFinished={() => {
            status.refresh();
            spaces.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

type ArchiveRestoreView =
  | { status: "running"; label: string; operationId: string | null }
  | { status: "failed"; message: string; operationId: string | null };

/** Mirrors an archive runner's running states into a view, keeping its last operation. */
function followArchiveRestore(set: (view: ArchiveRestoreView) => void) {
  let operationId: string | null = null;
  return {
    onState: (state: StaveArchiveTaskState) => {
      if (state.status !== "running") return;
      operationId = state.operationId ?? operationId;
      set({ status: "running", label: staveArchiveTaskLabel(state), operationId });
    },
    lastOperationId: () => operationId,
  };
}

function ArchiveRestoreProgress({
  environmentId,
  view,
  failureTitle,
}: {
  environmentId: EnvironmentId;
  view: ArchiveRestoreView;
  failureTitle: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      {view.status === "running" ? (
        <p aria-live="polite" className="text-xs font-medium">
          {view.label}
        </p>
      ) : (
        <Alert variant="error">
          <AlertTitle>{failureTitle}</AlertTitle>
          <AlertDescription>{view.message}</AlertDescription>
        </Alert>
      )}
      {view.operationId !== null ? (
        <StaveOperationProgress environmentId={environmentId} operationId={view.operationId} />
      ) : null}
    </div>
  );
}

function SagaMemberEditor({
  environmentId,
  spaces,
  editor,
  sagaId,
  canRestore,
  onClose,
  onReview,
}: {
  environmentId: EnvironmentId;
  spaces: readonly StaveSpaceListRow[];
  editor: { member?: StaveSpaceListRow; after: readonly string[] };
  sagaId: string;
  /** Archived spaces are offered (restored before the adopt) only when restore is supported. */
  canRestore: boolean;
  onClose: () => void;
  onReview: (
    member: { path: string; manifestCreatedAt?: string | undefined },
    after: readonly string[],
    clearAfter: boolean,
  ) => void;
}) {
  const glass = useSettingsAccountGlass(environmentId);
  const [path, setPath] = useState(editor.member?.path ?? "");
  const [selected, setSelected] = useState(editor.member);
  const [afterText, setAfterText] = useState(editor.after.join(", "));
  const [clearAfter, setClearAfter] = useState(!!editor.member);
  const [showArchived, setShowArchived] = useState(false);
  const [restore, setRestore] = useState<ArchiveRestoreView | null>(null);
  const restoring = restore?.status === "running";
  const { candidates, archivedCount } = sagaAdoptCandidates(
    spaces,
    sagaId,
    showArchived && canRestore,
  );
  const member = selected?.path === path ? selected : undefined;
  const after = parseSagaAfter(afterText);
  const valid =
    !!member &&
    after.every((id) => isValidStaveSpaceId(id) && id !== (member.logicalId ?? member.id));
  const submit = async () => {
    if (!member || !valid || restoring) return;
    if (!member.archived) {
      onReview(member, after, clearAfter);
      return;
    }
    const progress = followArchiveRestore(setRestore);
    const final = await restoreStaveArchive(
      webStaveArchiveClient(environmentId),
      { row: member, rows: spaces },
      progress.onState,
    );
    notifyStaveMutation(environmentId);
    if (final.status === "finished" && final.restored !== null) {
      // The adopt binds the live root and stamp the restore produced.
      onReview(
        { path: final.restored.spacePath, manifestCreatedAt: final.restored.createdAt },
        after,
        clearAfter,
      );
      return;
    }
    setRestore({
      status: "failed",
      message:
        final.status === "failed" ? final.message : "The restore did not report the space's root.",
      operationId: progress.lastOperationId(),
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !restoring) onClose();
      }}
    >
      <DialogPopup
        {...glass}
        className="lecturn-account-surface lecturn-project-settings-dialog max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{editor.member ? "Edit dependencies" : "Adopt existing space"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 pb-5">
          <Label className="flex flex-col gap-2">
            Space path
            <Input
              list="stave-saga-spaces"
              value={path}
              disabled={!!editor.member}
              onChange={(event) => {
                setPath(event.target.value);
                setSelected(candidates.find((space) => space.path === event.target.value));
              }}
            />
            <datalist id="stave-saga-spaces">
              {candidates.map((space) => (
                <option key={space.path} value={space.path}>
                  {`${space.logicalId ?? space.id}${space.archived ? " (archived)" : ""}`}
                </option>
              ))}
            </datalist>
          </Label>
          {!editor.member && canRestore ? (
            <Label className="gap-2 text-xs font-normal">
              <Switch
                size="sm"
                checked={showArchived}
                disabled={restoring}
                onCheckedChange={(checked) => setShowArchived(checked)}
              />
              {showArchivedLabel(archivedCount)}
            </Label>
          ) : null}
          {member?.archived && !restore ? (
            <p className="text-xs text-muted-foreground">
              This space is archived. It is restored first, then adopted.
            </p>
          ) : null}
          {restore ? (
            <ArchiveRestoreProgress
              environmentId={environmentId}
              view={restore}
              failureTitle={`Could not restore ${member?.logicalId ?? member?.id ?? "the space"}`}
            />
          ) : null}
          <Label className="flex flex-col gap-2">
            After member ids
            <Input
              value={afterText}
              placeholder="member-a, member-b"
              onChange={(event) => setAfterText(event.target.value)}
            />
          </Label>
          <Label className="flex items-center gap-2">
            <Checkbox
              data-lecturn-hover
              checked={clearAfter}
              disabled={after.length > 0}
              onCheckedChange={(checked) => setClearAfter(checked === true)}
            />
            Clear existing edges when the list is empty
          </Label>
          <p className="text-xs text-muted-foreground">
            A nonempty list replaces existing predecessors. With an empty list, select Clear to
            remove all dependencies; otherwise existing edges are kept. Stave checks for cycles.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={restoring} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid || restoring} onClick={() => void submit()}>
            {restoring
              ? "Restoring…"
              : member?.archived
                ? "Restore and review plan"
                : "Review plan"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Registry timestamps bind both sides of a space's membership change. */
export function StaveSpaceMembership({
  environmentId,
  workspaceRoot,
  stave,
}: {
  environmentId: EnvironmentId;
  workspaceRoot: string;
  stave: StaveProjectInfo;
}) {
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
  const [sagaPath, setSagaPath] = useState("");
  const candidates =
    spaces.data?.filter(
      (row) => row.isSaga && !row.archived && !row.error && row.manifestCreatedAt,
    ) ?? [];
  const current =
    spaces.data !== null
      ? spaces.data.find((row) => row.path === workspaceRoot)?.memberOf
      : stave.memberOf;
  const saga = candidates.find((row) =>
    current ? (row.logicalId ?? row.id) === current : row.path === sagaPath,
  );
  const [confirmation, setConfirmation] = useState<StaveOperation | null>(null);
  if (stave.state === "archived") return null;
  return (
    <div className="border-t pt-3">
      {current && saga ? (
        <StaveSagaActions
          key={`${environmentId}:${saga.path}:${saga.manifestCreatedAt}`}
          environmentId={environmentId}
          sagaRoot={saga.path}
          stave={{
            ...stave,
            spaceId: saga.logicalId ?? saga.id,
            isSaga: true,
            kind: "saga",
            ...(saga.manifestCreatedAt ? { createdAt: saga.manifestCreatedAt } : {}),
          }}
          memberRoot={workspaceRoot}
        />
      ) : (
        <div className="flex flex-col gap-2 px-3 pb-4 sm:px-4">
          <p className="text-sm font-medium">Saga membership</p>
          {current ? (
            <p className="text-xs text-muted-foreground">
              Member of {current}. Its live saga is unavailable.
            </p>
          ) : (
            <>
              <Label className="flex flex-col gap-2">
                Join saga
                <Input
                  list="stave-membership-sagas"
                  value={sagaPath}
                  placeholder="Select a saga path"
                  onChange={(event) => setSagaPath(event.target.value)}
                />
                <datalist id="stave-membership-sagas">
                  {candidates.map((row) => (
                    <option key={row.path} value={row.path}>
                      {row.logicalId ?? row.id}
                    </option>
                  ))}
                </datalist>
              </Label>
              <Button
                size="sm"
                className="self-start"
                disabled={!saga || !stave.createdAt}
                onClick={() => {
                  if (saga)
                    setConfirmation({
                      kind: "sagaAdd",
                      sagaRoot: saga.path,
                      ...(saga.manifestCreatedAt
                        ? { expectedManifestCreatedAt: saga.manifestCreatedAt }
                        : {}),
                      memberRoot: workspaceRoot,
                      ...(stave.createdAt ? { expectedMemberCreatedAt: stave.createdAt } : {}),
                      after: [],
                      clearAfter: false,
                    });
                }}
              >
                Review joining saga
              </Button>
            </>
          )}
        </div>
      )}
      {confirmation ? (
        <StaveConfirmDialog
          environmentId={environmentId}
          title="Join saga"
          operation={confirmation}
          onClose={() => setConfirmation(null)}
          onFinished={spaces.refresh}
        />
      ) : null}
    </div>
  );
}
