import { DecisionEvidenceId } from "@lecturn/contracts";
import { useState } from "react";
import type { DecisionId, EnvironmentId, ProjectId, ThreadDecision } from "@lecturn/contracts";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import { randomUUID } from "../../lib/utils";
import {
  contextualEnvironment,
  contextualErrorMessage,
  useContextualAccess,
} from "../../state/contextual";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { DecisionAttributionChip } from "../DecisionAttributionChip";
import { Button } from "../ui/button";
import { threadDecisionEnvironment } from "../../state/threadDecisions";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel } from "../ui/dialog";
export function ContextualDecisionGroupCard({
  environmentId,
  projectId,
  note,
  onChange,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  note: ThreadDecision;
  onChange?: () => void;
}) {
  const [source, setSource] = useState<{ decisionId: DecisionId; evidenceId: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const metadata = note.consolidation;
  const access = useContextualAccess(environmentId);
  const group = useEnvironmentQuery(
    open && metadata
      ? contextualEnvironment.group({
          environmentId,
          input: { projectId, groupId: metadata.groupId, limit: 25, ...(cursor ? { cursor } : {}) },
        })
      : null,
  );
  const undo = useAtomCommand(contextualEnvironment.undoGroup, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function undoMerge() {
    if (!metadata?.undo || !access.operate || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await undo({
        environmentId,
        input: {
          actionId: randomUUID(),
          groupId: metadata.groupId,
          mergeId: metadata.undo.mergeId,
          expectedRevision: metadata.revision,
          expectedOccurrenceRevision: metadata.undo.expectedOccurrenceRevision,
        },
      });
      if (r._tag === "Failure") setError(contextualErrorMessage(squashAtomCommandFailure(r)));
      else onChange?.();
    } finally {
      setBusy(false);
    }
  }
  if (!metadata) return null;
  return (
    <div className="mt-2 rounded-lg border border-border/60 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          Combined matching decisions · {metadata.occurrenceCount} sources
        </Button>
        {metadata.undo && access.operate ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void undoMerge()}
          >
            Undo latest combination
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 space-y-3">
          <p className="text-muted-foreground">
            Each occurrence retains its original attribution and review state.
          </p>
          {group.data?.occurrences.map((occurrence) => (
            <article
              key={occurrence.decisionId}
              className="space-y-1 border-t border-border/50 pt-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <DecisionAttributionChip attribution={occurrence.attribution} />
                <span>
                  {occurrence.reviewState} · {occurrence.lifecycle}
                </span>
                {occurrence.userEdited ? <span>Edited</span> : null}
              </div>
              <p className="font-medium">{occurrence.title}</p>
              <p className="whitespace-pre-wrap">{occurrence.body}</p>
              <p className="text-muted-foreground">
                Thread {occurrence.threadId} · {new Date(occurrence.createdAt).toLocaleString()}
              </p>
              {occurrence.evidenceIds.map((evidenceId, index) => (
                <Button
                  key={evidenceId}
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => setSource({ decisionId: occurrence.decisionId, evidenceId })}
                >
                  Inspect supporting exchange {index + 1}
                </Button>
              ))}
              {occurrence.comment ? (
                <p className="whitespace-pre-wrap">Comment: {occurrence.comment}</p>
              ) : null}
            </article>
          ))}
          <div className="flex gap-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!cursor}
              onClick={() => setCursor(undefined)}
            >
              First sources
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!group.data?.nextCursor}
              onClick={() => setCursor(group.data?.nextCursor ?? undefined)}
            >
              More sources
            </Button>
          </div>
        </div>
      ) : null}
      {source ? (
        <OccurrenceEvidence
          environmentId={environmentId}
          projectId={projectId}
          {...source}
          onClose={() => setSource(null)}
        />
      ) : null}
      {error || group.error ? (
        <p role="alert" className="text-destructive">
          {error ?? group.error}
        </p>
      ) : null}
    </div>
  );
}

function OccurrenceEvidence({
  environmentId,
  projectId,
  decisionId,
  evidenceId,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  decisionId: DecisionId;
  evidenceId: string;
  onClose: () => void;
}) {
  const source = useEnvironmentQuery(
    threadDecisionEnvironment.sourceWindow({
      environmentId,
      input: { projectId, decisionId, evidenceId: DecisionEvidenceId.make(evidenceId) },
    }),
  );
  const result = source.data;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Supporting exchange</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <p role="status">
            {result?.outcome === "exact"
              ? "Exact supporting passage"
              : result?.outcome === "message-only"
                ? "Source changed; exact passage is unavailable"
                : result?.outcome === "unavailable"
                  ? "Source unavailable"
                  : "Loading source…"}
          </p>
          {source.error ? (
            <p role="alert" className="text-destructive">
              {source.error}
            </p>
          ) : null}
          {result?.messages.map((message) => (
            <article key={message.id} className="lecturn-panel-tile p-3">
              <p className="text-xs text-muted-foreground">
                {message.role === "user" ? "You" : "Assistant"}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm">
                {result.outcome === "exact" &&
                message.id === result.messageId &&
                result.start !== null &&
                result.end !== null ? (
                  <>
                    {message.text.slice(0, result.start)}
                    <mark>{message.text.slice(result.start, result.end)}</mark>
                    {message.text.slice(result.end)}
                  </>
                ) : (
                  message.text
                )}
              </p>
            </article>
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
