import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import type {
  ContextualConflict,
  ContextualConflictResolution,
  ContextualClaim,
  EnvironmentId,
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

function Claim({ claim }: { claim: ContextualClaim }) {
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-border/70 bg-background/60 p-3">
      {claim.attribution ? <DecisionAttributionChip attribution={claim.attribution} /> : null}
      <p className="text-xs text-muted-foreground">
        Scope: {claim.scope || "Not specified"} · Applies:{" "}
        {claim.temporalApplicability || "Not specified"}
      </p>
      {claim.evidence.map((e) => (
        <div key={e.id}>
          <blockquote className="border-l-2 border-primary/40 pl-2 text-sm whitespace-pre-wrap break-words">
            {e.quote}
          </blockquote>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {e.sourceKind === "thread-message"
              ? `${e.messageRole} · current conversation`
              : `${e.author} · ${new Date(e.occurredAt).toLocaleString()} · ${e.availability}`}
          </p>
          {e.sourceKind !== "thread-message" &&
          e.sourceUrl &&
          e.sourceUrl.startsWith("https://") ? (
            <a
              href={e.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs underline underline-offset-4"
            >
              Open source
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}
export function ContextualConflictCard({
  environmentId,
  conflict,
}: {
  environmentId: EnvironmentId;
  conflict: ContextualConflict;
}) {
  const access = useContextualAccess(environmentId);
  const resolve = useAtomCommand(contextualEnvironment.resolveConflict, { reportFailure: false });
  const [clarification, setClarification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function choose(action: ContextualConflictResolution["action"]) {
    if (!access.operate || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await resolve({
        environmentId,
        input: {
          actionId: randomUUID(),
          conflictId: conflict.id,
          expectedRevision: conflict.revision,
          leftRevision: conflict.pair.left.revision,
          rightRevision: conflict.pair.right.revision,
          threadId: conflict.threadId,
          taskFingerprint: conflict.taskFingerprint,
          action,
          clarification: clarification.trim() || null,
        },
      });
      if (result._tag === "Failure")
        setError(contextualErrorMessage(squashAtomCommandFailure(result)));
    } finally {
      setBusy(false);
    }
  }
  const pending = conflict.state === "awaiting-review" || conflict.state === "possible";
  return (
    <article
      className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3"
      aria-label="Context conflict"
    >
      <div>
        <h3 className="text-sm font-medium">
          {pending ? "Which guidance applies to this task?" : `Conflict ${conflict.state}`}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          These claims may conflict. Your choice applies to this task and does not rewrite the
          source decisions.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Claim claim={conflict.pair.left} />
        <Claim claim={conflict.pair.right} />
      </div>
      {pending && access.operate ? (
        <>
          <label className="block text-xs text-muted-foreground">
            Clarification or scope distinction
            <textarea
              maxLength={2000}
              value={clarification}
              onChange={(event) => setClarification(event.target.value)}
              className="mt-1 block min-h-16 w-full resize-y rounded-lg border border-border bg-background p-2 text-sm text-foreground"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["use-left", "Use first claim"],
                ["use-right", "Use second claim"],
                ["different-scopes", "Apply to different scopes"],
                ["continue-unresolved", "Continue with both"],
                ["skip-context", "Skip disputed additions"],
                ["cancel-turn", "Cancel this turn"],
              ] as const
            ).map(([action, label]) => (
              <Button
                key={action}
                type="button"
                size="xs"
                variant="outline"
                disabled={busy || (action === "different-scopes" && !clarification.trim())}
                onClick={() => void choose(action)}
              >
                {label}
              </Button>
            ))}
          </div>
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Skipping additions cannot remove context already sent to the agent.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </article>
  );
}
export function ContextualPreparationPanel({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const available = useContextualAvailable(environmentId);
  const access = useContextualAccess(environmentId);
  const status = useEnvironmentQuery(
    available ? contextualEnvironment.status({ environmentId, input: { threadId } }) : null,
  );
  const conflicts = useEnvironmentQuery(
    available
      ? contextualEnvironment.conflicts({
          environmentId,
          input: {
            threadId,
            limit: 12,
            ...(status.data?.preparation ? { preparationId: status.data.preparation.id } : {}),
          },
        })
      : null,
  );
  const action = useAtomCommand(contextualEnvironment.preparationAction, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preparation = status.data?.preparation;
  const pending =
    preparation &&
    [
      "requested",
      "retrieving",
      "evaluating",
      "checking-conflicts",
      "awaiting-conflict-review",
    ].includes(preparation.state);
  async function act(operation: "send-without-context" | "cancel") {
    if (!preparation || !access.operate || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await action({
        environmentId,
        input: {
          actionId: randomUUID(),
          preparationId: preparation.id,
          expectedRevision: preparation.revision,
          action: operation,
        },
      });
      if (result._tag === "Failure")
        setError(contextualErrorMessage(squashAtomCommandFailure(result)));
    } finally {
      setBusy(false);
    }
  }
  if (!available || !preparation) return null;
  const held = preparation.state === "awaiting-conflict-review";
  if (!pending) return null;
  return (
    <section
      className="mb-2 space-y-2 rounded-xl border border-border bg-card p-3"
      aria-label="Context preparation"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium" role="status">
          {held ? "Needs your review · message waiting" : "Finding context…"}
        </p>
        {access.operate ? (
          <div className="flex gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void act("send-without-context")}
            >
              Send without context
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => void act("cancel")}
            >
              Cancel turn
            </Button>
          </div>
        ) : null}
      </div>
      {held ? (
        <p className="text-xs text-muted-foreground">
          This message stays on hold until you resolve the conflict, skip the new context, or
          cancel.
        </p>
      ) : null}
      {conflicts.data?.items
        .filter((c) => preparation.conflictIds.includes(c.id))
        .map((c) => (
          <ContextualConflictCard key={c.id} environmentId={environmentId} conflict={c} />
        ))}
      {held && conflicts.error ? (
        <p role="alert" className="text-xs text-destructive">
          Could not load the conflicting evidence. {conflicts.error}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
