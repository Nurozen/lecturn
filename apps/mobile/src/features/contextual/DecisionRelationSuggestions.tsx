import type { DecisionId, EnvironmentId, ThreadDecision } from "@lecturn/contracts";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { contextualEnvironment } from "../../state/contextual";
import { threadDecisionEnvironment } from "../../state/thread-decisions";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomHex } from "../../lib/uuid";
import { ContextualButton as Button } from "./ContextualControls";
import { OccurrenceEvidence } from "./DecisionGroupPanel";

type Suggestion = NonNullable<ThreadDecision["relationSuggestions"]>[number];
type Props = {
  environmentId: EnvironmentId;
  note: ThreadDecision;
  canOperate: boolean;
  onChanged: () => void;
};
export function DecisionRelationSuggestions(props: Props) {
  return props.note.relationSuggestions?.map((suggestion) => (
    <SuggestionCard
      key={`${suggestion.id}:${props.note.revision}`}
      {...props}
      suggestion={suggestion}
    />
  ));
}
function SuggestionCard({
  environmentId,
  note,
  canOperate,
  onChanged,
  suggestion,
}: Props & {
  suggestion: Suggestion;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<{ decisionId: DecisionId; evidenceId: string } | null>(null);
  const other = useEnvironmentQuery(
    expanded
      ? threadDecisionEnvironment.get({
          environmentId,
          input: { projectId: note.projectId, id: suggestion.otherDecisionId },
        })
      : null,
  );
  const mutate = useAtomCommand(threadDecisionEnvironment.mutate);
  const merge = useAtomCommand(contextualEnvironment.mutateGroup);
  const stale =
    suggestion.decisionRevision !== note.revision ||
    (other.data !== null && suggestion.otherRevision !== other.data.revision);
  const actionable = canOperate && suggestion.state === "suggested" && !stale && !busy;
  async function resolve(action: "ignore" | "propose-replacement" | "merge") {
    if (!actionable) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        action === "merge" && other.data
          ? await merge({
              environmentId,
              input: (() => {
                const canonical = suggestion.canonicalDecisionId === note.id ? note : other.data;
                const occurrence = canonical.id === note.id ? other.data : note;
                return {
                  actionId: randomHex(16),
                  suggestionId: suggestion.id,
                  groupId: canonical.consolidation?.groupId ?? canonical.id,
                  expectedRevision: canonical.consolidation?.revision ?? 0,
                  canonicalDecisionId: canonical.id,
                  occurrenceId: occurrence.id,
                  expectedOccurrenceRevision: occurrence.revision,
                  action: "merge" as const,
                };
              })(),
            })
          : action !== "merge"
            ? await mutate({
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
              })
            : null;
      if (result?._tag === "Success") {
        onChanged();
        other.refresh();
      } else
        setError("These decisions changed or the request failed. Refresh before choosing again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <View className="gap-2 rounded-lg border border-border p-3">
      <Text className="font-lecturn-bold text-foreground">
        {suggestion.kind === "conflict" ? "Possible conflict" : "Possible equivalent decision"} ·{" "}
        {suggestion.state}
      </Text>
      <Text className="text-muted-foreground">
        {suggestion.kind === "conflict"
          ? "A replacement is proposed for separate approval; neither decision changes automatically."
          : "Consolidation keeps each occurrence and its evidence. It can be undone."}
      </Text>
      <Button
        label={expanded ? "Hide related decision" : "Inspect related decision"}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded && other.data ? (
        <View className="gap-2">
          <Text className="font-lecturn-bold text-foreground">{other.data.title}</Text>
          <Text className="text-muted-foreground">
            {other.data.attribution.replaceAll("-", " ")} · {other.data.reviewState} ·{" "}
            {other.data.lifecycle}
          </Text>
          <Text selectable className="text-foreground">
            {other.data.body}
          </Text>
          {other.data.evidence.map((evidence, index) => (
            <Button
              key={evidence.id}
              label={`Inspect related evidence ${index + 1}`}
              onPress={() =>
                setSource({ decisionId: suggestion.otherDecisionId, evidenceId: evidence.id })
              }
            />
          ))}
          {source ? (
            <OccurrenceEvidence
              environmentId={environmentId}
              projectId={note.projectId}
              {...source}
              onClose={() => setSource(null)}
            />
          ) : null}
        </View>
      ) : null}
      {stale ? (
        <Text className="text-muted-foreground">
          This suggestion is out of date. Refresh Decisions.
        </Text>
      ) : null}
      {(error ?? other.error) ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? other.error}
        </Text>
      ) : null}
      {canOperate && suggestion.state === "suggested" ? (
        <View className="gap-2">
          <Button
            label="Ignore suggestion"
            disabled={!actionable}
            onPress={() => void resolve("ignore")}
          />
          {suggestion.kind === "conflict" ? (
            <Button
              label="Propose this decision as replacement"
              disabled={!actionable || !other.data}
              onPress={() => void resolve("propose-replacement")}
            />
          ) : (
            <Button
              label="Consolidate equivalent decisions"
              disabled={!actionable || !other.data}
              onPress={() => void resolve("merge")}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}
