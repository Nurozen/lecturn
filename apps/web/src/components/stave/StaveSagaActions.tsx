import { useStaveStatus } from "../../state/stave";
import { staveOperationUnavailableReason } from "./staveCompatibility.logic";
import type {
  EnvironmentId,
  StaveOperation,
  StaveProjectInfo,
  StaveSpaceListRow,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { isValidStaveSpaceId } from "@t3tools/shared/stave";
import { staveSpaces, useStaveSagaStatus } from "../../state/stave";
import { useEnvironmentQuery } from "../../state/query";
import { openStaveWizard } from "../../staveWizard";
import { subscribeStaveMutation } from "../../staveMutation";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { StaveConfirmDialog } from "./StaveConfirmDialog";
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
          This saga is archived. Unarchive its space and then individual members to resume work.
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
          <div key={member.id} className="flex flex-col gap-2 rounded-lg border p-3 text-xs">
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
        <Button
          size="sm"
          className="self-start"
          disabled={!bound || !stave.archiveBasename || unsupported("restoreSpace")}
          onClick={() => {
            if (stave.archiveBasename)
              review("Unarchive saga space", {
                kind: "restoreSpace",
                workspaceRoot: sagaRoot,
                expectedManifestCreatedAt: stave.createdAt,
                from: stave.archiveBasename,
              });
          }}
        >
          Unarchive saga space
        </Button>
      ) : null}
      {editor ? (
        <SagaMemberEditor
          spaces={spaces.data ?? []}
          editor={editor}
          sagaId={stave.spaceId}
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

function SagaMemberEditor({
  spaces,
  editor,
  sagaId,
  onClose,
  onReview,
}: {
  spaces: readonly StaveSpaceListRow[];
  editor: { member?: StaveSpaceListRow; after: readonly string[] };
  sagaId: string;
  onClose: () => void;
  onReview: (member: StaveSpaceListRow, after: readonly string[], clearAfter: boolean) => void;
}) {
  const [path, setPath] = useState(editor.member?.path ?? "");
  const [selected, setSelected] = useState(editor.member);
  const [afterText, setAfterText] = useState(editor.after.join(", "));
  const [clearAfter, setClearAfter] = useState(!!editor.member);
  const candidates = spaces.filter(
    (space) =>
      !space.isSaga &&
      !space.archived &&
      !space.error &&
      !!space.manifestCreatedAt &&
      (!space.memberOf || space.memberOf === sagaId),
  );
  const member = selected?.path === path ? selected : undefined;
  const after = parseSagaAfter(afterText);
  const valid =
    !!member &&
    after.every((id) => isValidStaveSpaceId(id) && id !== (member.logicalId ?? member.id));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
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
                  {space.logicalId ?? space.id}
                </option>
              ))}
            </datalist>
          </Label>
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
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              if (member && valid) onReview(member, after, clearAfter);
            }}
          >
            Review plan
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
