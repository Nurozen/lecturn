import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ThreadDecision,
  type DecisionEvidence,
  type ThreadDecisionExportResult,
} from "@lecturn/contracts";
import {
  decisionToMarkdown,
  decisionStatusLabel,
  assembleDecisionJsonExport,
} from "@lecturn/client-runtime/state/threadDecisions";
import { useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Share, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadDecisionEnvironment as decisions } from "../../state/thread-decisions";
import { environmentSession } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";

export type DecisionsRouteParams = { environmentId: string; projectId: string; threadId?: string };
function Button({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 justify-center rounded-lg border border-border px-3 py-2 disabled:opacity-40"
    >
      <Text className="text-foreground">{label}</Text>
    </Pressable>
  );
}

export function DecisionsRouteScreen({ route }: StaticScreenProps<DecisionsRouteParams>) {
  return (
    <DecisionsScreen
      key={`${route.params.environmentId}:${route.params.projectId}:${route.params.threadId ?? "all"}`}
      {...route.params}
    />
  );
}
function DecisionsScreen(params: DecisionsRouteParams) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(params.environmentId);
  const projectId = ProjectId.make(params.projectId);
  const threadId = params.threadId ? ThreadId.make(params.threadId) : undefined;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.threadDecisions === true;
  const access = useEnvironmentQuery(environmentSession.sessionStateAtom(environmentId));
  const canOperate =
    access.data?.authenticated === true &&
    access.data.scopes?.includes(AuthOrchestrationOperateScope) === true;
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<{ note: ThreadDecision; evidence: DecisionEvidence } | null>(
    null,
  );
  const filters = {
    projectId,
    ...(threadId ? { threadId } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(showAll ? { reviewState: "all" as const, lifecycle: "all" as const } : {}),
  };
  const list = useEnvironmentQuery(
    supported
      ? decisions.list({ environmentId, input: { ...filters, ...(cursor ? { cursor } : {}) } })
      : null,
  );
  const status = useEnvironmentQuery(
    supported
      ? decisions.status({ environmentId, input: { projectId, ...(threadId ? { threadId } : {}) } })
      : null,
  );
  const mutate = useAtomCommand(decisions.mutate);
  const exportPage = useAtomCommand(decisions.export);
  const review = async (
    note: ThreadDecision,
    reviewState: "confirmed" | "unreviewed" | "dismissed",
  ) => {
    setBusy(true);
    try {
      const result = await mutate({
        environmentId,
        input: {
          operation: "review",
          projectId,
          id: note.id,
          expectedRevision: note.revision,
          reviewState,
        },
      });
      if (result._tag !== "Success")
        Alert.alert("Could not update decision", "Refresh the list and try again.");
    } finally {
      setBusy(false);
    }
  };
  const exportAll = async (format: "markdown" | "json") => {
    if (!list.data) return;
    setBusy(true);
    try {
      const pages: ThreadDecisionExportResult[] = [];
      let next: string | undefined;
      do {
        const result = await exportPage({
          environmentId,
          input: {
            ...filters,
            format,
            expectedProjectRevision: list.data.projectRevision,
            ...(next ? { cursor: next } : {}),
          },
        });
        if (result._tag !== "Success") {
          Alert.alert(
            "Export changed",
            "Refresh and export again so the file contains one consistent version.",
          );
          return;
        }
        pages.push(result.value);
        next = result.value.nextCursor ?? undefined;
      } while (next);
      await Share.share({
        title: "Decisions",
        message:
          format === "json"
            ? assembleDecisionJsonExport(projectId, pages)
            : pages.map((page) => page.content).join("\n\n"),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="flex-1 bg-screen">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 14 }}
      >
        <Text className="text-2xl font-lecturn-bold text-foreground">Decisions</Text>
        {!supported ? (
          <Text className="text-muted-foreground">
            This environment does not support Decisions yet.
          </Text>
        ) : (
          <>
            <Text className="text-muted-foreground">
              {status.data ? decisionStatusLabel(status.data.processing) : "Loading status"}. Saved
              decisions remain available to read and share.
            </Text>
            <TextInput
              accessibilityLabel="Search decisions"
              placeholder="Search decisions"
              maxLength={500}
              value={search}
              onChangeText={(value) => {
                setSearch(value);
                setCursor(undefined);
              }}
              className="min-h-11 rounded-lg border border-border p-3 text-foreground"
            />
            <View className="flex-row flex-wrap gap-2">
              <Button
                label={showAll ? "Show current decisions" : "Include dismissed and superseded"}
                onPress={() => {
                  setShowAll(!showAll);
                  setCursor(undefined);
                }}
              />
              <Button
                label="Refresh"
                onPress={() => {
                  list.refresh();
                  status.refresh();
                }}
              />
              <Button
                label="Share Markdown"
                disabled={busy || !list.data}
                onPress={() => void exportAll("markdown")}
              />
              <Button
                label="Share JSON"
                disabled={busy || !list.data}
                onPress={() => void exportAll("json")}
              />
              {threadId ? (
                <Button
                  label="All project decisions"
                  onPress={() => navigation.navigate("Decisions", { environmentId, projectId })}
                />
              ) : null}
            </View>
            {list.error ? (
              <Text accessibilityRole="alert" className="text-destructive">
                {list.error}
              </Text>
            ) : null}
            {list.isPending ? (
              <Text className="text-muted-foreground">Loading decisions…</Text>
            ) : null}
            {!list.isPending && list.data?.decisions.length === 0 ? (
              <Text className="text-muted-foreground">
                No matching decisions. Configure tracking and history scans in Lecturn on your
                computer.
              </Text>
            ) : null}
            {list.data?.decisions.map((note) => (
              <View key={note.id} className="gap-3 rounded-xl border border-border p-4">
                <Text className="text-xl font-lecturn-bold text-foreground" selectable>
                  {note.title}
                </Text>
                <Text className="text-muted-foreground">
                  {note.reviewState} · {note.lifecycle} · {note.attribution.replaceAll("-", " ")}
                  {note.userEdited ? " · edited" : ""}
                </Text>
                <Text className="text-foreground" selectable>
                  {note.body}
                </Text>
                {note.rationale ? (
                  <Text className="text-muted-foreground" selectable>
                    {note.rationale}
                  </Text>
                ) : null}
                {note.comment ? (
                  <Text className="text-foreground" selectable>
                    Comment: {note.comment}
                  </Text>
                ) : null}
                <Text className="text-muted-foreground">
                  {note.threadTitle ?? "Deleted thread"} ·{" "}
                  {new Date(note.occurredAt).toLocaleString()}
                </Text>
                {note.evidence.map((evidence) => (
                  <Pressable
                    key={evidence.id}
                    accessibilityRole="button"
                    accessibilityLabel={`View source: ${evidence.quote}`}
                    onPress={() => setSource({ note, evidence })}
                    className="min-h-11 border-l-2 border-primary pl-3 py-2"
                  >
                    <Text className="text-foreground" selectable>
                      {evidence.quote}
                    </Text>
                    <Text className="text-muted-foreground">
                      View source · {evidence.availability}
                    </Text>
                  </Pressable>
                ))}
                <View className="flex-row flex-wrap gap-2">
                  <Button
                    label="Copy decision"
                    onPress={() =>
                      void tryCopyTextWithHaptic(decisionToMarkdown(note, environmentId))
                    }
                  />
                  {canOperate ? (
                    <>
                      <Button
                        label={note.reviewState === "confirmed" ? "Unconfirm" : "Confirm"}
                        disabled={busy}
                        onPress={() =>
                          void review(
                            note,
                            note.reviewState === "confirmed" ? "unreviewed" : "confirmed",
                          )
                        }
                      />
                      <Button
                        label={note.reviewState === "dismissed" ? "Restore" : "Dismiss"}
                        disabled={busy}
                        onPress={() =>
                          void review(
                            note,
                            note.reviewState === "dismissed" ? "unreviewed" : "dismissed",
                          )
                        }
                      />
                    </>
                  ) : null}
                </View>
                {note.relationships.length ? (
                  <Text className="text-muted-foreground">
                    {note.relationships
                      .map((relation) => `Replacement ${relation.state}`)
                      .join(" · ")}
                    . Review replacements on your computer.
                  </Text>
                ) : null}
              </View>
            ))}
            <View className="flex-row gap-2">
              {cursor ? <Button label="First page" onPress={() => setCursor(undefined)} /> : null}
              {list.data?.nextCursor ? (
                <Button label="Next page" onPress={() => setCursor(list.data!.nextCursor!)} />
              ) : null}
            </View>
          </>
        )}
      </ScrollView>
      {source ? (
        <DecisionSourceModal
          environmentId={environmentId}
          projectId={projectId}
          note={source.note}
          evidence={source.evidence}
          onClose={() => setSource(null)}
        />
      ) : null}
    </View>
  );
}
function DecisionSourceModal({
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
  const navigation = useNavigation();
  const source = useEnvironmentQuery(
    decisions.sourceWindow({
      environmentId,
      input: { projectId, decisionId: note.id, evidenceId: evidence.id },
    }),
  );
  const result = source.data;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View className="flex-1 bg-screen p-4">
        <Button label="Close source" onPress={onClose} />
        {result && result.outcome !== "unavailable" ? (
          <Button
            label="Open conversation"
            onPress={() => {
              onClose();
              navigation.navigate("Thread", { environmentId, threadId: evidence.threadId });
            }}
          />
        ) : null}
        <ScrollView contentContainerStyle={{ gap: 12, paddingVertical: 16 }}>
          <Text className="text-xl font-lecturn-bold text-foreground">Decision source</Text>
          <Text className="text-muted-foreground">
            {result?.outcome === "exact"
              ? "Exact passage"
              : result?.outcome === "message-only"
                ? "The source changed; the saved quote is shown below."
                : result?.outcome === "unavailable"
                  ? "The source is unavailable. Your saved evidence is retained."
                  : "Loading source…"}
          </Text>
          <Text selectable className="text-foreground">
            {evidence.quote}
          </Text>
          {source.error ? <Text className="text-destructive">{source.error}</Text> : null}
          {result?.messages.map((message) => (
            <View key={message.id} className="gap-2 border-t border-border py-3">
              <Text className="text-muted-foreground">{message.role}</Text>
              <Text selectable className="text-foreground">
                {message.id === result.messageId &&
                result.outcome === "exact" &&
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
        </ScrollView>
      </View>
    </Modal>
  );
}
