import {
  contextualTranscriptOutcome,
  contextualDisclosurePreview,
} from "@lecturn/client-runtime/state/contextual";
import { Link } from "@tanstack/react-router";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import type {
  ContextualDisclosure as Disclosure,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@lecturn/contracts";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import {
  contextualEnvironment,
  contextualErrorMessage,
  useContextualAccess,
  useContextualAvailable,
} from "../../state/contextual";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { DecisionAttributionChip } from "../DecisionAttributionChip";
const reasonLabels = {
  constraint: "Constraint",
  decision: "Decision",
  explanation: "Explanation",
  conflict: "Conflicting information",
} as const;
export function ContextualDisclosureCard({
  environmentId,
  threadId,
  disclosure,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  disclosure: Disclosure;
}) {
  const access = useContextualAccess(environmentId);
  const status = useEnvironmentQuery(
    access.operate ? contextualEnvironment.status({ environmentId, input: { threadId } }) : null,
  );
  const exclude = useAtomCommand(contextualEnvironment.exclude, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { receipt, packet } = disclosure;
  const delivered = receipt.acceptance === "accepted" && receipt.evidenceIncluded;
  async function suppress(guidanceId: string, excluded: boolean) {
    if (!access.operate || !status.data || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await exclude({
        environmentId,
        input: {
          actionId: randomUUID(),
          threadId,
          guidanceId,
          excluded,
          expectedRevision: status.data.thread.exclusionRevision,
        },
      });
      if (r._tag === "Failure") setError(contextualErrorMessage(squashAtomCommandFailure(r)));
    } finally {
      setBusy(false);
    }
  }
  const groups =
    packet?.groups.filter((group) =>
      group.evidence.some((e) => receipt.suppliedEvidenceIds.includes(e.id)),
    ) ?? [];
  const inherited = "inherited" in disclosure && disclosure.inherited !== undefined;
  return (
    <details className="max-w-full rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        {inherited
          ? "Inherited context"
          : delivered
            ? "Context added"
            : receipt.acceptance === "unknown"
              ? "Context delivery uncertain"
              : receipt.disposition === "skipped"
                ? "No context was added"
                : "Context was not delivered"}
        {[
          [groups.filter((g) => g.attribution !== null).length, "decision"],
          [groups.filter((g) => g.attribution === null).length, "conversation"],
        ]
          .filter(([count]) => Number(count) > 0)
          .map(([count, label]) => ` · ${count} ${label}${count === 1 ? "" : "s"}`)
          .join("")}
      </summary>
      <div className="mt-3 space-y-3">
        {disclosure.coverage ? (
          <p className="text-muted-foreground">
            {disclosure.coverage.complete
              ? "Checked evidence coverage is complete."
              : "Partial evidence coverage."}
            {disclosure.coverage.missingAntecedents ? " Earlier context may be missing." : ""}
            {disclosure.coverage.truncated ? " Source content was truncated." : ""}
            {disclosure.coverage.unexaminedCount
              ? ` ${disclosure.coverage.unexaminedCount} candidates were not examined.`
              : ""}
          </p>
        ) : null}
        {packet?.purpose === "restored-after-compaction" ? (
          <p>Context restored after compaction</p>
        ) : null}
        {packet?.purpose === "refresh" ? <p>Context refreshed at your request</p> : null}
        {!packet ? (
          <p>
            Evidence is {disclosure.retention}. It may still be present in the agent’s conversation.
          </p>
        ) : null}
        {groups.map((group) => (
          <article key={group.guidanceId} className="space-y-2 border-t border-border/60 pt-2">
            {group.attribution ? <DecisionAttributionChip attribution={group.attribution} /> : null}
            <p className="text-muted-foreground">
              {group.reasons.map((r) => reasonLabels[r]).join(" · ")}
            </p>
            {group.evidence
              .filter((e) => receipt.suppliedEvidenceIds.includes(e.id))
              .map((e) => (
                <div key={e.id}>
                  <blockquote className="whitespace-pre-wrap break-words border-l-2 border-primary/30 pl-2 text-sm">
                    {e.quote}
                  </blockquote>
                  <p className="mt-1 text-muted-foreground">
                    {e.author} · {new Date(e.occurredAt).toLocaleString()} · observed{" "}
                    {new Date(e.observedAt).toLocaleString()}
                  </p>
                  <p className="break-all text-muted-foreground">
                    {e.locator.sourceKind === "slack"
                      ? `${e.locator.workspaceId} / ${e.locator.channelId}`
                      : `Decision from project ${e.locator.projectId}, thread ${e.locator.threadId}`}{" "}
                    · {e.availability}
                  </p>
                  {e.locator.sourceKind === "lecturn-decision" ? (
                    <Link
                      className="inline-block py-1 underline underline-offset-4"
                      to="/$environmentId/$threadId"
                      params={{
                        environmentId: e.locator.environmentId,
                        threadId: e.locator.threadId,
                      }}
                    >
                      Open source thread
                    </Link>
                  ) : null}
                  {e.sourceUrl && e.sourceUrl.startsWith("https://") ? (
                    <a
                      className="inline-block py-1 underline underline-offset-4"
                      href={e.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open source
                    </a>
                  ) : null}
                </div>
              ))}
            {access.operate ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy || !status.data}
                  onClick={() => void suppress(group.guidanceId, true)}
                >
                  Exclude from this thread
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy || !status.data}
                  onClick={() => void suppress(group.guidanceId, false)}
                >
                  Allow in this thread again
                </Button>
              </div>
            ) : null}
          </article>
        ))}
        <p className="text-muted-foreground">
          Only the evidence handed to the provider is shown. Excluding or forgetting it cannot
          retract text already sent.
        </p>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
export function ContextualMessageDisclosure({
  environmentId,
  threadId,
  messageId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  messageId: MessageId;
}) {
  const available = useContextualAvailable(environmentId);
  const query = useEnvironmentQuery(
    available
      ? contextualEnvironment.disclosures({
          environmentId,
          input: { threadId, messageId, limit: 50 },
        })
      : null,
  );
  const status = useEnvironmentQuery(
    available ? contextualEnvironment.status({ environmentId, input: { threadId } }) : null,
  );
  const preparation = query.data?.preparation ?? status.data?.preparation;
  const outcome =
    preparation?.task.messageId === messageId ? contextualTranscriptOutcome(preparation) : null;
  const items =
    query.data?.items.filter(
      (d) =>
        d.messageId === messageId ||
        d.packet?.task.messageId === messageId ||
        ("inherited" in d && d.inherited?.messageId === messageId),
    ) ?? [];
  if (!items.length && !outcome) return null;
  return (
    <article
      aria-label="Contextual message"
      data-message-type="contextual"
      data-chat-contextual-message
      className="mt-2 w-full max-w-[80%] self-start rounded-2xl px-4 py-3 text-sm text-foreground space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold tracking-wide text-primary">Contextual</span>
        <span className="text-[11px] text-muted-foreground">For this message</span>
      </div>
      {outcome ? (
        <p className="text-xs leading-relaxed text-muted-foreground" role="status">
          {outcome}{" "}
          <Link
            to="/contextual/$environmentId"
            params={{ environmentId }}
            className="font-medium text-primary underline underline-offset-2"
          >
            Review Contextual settings
          </Link>
        </p>
      ) : null}
      {items.map((d) => (
        <div key={d.receipt.id} className="space-y-2">
          {contextualDisclosurePreview(d) ? (
            <p className="whitespace-pre-wrap leading-relaxed">{contextualDisclosurePreview(d)}</p>
          ) : null}
          <ContextualDisclosureCard
            environmentId={environmentId}
            threadId={threadId}
            disclosure={d}
          />
        </div>
      ))}
    </article>
  );
}
