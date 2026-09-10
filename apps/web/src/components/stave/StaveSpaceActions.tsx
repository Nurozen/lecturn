import type {
  EnvironmentId,
  StaveOperation,
  StaveProjectInfo,
  StaveRepoEntry,
} from "@t3tools/contracts";
import { useState } from "react";

import { isValidStaveSpaceId } from "@t3tools/shared/stave";
import { staveOperationUnavailableReason } from "./staveCompatibility.logic";
import { staveRepos, staveSpaces, useStaveStatus } from "../../state/stave";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { StaveConfirmDialog } from "./StaveConfirmDialog";

type Editor = { kind: "add" } | { kind: "retarget"; repo: StaveRepoEntry } | { kind: "memory" };

/** Edits stay bound to the manifest incarnation visible when the dialog opens. */
export function StaveSpaceActions({
  environmentId,
  workspaceRoot,
  stave,
  onFinished,
}: {
  environmentId: EnvironmentId;
  workspaceRoot: string;
  stave: StaveProjectInfo;
  onFinished: () => void;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    operation: StaveOperation;
  } | null>(null);
  const [referencesOnly, setReferencesOnly] = useState(false);
  const scope = { workspaceRoot, expectedManifestCreatedAt: stave.createdAt };
  const bound = stave.createdAt !== undefined;
  const status = useStaveStatus(environmentId);
  const unsupported = (kind: StaveOperation["kind"]) =>
    staveOperationUnavailableReason(status.data, kind) !== null;
  const archived = stave.state === "archived";
  const saga = stave.isSaga || stave.kind === "saga";
  const confirm = (title: string, operation: StaveOperation) =>
    setConfirmation({ title, operation });
  return (
    <div className="flex flex-col gap-4 px-3 pb-4 sm:px-4">
      {!bound ? (
        <p className="text-xs text-muted-foreground">
          This legacy manifest has no creation timestamp. Repair it with Stave before changing this
          space here.
        </p>
      ) : null}
      {archived ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <p className="text-sm text-muted-foreground">
            Unarchive this space to start a thread or edit its repos.
          </p>
          <Button
            size="sm"
            disabled={!bound || !stave.archiveBasename || unsupported("restoreSpace")}
            onClick={() => {
              if (stave.archiveBasename)
                confirm("Unarchive space", {
                  kind: "restoreSpace",
                  ...scope,
                  from: stave.archiveBasename,
                });
            }}
          >
            Unarchive
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!bound || unsupported("addRepo")}
              onClick={() => setEditor({ kind: "add" })}
            >
              {saga ? "Add reference repo" : "Add repo"}
            </Button>
            {!saga ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!bound || unsupported("syncSpace")}
                  onClick={() =>
                    confirm("Sync space", { kind: "syncSpace", ...scope, referencesOnly })
                  }
                >
                  Sync
                </Button>
                <Label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={referencesOnly}
                    onCheckedChange={(value) => setReferencesOnly(value === true)}
                  />
                  References only
                </Label>
              </>
            ) : null}
          </div>
          {stave.repos.map((repo) => (
            <div
              key={`${repo.mode}:${repo.name}`}
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <span className="mr-auto font-mono">
                {repo.name} <span className="text-muted-foreground">({repo.mode})</span>
              </span>
              {repo.mode === "edit" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!bound || unsupported("retarget")}
                  onClick={() => setEditor({ kind: "retarget", repo })}
                >
                  Retarget
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={!bound || unsupported("removeRepo")}
                onClick={() =>
                  confirm(`Remove ${repo.name} (${repo.mode})`, {
                    kind: "removeRepo",
                    ...scope,
                    repo: repo.name,
                    mode: repo.mode,
                    force: false,
                  })
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <div className="flex flex-col gap-2 border-t pt-3">
            <Button
              className="self-start"
              size="sm"
              variant="outline"
              disabled={!bound || unsupported("memoryAttach")}
              onClick={() => setEditor({ kind: "memory" })}
            >
              Attach memory
            </Button>
            {stave.memories.map((memory) => (
              <div key={memory.name} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="mr-auto font-mono">{memory.name}</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!bound || unsupported("memoryDetach")}
                  onClick={() =>
                    confirm(`Detach ${memory.name}`, {
                      kind: "memoryDetach",
                      ...scope,
                      alias: memory.name,
                      fate: "keep",
                    })
                  }
                >
                  Detach and keep
                </Button>
                {memory.owned ? (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={!bound || unsupported("memoryDetach")}
                    onClick={() =>
                      confirm(`Destroy ${memory.name}`, {
                        kind: "memoryDetach",
                        ...scope,
                        alias: memory.name,
                        fate: "destroy",
                      })
                    }
                  >
                    Detach and destroy
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
          {!saga ? (
            <div className="flex flex-wrap gap-2 border-t pt-3">
              <Button
                size="sm"
                variant="outline"
                disabled={!bound || unsupported("archiveSpace")}
                onClick={() =>
                  confirm("Archive space", {
                    kind: "archiveSpace",
                    ...scope,
                    force: false,
                    memory: "keep",
                  })
                }
              >
                Archive space
              </Button>
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={!bound || unsupported("destroySpace")}
                onClick={() =>
                  confirm("Destroy space", {
                    kind: "destroySpace",
                    ...scope,
                    force: false,
                    memory: "keep",
                  })
                }
              >
                Destroy space
              </Button>
            </div>
          ) : null}
        </>
      )}
      {editor ? (
        <SpaceEditDialog
          key={JSON.stringify(editor)}
          scope={scope}
          environmentId={environmentId}
          editor={editor}
          referencesOnly={saga}
          onClose={() => setEditor(null)}
          onReview={(operation, title) => {
            setEditor(null);
            confirm(title, operation);
          }}
        />
      ) : null}
      {confirmation ? (
        <StaveConfirmDialog
          environmentId={environmentId}
          title={confirmation.title}
          operation={confirmation.operation}
          onClose={() => setConfirmation(null)}
          onFinished={onFinished}
        />
      ) : null}
    </div>
  );
}

function SpaceEditDialog({
  environmentId,
  scope,
  editor,
  referencesOnly,
  onClose,
  onReview,
}: {
  environmentId: EnvironmentId;
  scope: { workspaceRoot: string; expectedManifestCreatedAt: string | undefined };
  editor: Editor;
  referencesOnly: boolean;
  onClose: () => void;
  onReview: (operation: StaveOperation, title: string) => void;
}) {
  const repos = useEnvironmentQuery(
    editor.kind === "add" ? staveRepos({ environmentId, input: {} }) : null,
  );
  const spaces = useEnvironmentQuery(
    editor.kind === "memory"
      ? null
      : staveSpaces({ environmentId, input: { includeArchived: false } }),
  );
  const [repo, setRepo] = useState(editor.kind === "retarget" ? editor.repo.name : "");
  const [mode, setMode] = useState<"edit" | "reference">(referencesOnly ? "reference" : "edit");
  const [base, setBase] = useState("");
  const [branch, setBranch] = useState("");
  const [memory, setMemory] = useState(".");
  const [noFetch, setNoFetch] = useState(false);
  const [linkMemory, setLinkMemory] = useState(false);
  const title =
    editor.kind === "add"
      ? "Add repo"
      : editor.kind === "memory"
        ? "Attach memory"
        : `Retarget ${repo}`;
  const valid =
    editor.kind === "memory"
      ? memory.trim().length > 0
      : isValidStaveSpaceId(repo) && (editor.kind !== "retarget" || base.trim().length > 0);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 pb-6">
          {editor.kind === "memory" ? (
            <Label className="flex flex-col gap-2">
              Memory store
              <Input
                value={memory}
                onChange={(event) => setMemory(event.target.value)}
                placeholder=". or provider:store"
              />
              <span className="text-xs text-muted-foreground">
                Use . for a fresh store, or enter an existing provider:store.
              </span>
            </Label>
          ) : (
            <>
              {editor.kind === "add" ? (
                <>
                  <Label className="flex flex-col gap-2">
                    Registered repo
                    <Input
                      list="stave-edit-repos"
                      value={repo}
                      onChange={(event) => setRepo(event.target.value)}
                    />
                    <datalist id="stave-edit-repos">
                      {repos.data?.map((row) => (
                        <option key={row.name} value={row.name} />
                      ))}
                    </datalist>
                  </Label>
                  <Label className="flex flex-col gap-2">
                    Mode
                    <Select
                      value={mode}
                      onValueChange={(value) => {
                        if (value === "reference" || (value === "edit" && !referencesOnly))
                          setMode(value);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {!referencesOnly ? <SelectItem value="edit">Editable</SelectItem> : null}
                        <SelectItem value="reference">Reference</SelectItem>
                      </SelectPopup>
                    </Select>
                  </Label>
                </>
              ) : null}
              <Label className="flex flex-col gap-2">
                {mode === "reference"
                  ? "Ref (optional)"
                  : editor.kind === "retarget"
                    ? "New base"
                    : "Base (optional)"}
                <Input
                  list="stave-edit-bases"
                  value={base}
                  onChange={(event) => setBase(event.target.value)}
                  placeholder="main or space:existing-space"
                />
                <datalist id="stave-edit-bases">
                  {spaces.data?.map((space) => (
                    <option key={space.path} value={`space:${space.logicalId ?? space.id}`} />
                  ))}
                </datalist>
              </Label>
              {editor.kind === "add" ? (
                <>
                  {mode === "edit" ? (
                    <Label className="flex flex-col gap-2">
                      Branch (optional)
                      <Input value={branch} onChange={(event) => setBranch(event.target.value)} />
                    </Label>
                  ) : (
                    <Label className="flex items-center gap-2">
                      <Checkbox
                        checked={linkMemory}
                        onCheckedChange={(value) => setLinkMemory(value === true)}
                      />
                      Link reference memory
                    </Label>
                  )}
                  <Label className="flex items-center gap-2">
                    <Checkbox
                      checked={noFetch}
                      onCheckedChange={(value) => setNoFetch(value === true)}
                    />
                    Use cached refs without fetching
                  </Label>
                </>
              ) : null}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              if (!valid) return;
              if (editor.kind === "memory")
                onReview(
                  { kind: "memoryAttach", ...scope, specs: [{ spec: memory.trim() }] },
                  title,
                );
              else if (editor.kind === "retarget")
                onReview({ kind: "retarget", ...scope, repo, base: base.trim() }, title);
              else
                onReview(
                  {
                    kind: "addRepo",
                    ...scope,
                    repo,
                    mode,
                    ...(base.trim() ? { base: base.trim() } : {}),
                    ...(mode === "edit" && branch.trim() ? { branch: branch.trim() } : {}),
                    noFetch,
                    linkMemory: mode === "reference" && linkMemory,
                  },
                  title,
                );
            }}
          >
            Review plan
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
