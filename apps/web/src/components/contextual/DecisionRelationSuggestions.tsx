import { useState } from "react";
import type { DecisionEvidence, EnvironmentId, ThreadDecision } from "@lecturn/contracts";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { threadDecisionEnvironment } from "../../state/threadDecisions";
import { contextualEnvironment } from "../../state/contextual";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { DecisionAttributionChip } from "../DecisionAttributionChip";
import { DecisionSourceDialog } from "../DecisionSourceDialog";

type Suggestion = NonNullable<ThreadDecision["relationSuggestions"]>[number];
export function DecisionRelationSuggestions({
  environmentId,
  note,
  canOperate,
  onChange,
}: {
  environmentId: EnvironmentId;
  note: ThreadDecision;
  canOperate: boolean;
  onChange: () => void;
}) {
  return (
    <>
      {note.relationSuggestions
        ?.filter((value) => value.state === "suggested")
        .map((suggestion) => (
          <RelationSuggestion
            key={suggestion.id}
            {...{ environmentId, note, canOperate, onChange, suggestion }}
          />
        ))}
    </>
  );
}
function RelationSuggestion({
  environmentId,
  note,
  canOperate,
  onChange,
  suggestion,
}: {
  environmentId: EnvironmentId;
  note: ThreadDecision;
  canOperate: boolean;
  onChange: () => void;
  suggestion: Suggestion;
}) {
  const [expanded, setExpanded] = useState(false);
  const [source, setSource] = useState<{ note: ThreadDecision; evidence: DecisionEvidence } | null>(
    null,
  );
  const other = useEnvironmentQuery(
    expanded
      ? threadDecisionEnvironment.get({
          environmentId,
          input: { projectId: note.projectId, id: suggestion.otherDecisionId },
        })
      : null,
  );
  const mutate = useAtomCommand(threadDecisionEnvironment.mutate, { reportFailure: false });
  const combine = useAtomCommand(contextualEnvironment.mutateGroup, { reportFailure: false });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const stale =
    note.revision !== suggestion.decisionRevision ||
    (other.data && other.data.revision !== suggestion.otherRevision);
  async function act(action: "ignore" | "propose-replacement" | "combine") {
    if (!canOperate || busy || stale) return;
    setBusy(true);
    setError(null);
    try {
      let result;
      if (action === "combine") {
        if (!other.data) return;
        const canonical = suggestion.canonicalDecisionId === note.id ? note : other.data;
        const occurrence = canonical.id === note.id ? other.data : note;
        result = await combine({
          environmentId,
          input: {
            actionId: randomUUID(),
            groupId: canonical.consolidation?.groupId ?? canonical.id,
            expectedRevision: canonical.consolidation?.revision ?? 0,
            canonicalDecisionId: canonical.id,
            occurrenceId: occurrence.id,
            expectedOccurrenceRevision: occurrence.revision,
            action: "merge",
            suggestionId: suggestion.id,
          },
        });
      } else
        result = await mutate({
          environmentId,
          input: {
            operation: "resolve-suggestion",
            projectId: note.projectId,
            id: note.id,
            expectedRevision: note.revision,
            suggestionId: suggestion.id,
            expectedOtherRevision: suggestion.otherRevision,
            action,
          },
        });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error ? cause.message : "The decisions changed. Refresh and try again.",
        );
      } else onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this suggestion.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-3 rounded-lg border border-border p-3 text-xs">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {suggestion.kind === "equivalent"
          ? "Possible matching decision"
          : "Possible conflicting decision"}
      </Button>
      {expanded ? (
        <div className="mt-2 space-y-2">
          <p className="text-muted-foreground">
            Review both choices and their evidence before changing their relationship.
          </p>
          {other.isPending && !other.data ? <p role="status">Loading other decision…</p> : null}
          {other.error ? <p role="alert">{other.error}</p> : null}
          {[note, ...(other.data ? [other.data] : [])].map((value) => (
            <article key={value.id} className="space-y-1 border-t border-border/50 pt-2">
              <p className="font-medium">{value.title}</p>
              <DecisionAttributionChip attribution={value.attribution} />
              <p className="whitespace-pre-wrap">{value.body}</p>
              {value.evidence.map((evidence, index) => (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  key={evidence.id}
                  onClick={() => setSource({ note: value, evidence })}
                >
                  Inspect evidence {index + 1}
                </Button>
              ))}
            </article>
          ))}
          {stale ? (
            <p role="status">A decision changed. Refresh to review its current relationship.</p>
          ) : null}
          {canOperate ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy || Boolean(stale) || !other.data}
                onClick={() =>
                  void act(suggestion.kind === "equivalent" ? "combine" : "propose-replacement")
                }
              >
                {suggestion.kind === "equivalent"
                  ? "Combine occurrences"
                  : "Propose this decision as replacement"}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy || Boolean(stale)}
                onClick={() => void act("ignore")}
              >
                Ignore suggestion
              </Button>
            </div>
          ) : null}
          {suggestion.kind === "conflict" ? (
            <p className="text-muted-foreground">
              A proposal needs separate approval before it supersedes the earlier choice.
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {source ? (
        <DecisionSourceDialog
          environmentId={environmentId}
          projectId={note.projectId}
          {...source}
          onClose={() => setSource(null)}
        />
      ) : null}
    </section>
  );
}
