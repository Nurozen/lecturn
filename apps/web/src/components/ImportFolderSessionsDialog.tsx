import {
  type BulkImportResult,
  bulkImportProgressLabel,
  bulkImportSummary,
  defaultImportSelection,
  externalSessionKey,
  importSessionsActionLabel,
  importSessionsSequentially,
  latestImported,
  sessionsInFolder,
} from "@lecturn/client-runtime/external-session-import";
import type { ExternalSessionSummary, ScopedThreadRef } from "@lecturn/contracts";
import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState, useSyncExternalStore } from "react";

import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { externalSessionListNotes, useExternalSessionList } from "../hooks/useExternalSessionList";
import { useDispatchThreadImport } from "../hooks/useImportThread";
import {
  closeImportFolderSessions,
  type ImportFolderSessionsRequest,
  readImportFolderSessionsRequest,
  subscribeImportFolderSessions,
} from "../importFolderSessions";
import { openExistingProjectAndThread } from "../lib/addProject";
import { useProject, useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  collectImportedSessionIds,
  externalSessionTitle,
  IMPORT_SESSION_COST_NOTE,
  IMPORT_SESSION_TRUNCATED_NOTE,
} from "./ImportSessionPalette.logic";
import { ExternalSessionSubtitle } from "./ImportSessionPalette";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { toastManager } from "./ui/toast";

/**
 * Host for the multi-select import that follows the palette's "From Claude
 * Code or Codex" source, mounted once in `__root.tsx` and driven by the
 * `importFolderSessions` bus. The dialog refuses to close while an import runs
 * so its progress and failures stay observed.
 */
export function ImportFolderSessionsDialog() {
  const request = useSyncExternalStore(
    subscribeImportFolderSessions,
    readImportFolderSessionsRequest,
    readImportFolderSessionsRequest,
  );
  // The last request survives the close animation; a new one remounts the content.
  const [tracked, setTracked] = useState<{
    readonly request: ImportFolderSessionsRequest | null;
    readonly key: number;
  }>({ request: null, key: 0 });
  if (request !== null && tracked.request !== request) {
    setTracked({ request, key: tracked.key + 1 });
  }
  const [busy, setBusy] = useState(false);
  const shown = request ?? tracked.request;

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (open || busy) return;
        closeImportFolderSessions();
      }}
    >
      <DialogPopup className="max-w-2xl" showCloseButton={!busy}>
        {shown === null ? null : (
          <ImportFolderSessionsContent key={tracked.key} request={shown} onBusyChange={setBusy} />
        )}
      </DialogPopup>
    </Dialog>
  );
}

type ImportPhase =
  | { readonly kind: "choosing" }
  | { readonly kind: "importing"; readonly position: number; readonly total: number }
  | {
      readonly kind: "done";
      readonly result: BulkImportResult<ExternalSessionSummary, ScopedThreadRef>;
    };

function ImportFolderSessionsContent(props: {
  readonly request: ImportFolderSessionsRequest;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const { onBusyChange, request } = props;
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const dispatchImport = useDispatchThreadImport();
  const project = useProject(scopeProjectRef(request.environmentId, request.projectId));
  const threads = useThreadShells();
  const { merged, providerEntries, isLoading } = useExternalSessionList({
    environmentId: request.environmentId,
    cwd: request.folder,
  });
  const sessions = useMemo(
    () => (merged === null ? [] : sessionsInFolder(merged.sessions, request.folder)),
    [merged, request.folder],
  );
  const importedSessionIds = useMemo(
    () =>
      collectImportedSessionIds(
        threads.filter((thread) => thread.environmentId === request.environmentId),
      ),
    [request.environmentId, threads],
  );
  const [openedAt] = useState(() => Date.now());
  // Null until the user edits it, so the default follows the list as it loads.
  const [editedSelection, setEditedSelection] = useState<ReadonlySet<string> | null>(null);
  const defaultSelection = useMemo(
    () => defaultImportSelection({ sessions, importedSessionIds, now: openedAt }),
    [importedSessionIds, openedAt, sessions],
  );
  const selection = editedSelection ?? defaultSelection;
  const selectedSessions = sessions.filter((session) => selection.has(externalSessionKey(session)));
  const [phase, setPhase] = useState<ImportPhase>({ kind: "choosing" });

  const toggle = (session: ExternalSessionSummary, checked: boolean) => {
    const next = new Set(selection);
    if (checked) next.add(externalSessionKey(session));
    else next.delete(externalSessionKey(session));
    setEditedSelection(next);
  };

  const runImport = async () => {
    if (project === null || selectedSessions.length === 0) return;
    // Pin the selection: sessions turn "Imported" as the run lands them.
    setEditedSelection(selection);
    onBusyChange(true);
    const result = await importSessionsSequentially({
      sessions: selectedSessions,
      importSession: (session) =>
        dispatchImport({ session, project, worktreePath: null, branch: null }),
      onProgress: (progress) => setPhase({ kind: "importing", ...progress }),
    });
    onBusyChange(false);
    const target = latestImported(result.imported);
    if (target !== null) {
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
    } else {
      void openExistingProjectAndThread({
        environmentId: request.environmentId,
        projectId: request.projectId,
        navigate,
        handleNewThread,
      });
    }
    if (result.failed.length === 0) {
      toastManager.add({ type: "success", title: bulkImportSummary(result).title });
      closeImportFolderSessions();
      return;
    }
    setPhase({ kind: "done", result });
  };

  if (phase.kind === "done") {
    const summary = bulkImportSummary(phase.result);
    return (
      <>
        <DialogHeader>
          <DialogTitle>{summary.title}</DialogTitle>
          <DialogDescription>{request.folder}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Alert variant={phase.result.imported.length === 0 ? "error" : "warning"}>
            <AlertTitle>{summary.description}</AlertTitle>
            <AlertDescription>
              <ul className="space-y-1">
                {phase.result.failed.map(({ session, message }) => (
                  <li key={externalSessionKey(session)}>
                    <span className="text-foreground">{externalSessionTitle(session)}</span>
                    {`: ${message}`}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        </DialogPanel>
        <DialogFooter>
          <Button onClick={closeImportFolderSessions}>Done</Button>
        </DialogFooter>
      </>
    );
  }

  const importing = phase.kind === "importing";
  const notes =
    merged === null
      ? []
      : [
          ...(sessions.length > 0 ? [IMPORT_SESSION_COST_NOTE] : []),
          ...externalSessionListNotes({
            merged,
            providerEntries,
            truncatedNote: IMPORT_SESSION_TRUNCATED_NOTE,
          }),
        ];

  return (
    <>
      <DialogHeader>
        <DialogTitle>Import sessions</DialogTitle>
        <DialogDescription className="truncate">{request.folder}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {isLoading ? (
          <p className="py-6 text-center text-muted-foreground text-sm">Loading sessions…</p>
        ) : sessions.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground text-sm">
            No sessions found in this folder.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <span className="me-auto">
                {selectedSessions.length} of {sessions.length} selected
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={importing}
                onClick={() =>
                  setEditedSelection(
                    new Set(sessions.map((session) => externalSessionKey(session))),
                  )
                }
              >
                Select all
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={importing}
                onClick={() => setEditedSelection(new Set())}
              >
                Select none
              </Button>
            </div>
            <ul className="divide-y divide-border/60 rounded-lg border">
              {sessions.map((session) => {
                const key = externalSessionKey(session);
                return (
                  <li key={key}>
                    <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-accent/40">
                      <Checkbox
                        className="mt-0.5"
                        checked={selection.has(key)}
                        disabled={importing}
                        onCheckedChange={(checked) => toggle(session, checked)}
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-foreground text-sm">
                          {externalSessionTitle(session)}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          <ExternalSessionSubtitle
                            session={session}
                            provider={providerEntries.find(
                              (entry) => entry.instanceId === session.providerInstanceId,
                            )}
                            imported={importedSessionIds.has(session.sessionId)}
                            blockedReason={null}
                            showFolder={false}
                          />
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {notes.length > 0 ? (
          <div className="mt-3 space-y-1 text-muted-foreground text-xs">
            {notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {importing ? (
          <span className="me-auto self-center text-muted-foreground text-sm" aria-live="polite">
            {bulkImportProgressLabel(phase)}
          </span>
        ) : null}
        <Button variant="outline" disabled={importing} onClick={closeImportFolderSessions}>
          {sessions.length === 0 && !isLoading ? "Close" : "Cancel"}
        </Button>
        <Button
          disabled={importing || project === null || selectedSessions.length === 0}
          onClick={() => void runImport()}
        >
          {importSessionsActionLabel(selectedSessions.length)}
        </Button>
      </DialogFooter>
    </>
  );
}
