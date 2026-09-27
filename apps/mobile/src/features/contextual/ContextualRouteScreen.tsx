import { contextualPreparationOutcome } from "@lecturn/client-runtime/state/contextual";
import { deliveredGroups } from "./contextualDisclosure";
import { ContextualHostSettings } from "./ContextualHostSettings";
import { useAtomValue } from "@effect/atom-react";
import {
  useNavigation,
  type NavigationProp,
  type StaticScreenProps,
} from "@react-navigation/native";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  MessageId,
  type ContextualConflict,
  type ContextualConflictResolution,
  type ContextualEvidence,
} from "@lecturn/contracts";
import { useState } from "react";
import { Linking, ScrollView, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { contextualEnvironment as contextual } from "../../state/contextual";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomHex } from "../../lib/uuid";
import { ContextualButton as Button, ContextualThreadControl } from "./ContextualControls";

export type ContextualRouteParams = {
  environmentId: string;
  threadId?: string;
  messageId?: string;
};
export function ContextualRouteScreen({ route }: StaticScreenProps<ContextualRouteParams>) {
  return (
    <ContextualScreen
      key={`${route.params.environmentId}:${route.params.threadId ?? "sources"}:${route.params.messageId ?? "all"}`}
      {...route.params}
    />
  );
}
function ContextualScreen(params: ContextualRouteParams) {
  const environmentId = EnvironmentId.make(params.environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.contextual === true;
  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, gap: 16 }}
    >
      <Text accessibilityRole="header" className="text-2xl font-lecturn-bold text-foreground">
        Contextual
      </Text>
      {!supported ? (
        <Text className="text-muted-foreground">
          This host does not support Contextual. Update Lecturn on the host to use this feature.
        </Text>
      ) : (
        <>
          {params.threadId ? (
            <ContextualThreadPanel
              environmentId={environmentId}
              threadId={ThreadId.make(params.threadId)}
              {...(params.messageId ? { messageId: MessageId.make(params.messageId) } : {})}
            />
          ) : null}
          <ContextualHostSettings environmentId={environmentId} />
        </>
      )}
    </ScrollView>
  );
}

export function ContextualThreadPanel({
  environmentId,
  threadId,
  messageId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  messageId?: MessageId;
}) {
  const access = useEnvironmentQuery(environmentSession.sessionStateAtom(environmentId));
  const canOperate = access.data?.scopes?.includes(AuthOrchestrationOperateScope) === true;
  const administer = access.data?.scopes?.includes(AuthAccessWriteScope) === true;
  const [sourceCursor, setSourceCursor] = useState<string | undefined>();
  const sources = useEnvironmentQuery(
    administer
      ? contextual.sources({
          environmentId,
          input: { limit: 50, ...(sourceCursor ? { cursor: sourceCursor } : {}) },
        })
      : null,
  );
  const status = useEnvironmentQuery(contextual.status({ environmentId, input: { threadId } }));
  const [cursor, setCursor] = useState<string | undefined>();
  const [conflictCursor, setConflictCursor] = useState<string | undefined>();
  const disclosures = useEnvironmentQuery(
    contextual.disclosures({
      environmentId,
      input: {
        threadId,
        ...(messageId ? { messageId } : {}),
        limit: 20,
        ...(cursor ? { cursor } : {}),
      },
    }),
  );
  const conflicts = useEnvironmentQuery(
    contextual.conflicts({
      environmentId,
      input: { threadId, limit: 20, ...(conflictCursor ? { cursor: conflictCursor } : {}) },
    }),
  );
  const refresh = useAtomCommand(contextual.refresh);
  const preparationAction = useAtomCommand(contextual.preparationAction);
  const projectUpdate = useAtomCommand(contextual.updateProjectSettings);
  const threadUpdate = useAtomCommand(contextual.updateThreadSettings);
  const exclude = useAtomCommand(contextual.exclude);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<{ _tag: string }>) => {
    setBusy(true);
    setError(null);
    try {
      if ((await work())._tag !== "Success")
        setError("The state changed or the request failed. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  };
  const data = status.data;
  const preparation = data?.preparation;
  return (
    <View className="gap-3">
      <ContextualThreadControl environmentId={environmentId} threadId={threadId} />
      {status.error ? <Text className="text-destructive">{status.error}</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error}
        </Text>
      ) : null}
      <Button
        label="Reload status and evidence"
        onPress={() => {
          status.refresh();
          conflicts.refresh();
          disclosures.refresh();
        }}
      />
      {data && canOperate ? (
        <>
          <Button
            label="Refresh context for next message"
            disabled={busy}
            onPress={() =>
              void run(() =>
                refresh({
                  environmentId,
                  input: {
                    threadId,
                    actionId: randomHex(16),
                    expectedRevision: data.thread.revision,
                  },
                }),
              )
            }
          />
          <Button
            label={
              data.project.defaultEnabled
                ? "Turn off for new project threads"
                : "Turn on for new project threads"
            }
            disabled={busy}
            onPress={() =>
              void run(() =>
                projectUpdate({
                  environmentId,
                  input: {
                    ...data.project,
                    expectedRevision: data.project.revision,
                    defaultEnabled: !data.project.defaultEnabled,
                  },
                }),
              )
            }
          />
          <Text className="font-lecturn-bold text-foreground">
            Sources permitted for this project
          </Text>
          {[
            {
              id: `decisions:${data.project.projectId}`,
              label: "Saved Decisions from this project",
            },
            ...(sources.data?.sources.filter((source) =>
              sources.data!.policy.allowedSourceIds.includes(source.id),
            ) ?? []),
          ].map((source) => (
            <Button
              key={source.id}
              label={`${data.project.sourceIds.includes(source.id) ? "Remove" : "Permit"}: ${source.label}`}
              disabled={busy}
              onPress={() =>
                void run(() =>
                  projectUpdate({
                    environmentId,
                    input: {
                      projectId: data.project.projectId,
                      expectedRevision: data.project.revision,
                      defaultEnabled: data.project.defaultEnabled,
                      sourceIds: data.project.sourceIds.includes(source.id)
                        ? data.project.sourceIds.filter((id) => id !== source.id)
                        : [...data.project.sourceIds, source.id],
                    },
                  }),
                )
              }
            />
          ))}
          {sources.data?.nextCursor ? (
            <Button
              label="More project source choices"
              onPress={() => setSourceCursor(sources.data!.nextCursor!)}
            />
          ) : null}
          {sourceCursor ? (
            <Button
              label="First project source choices"
              onPress={() => setSourceCursor(undefined)}
            />
          ) : null}
          {!administer ? (
            <Text className="text-muted-foreground">
              The host administrator can permit additional Slack sources for this project.
            </Text>
          ) : null}
          <Text className="font-lecturn-bold text-foreground">Sources for this thread</Text>
          <Text className="text-muted-foreground">
            Choose the permitted sources to use. No selection means no context is supplied.
          </Text>
          {data.permittedSources?.map((source) => (
            <Button
              key={source.id}
              label={`${data.thread.sourceIds.includes(source.id) ? "Selected" : "Select"}: ${source.label} · ${source.hostName}`}
              disabled={busy}
              onPress={() =>
                void run(() =>
                  threadUpdate({
                    environmentId,
                    input: {
                      threadId,
                      expectedRevision: data.thread.revision,
                      enabled: data.thread.enabled,
                      sourceIds: data.thread.sourceIds.includes(source.id)
                        ? data.thread.sourceIds.filter((id) => id !== source.id)
                        : [...data.thread.sourceIds, source.id],
                    },
                  }),
                )
              }
            />
          ))}
        </>
      ) : null}
      {preparation ? (
        <View className="gap-2 rounded-xl border border-border p-3">
          <Text className="text-foreground">
            {contextualPreparationOutcome(preparation) ??
              `Contextual: ${preparation.state.replaceAll("-", " ")}`}
          </Text>
          {!preparation.coverage.complete ? (
            <Text className="text-muted-foreground">
              Checks were bounded. Some evidence was not examined; this is not a guarantee of
              consistency.
            </Text>
          ) : null}
          {canOperate &&
          [
            "requested",
            "retrieving",
            "evaluating",
            "checking-conflicts",
            "awaiting-conflict-review",
            "prepared",
          ].includes(preparation.state) ? (
            <>
              <Button
                label="Send without context"
                disabled={busy}
                onPress={() =>
                  void run(() =>
                    preparationAction({
                      environmentId,
                      input: {
                        actionId: randomHex(16),
                        preparationId: preparation.id,
                        expectedRevision: preparation.revision,
                        action: "send-without-context",
                      },
                    }),
                  )
                }
              />
              <Button
                label="Cancel pending turn"
                disabled={busy}
                onPress={() =>
                  void run(() =>
                    preparationAction({
                      environmentId,
                      input: {
                        actionId: randomHex(16),
                        preparationId: preparation.id,
                        expectedRevision: preparation.revision,
                        action: "cancel",
                      },
                    }),
                  )
                }
              />
            </>
          ) : null}
        </View>
      ) : null}
      {conflicts.error ? <Text className="text-destructive">{conflicts.error}</Text> : null}
      {conflicts.data?.items.map((conflict) => (
        <ConflictCard
          key={`${conflict.id}:${conflict.revision}`}
          environmentId={environmentId}
          conflict={conflict}
          canOperate={canOperate}
        />
      ))}
      {conflicts.data?.nextCursor ? (
        <Button
          label="More conflicts"
          onPress={() => setConflictCursor(conflicts.data!.nextCursor!)}
        />
      ) : null}
      {conflictCursor ? (
        <Button label="First conflicts" onPress={() => setConflictCursor(undefined)} />
      ) : null}
      <Text accessibilityRole="header" className="text-xl font-lecturn-bold text-foreground">
        Supplied evidence
      </Text>
      {disclosures.error ? <Text className="text-destructive">{disclosures.error}</Text> : null}
      {disclosures.data?.items.length === 0 ? (
        <Text className="text-muted-foreground">No context has been supplied to this thread.</Text>
      ) : null}
      {disclosures.data?.items.map((item) => (
        <View key={item.receipt.id} className="gap-3 rounded-xl border border-border p-3">
          <Text className="text-muted-foreground">
            {item.receipt.acceptance} · {item.retention}
            {item.inherited ? " · inherited context" : ""}
            {item.messageId ? ` · message ${item.messageId}` : ""}
          </Text>
          {item.coverage && !item.coverage.complete ? (
            <Text className="text-muted-foreground">Partial evidence coverage</Text>
          ) : null}
          {deliveredGroups(item.packet?.groups ?? [], item.receipt).map((group) => (
            <View key={group.guidanceId} className="gap-2">
              {group.attribution ? (
                <Text className="text-foreground">{group.attribution.replaceAll("-", " ")}</Text>
              ) : null}
              <Text className="text-muted-foreground">
                {group.reasons
                  .map(
                    (reason) =>
                      ({
                        constraint: "Constraint",
                        decision: "Decision",
                        explanation: "Explanation",
                        conflict: "Conflicting information",
                      })[reason],
                  )
                  .join(" · ")}
              </Text>
              {group.evidence.map((evidence) => (
                <EvidenceCard key={evidence.id} evidence={evidence} />
              ))}
              {data && canOperate ? (
                <View className="flex-row flex-wrap gap-2">
                  <Button
                    label="Exclude from this thread"
                    disabled={busy}
                    onPress={() =>
                      void run(() =>
                        exclude({
                          environmentId,
                          input: {
                            actionId: randomHex(16),
                            threadId,
                            guidanceId: group.guidanceId,
                            excluded: true,
                            expectedRevision: data.thread.exclusionRevision,
                          },
                        }),
                      )
                    }
                  />
                  <Button
                    label="Allow in this thread again"
                    disabled={busy}
                    onPress={() =>
                      void run(() =>
                        exclude({
                          environmentId,
                          input: {
                            actionId: randomHex(16),
                            threadId,
                            guidanceId: group.guidanceId,
                            excluded: false,
                            expectedRevision: data.thread.exclusionRevision,
                          },
                        }),
                      )
                    }
                  />
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ))}
      {disclosures.data?.nextCursor ? (
        <Button label="Earlier evidence" onPress={() => setCursor(disclosures.data!.nextCursor!)} />
      ) : null}
      {cursor ? <Button label="Latest evidence" onPress={() => setCursor(undefined)} /> : null}
    </View>
  );
}

export function EvidenceCard({ evidence }: { evidence: ContextualEvidence }) {
  const navigation =
    useNavigation<NavigationProp<{ Thread: { environmentId: string; threadId: string } }>>();
  const locator = evidence.locator;
  return (
    <View className="gap-2 border-l-2 border-primary pl-3">
      <Text className="text-muted-foreground">
        {evidence.sourceKind === "slack" ? "Slack cache" : "Saved Decision"} · {evidence.author} ·{" "}
        {evidence.occurredAt} · observed {evidence.observedAt} · {evidence.availability}
      </Text>
      <Text className="text-muted-foreground">
        {locator.sourceKind === "slack"
          ? `${locator.workspaceId} / ${locator.channelId}`
          : `Project ${locator.projectId}, thread ${locator.threadId}`}
      </Text>
      <Text selectable className="text-foreground">
        {evidence.quote}
      </Text>
      {locator.sourceKind === "lecturn-decision" ? (
        <Button
          label="Open source conversation"
          onPress={() =>
            navigation.navigate("Thread", {
              environmentId: locator.environmentId,
              threadId: locator.threadId,
            })
          }
        />
      ) : evidence.sourceUrl &&
        /^https:\/\/(?:[a-z0-9-]+\.)?slack\.com\//i.test(evidence.sourceUrl) ? (
        <Button label="Open in Slack" onPress={() => void Linking.openURL(evidence.sourceUrl!)} />
      ) : null}
    </View>
  );
}
const choices: ReadonlyArray<[ContextualConflictResolution["action"], string]> = [
  ["use-left", "Use first for this task"],
  ["use-right", "Use second for this task"],
  ["different-scopes", "These apply to different scopes"],
  ["continue-unresolved", "Continue with conflict unresolved"],
  ["skip-context", "Skip context for this turn"],
  ["cancel-turn", "Cancel turn"],
];
function ConflictCard({
  environmentId,
  conflict,
  canOperate,
}: {
  environmentId: EnvironmentId;
  conflict: ContextualConflict;
  canOperate: boolean;
}) {
  const resolve = useAtomCommand(contextual.resolveConflict);
  const [clarification, setClarification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <Text accessibilityRole="header" className="font-lecturn-bold text-foreground">
        Conflicting guidance · {conflict.state}
      </Text>
      <Text className="text-muted-foreground">
        Your choice applies only to this task and does not replace saved project Decisions.
      </Text>
      {[conflict.pair.left, conflict.pair.right].map((claim, index) => (
        <View key={claim.id} className="gap-2">
          <Text className="font-lecturn-bold text-foreground">
            {index === 0 ? "First" : "Second"} · {claim.scope}
          </Text>
          {claim.evidence.map((e) => (
            <Text key={e.id} selectable className="text-foreground">
              {e.quote}
            </Text>
          ))}
        </View>
      ))}
      {error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error}
        </Text>
      ) : null}
      {canOperate && conflict.state === "awaiting-review" ? (
        <>
          <TextInput
            accessibilityLabel="Clarify scope"
            placeholder="Explain the different scopes"
            value={clarification}
            onChangeText={setClarification}
            maxLength={2000}
            multiline
            className="min-h-11 rounded-lg border border-border p-3 text-foreground"
          />
          {choices.map(([action, label]) => (
            <Button
              key={action}
              label={label}
              disabled={busy || (action === "different-scopes" && !clarification.trim())}
              onPress={async () => {
                setBusy(true);
                setError(null);
                try {
                  const result = await resolve({
                    environmentId,
                    input: {
                      actionId: randomHex(16),
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
                  if (result._tag !== "Success")
                    setError("This conflict changed. Reload before choosing again.");
                } finally {
                  setBusy(false);
                }
              }}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}
