import { useNavigate } from "@tanstack/react-router";
import { canonicalDecisionText } from "@lecturn/shared/decisionEvidence";
import { assistantCitationNavigation } from "../lib/assistantCitationNavigation";
import { Button } from "./ui/button";
import type {
  DecisionEvidence,
  EnvironmentId,
  ProjectId,
  ThreadDecision,
} from "@lecturn/contracts";
import { useEnvironmentQuery } from "../state/query";
import { threadDecisionEnvironment } from "../state/threadDecisions";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "./ui/dialog";
import { decisionSourceHighlight } from "./DecisionsPanel.logic";

export function DecisionSourceDialog({
  environmentId,
  projectId,
  note,
  evidence,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  note: ThreadDecision;
  evidence: DecisionEvidence;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const source = useEnvironmentQuery(
    threadDecisionEnvironment.sourceWindow({
      environmentId,
      input: { projectId, decisionId: note.id, evidenceId: evidence.id },
    }),
  );
  const sourceHighlight = source.data
    ? decisionSourceHighlight(source.data, evidence.messageId)
    : null;
  const exact =
    sourceHighlight !== null &&
    canonicalDecisionText(sourceHighlight.quote).text === evidence.quote;
  function openThread() {
    if (!source.data || source.data.outcome === "unavailable") return;
    const message = source.data.messages.find((value) => value.id === evidence.messageId);
    onClose();
    if (message) {
      // Raw Markdown coordinates never identify a rendered DOM range. Keep the
      // verified excerpt in this dialog and target only the source message.
      void navigate(
        assistantCitationNavigation({
          version: 1,
          coordinateSpace: "raw-message",
          environmentId,
          threadId: evidence.threadId,
          messageId: evidence.messageId,
          text: evidence.quote,
          start: evidence.start,
          end: evidence.end,
          prefix: "",
          suffix: "",
        }),
      );
    } else
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: evidence.threadId },
      });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Decision evidence</DialogTitle>
          <DialogDescription>{note.title}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <blockquote className="border-l-2 border-primary pl-3 whitespace-pre-wrap text-sm">
            {evidence.quote}
          </blockquote>
          {source.isPending && !source.data ? <p role="status">Loading source…</p> : null}
          {source.error ? <p role="alert">{source.error}</p> : null}
          {source.data ? (
            <>
              <p className="text-xs text-muted-foreground" role="status">
                {source.data.outcome === "exact" && exact
                  ? "Exact source match"
                  : source.data.outcome === "message-only" || source.data.outcome === "exact"
                    ? "Source message found. The saved text no longer matches exactly."
                    : "Source unavailable. Your saved evidence is preserved."}
              </p>
              {source.data.outcome !== "unavailable" ? (
                <Button size="sm" variant="outline" onClick={openThread}>
                  Open source thread
                </Button>
              ) : null}
              {source.data.messages.map((message) => {
                const highlight = exact ? decisionSourceHighlight(source.data!, message.id) : null;
                return (
                  <article key={message.id} className="lecturn-panel-tile p-3">
                    <p className="mb-2 text-xs font-medium">
                      {message.role === "user" ? "You" : "Assistant"}
                    </p>
                    <div className="whitespace-pre-wrap break-words text-sm">
                      {highlight ? (
                        <>
                          {highlight.before}
                          <mark className="bg-primary/20 text-foreground">{highlight.quote}</mark>
                          {highlight.after}
                        </>
                      ) : (
                        message.text
                      )}
                    </div>
                  </article>
                );
              })}
            </>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
