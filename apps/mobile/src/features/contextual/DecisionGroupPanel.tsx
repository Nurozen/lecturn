import { threadDecisionEnvironment } from "../../state/thread-decisions";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import {
  DecisionEvidenceId,
  type EnvironmentId,
  type ThreadDecision,
  type DecisionId,
  type ProjectId,
} from "@lecturn/contracts";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { contextualEnvironment as contextual } from "../../state/contextual";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomHex } from "../../lib/uuid";
import { ContextualButton as Button } from "./ContextualControls";

export function DecisionGroupPanel({
  environmentId,
  note,
  canOperate,
  onChanged,
}: {
  environmentId: EnvironmentId;
  note: ThreadDecision;
  canOperate: boolean;
  onChanged: () => void;
}) {
  const navigation = useNavigation<
    NavigationProp<{
      Thread: { environmentId: string; threadId: string };
      Decisions: { environmentId: string; projectId: string; threadId?: string };
    }>
  >();
  const [source, setSource] = useState<{ decisionId: DecisionId; evidenceId: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consolidation = note.consolidation;
  const group = useEnvironmentQuery(
    expanded && consolidation
      ? contextual.group({
          environmentId,
          input: {
            projectId: note.projectId,
            groupId: consolidation.groupId,
            limit: 20,
            ...(cursor ? { cursor } : {}),
          },
        })
      : null,
  );
  const undo = useAtomCommand(contextual.undoGroup);
  if (!consolidation) return null;
  return (
    <View className="gap-2 border-t border-border pt-3">
      <Button
        label={`${expanded ? "Hide" : "Inspect"} ${consolidation.occurrenceCount} consolidated occurrences`}
        onPress={() => setExpanded(!expanded)}
      />
      {error || group.error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? group.error}
        </Text>
      ) : null}
      {expanded ? (
        <>
          <Text className="text-muted-foreground">
            Each occurrence retains its own author attribution, review state, edits and source
            evidence.
          </Text>
          {group.data?.occurrences.map((occurrence) => (
            <View key={occurrence.decisionId} className="gap-2 rounded-lg border border-border p-3">
              <Text className="font-lecturn-bold text-foreground">{occurrence.title}</Text>
              <Text className="text-muted-foreground">
                {occurrence.attribution.replaceAll("-", " ")} · {occurrence.reviewState} ·{" "}
                {occurrence.lifecycle}
                {occurrence.userEdited ? " · edited" : ""}
              </Text>
              <Text selectable className="text-foreground">
                {occurrence.body}
              </Text>
              {occurrence.rationale ? (
                <Text selectable className="text-muted-foreground">
                  {occurrence.rationale}
                </Text>
              ) : null}
              {occurrence.comment ? (
                <Text selectable className="text-foreground">
                  Comment: {occurrence.comment}
                </Text>
              ) : null}
              <Button
                label="Open occurrence conversation"
                onPress={() =>
                  navigation.navigate("Thread", { environmentId, threadId: occurrence.threadId })
                }
              />
              {occurrence.evidenceIds.map((evidenceId, index) => (
                <Button
                  key={evidenceId}
                  label={`Inspect supporting exchange ${index + 1}`}
                  onPress={() => setSource({ decisionId: occurrence.decisionId, evidenceId })}
                />
              ))}
            </View>
          ))}
          {source ? (
            <OccurrenceEvidence
              environmentId={environmentId}
              projectId={note.projectId}
              {...source}
              onClose={() => setSource(null)}
            />
          ) : null}
          {group.data?.nextCursor ? (
            <Button label="More occurrences" onPress={() => setCursor(group.data!.nextCursor!)} />
          ) : null}
          {cursor ? (
            <Button label="First occurrences" onPress={() => setCursor(undefined)} />
          ) : null}
        </>
      ) : null}
      {canOperate && consolidation.undo ? (
        <Button
          label="Undo consolidation"
          disabled={busy}
          onPress={async () => {
            setBusy(true);
            setError(null);
            try {
              const result = await undo({
                environmentId,
                input: {
                  actionId: randomHex(16),
                  groupId: consolidation.groupId,
                  mergeId: consolidation.undo!.mergeId,
                  expectedRevision: group.data?.revision ?? consolidation.revision,
                  expectedOccurrenceRevision: consolidation.undo!.expectedOccurrenceRevision,
                },
              });
              if (result._tag === "Success") onChanged();
              if (result._tag !== "Success")
                setError("The consolidation changed. Refresh Decisions and try again.");
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </View>
  );
}

export function OccurrenceEvidence({
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
    <View className="gap-2 rounded-lg border border-border p-3">
      <Button label="Close supporting exchange" onPress={onClose} />
      <Text className="text-muted-foreground">
        {result?.outcome === "exact"
          ? "Exact supporting passage"
          : result?.outcome === "message-only"
            ? "Source changed; exact passage is unavailable"
            : result?.outcome === "unavailable"
              ? "Source unavailable"
              : "Loading source…"}
      </Text>
      {source.error ? <Text className="text-destructive">{source.error}</Text> : null}
      {result?.messages.map((message) => (
        <View key={message.id} className="gap-1">
          <Text className="text-muted-foreground">{message.role}</Text>
          <Text selectable className="text-foreground">
            {result.outcome === "exact" &&
            message.id === result.messageId &&
            result.start !== null &&
            result.end !== null ? (
              <>
                {message.text.slice(0, result.start)}
                <Text className="bg-primary text-primary-foreground">
                  {message.text.slice(result.start, result.end)}
                </Text>
                {message.text.slice(result.end)}
              </>
            ) : (
              message.text
            )}
          </Text>
        </View>
      ))}
    </View>
  );
}
