import { ArcaneBackdrop } from "../../components/ArcaneBackdrop";
import { GlassCard } from "../../components/GlassCard";
import { WatchActivityFrame, WatchCheckSegments } from "./WatchActivityVisuals";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { cardIsVisible } from "./watch-visuals";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import {
  mergeHandoffMessage,
  selectMergeHandoffThread,
} from "@lecturn/client-runtime/state/pullRequestHandoff";
import { useThreadDetail } from "../../state/queries";
import {
  activityVisualColor,
  activityVisualState,
  activityVisualPresentation,
  describeThreadActivity,
  threadActivityExcerpt,
} from "@lecturn/client-runtime/state/activityContext";
import { useMobileSagaIndex } from "../../state/stave";
import { isRepositoryWatchManagerEligible } from "@lecturn/client-runtime/state/repositoryScope";
import { useNavigation, useIsFocused, type StaticScreenProps } from "@react-navigation/native";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  type PullRequestWatchCommandInput,
  type ThreadId,
} from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { uuidv4 } from "../../lib/uuid";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  useThreadShell,
  useThreadShells,
  useProjects,
  useEnvironmentServerConfig,
} from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { pullRequestWatchEnvironment } from "../../state/pull-request-watch";
import { environmentSession } from "../../state/session";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";

function Action(props: {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly icon?: AppSymbolName;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 justify-center rounded-full border border-border bg-glass-surface px-4 py-2 active:bg-subtle-strong disabled:opacity-40"
    >
      <View className="flex-row items-center gap-2">
        {props.icon ? (
          <SymbolView name={props.icon} size={18} tintColorClassName="accent-primary" />
        ) : null}
        <Text className="text-primary font-lecturn-medium">{props.label}</Text>
      </View>
    </Pressable>
  );
}

function Disclosure(props: {
  label: string;
  icon: AppSymbolName;
  children: ReactNode;
  summary?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <GlassCard radius={22}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${props.label}${props.summary ? `, ${props.summary}` : ""}`}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-14 flex-row items-center gap-2.5 px-4 py-3"
      >
        <SymbolView name={props.icon} size={19} tintColorClassName="accent-primary" />
        <Text className="font-lecturn-medium text-foreground">{props.label}</Text>
        <Text className="flex-1 text-right text-xs text-foreground-muted" numberOfLines={1}>
          {props.summary}
        </Text>
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={13}
          tintColorClassName="accent-foreground-muted"
        />
      </Pressable>
      {expanded ? <View className="gap-3 px-4 pb-4">{props.children}</View> : null}
    </GlassCard>
  );
}

function StatusCue(props: {
  icon: AppSymbolName;
  label: string;
  value: string;
  tone?: "good" | "bad" | "pending" | "neutral";
}) {
  const { themeAppearance } = useAppearancePreferences();
  return (
    <View
      accessible
      accessibilityLabel={`${props.label}: ${props.value}`}
      className="flex-row items-center gap-1.5 rounded-full border border-border-subtle bg-glass-surface px-3 py-2"
    >
      <SymbolView
        name={props.icon}
        size={16}
        tintColor={
          props.tone === "good"
            ? activityVisualColor("complete", themeAppearance)
            : props.tone === "bad"
              ? activityVisualColor("failed", themeAppearance)
              : props.tone === "pending"
                ? activityVisualColor("active", themeAppearance)
                : activityVisualColor("idle", themeAppearance)
        }
      />
      <Text className="text-xs text-foreground-muted">{props.value}</Text>
    </View>
  );
}

function checkIcon(status: string): AppSymbolName {
  return status === "success"
    ? "checkmark.circle"
    : status === "action-required"
      ? "exclamationmark.triangle"
      : status === "failure"
        ? "xmark.circle.fill"
        : status === "pending"
          ? "clock"
          : "ellipsis.circle";
}

function ManagerChoice(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const thread = useThreadShell({ environmentId: props.environmentId, threadId: props.threadId });
  if (!thread) return null;
  return (
    <Action
      label={thread.title}
      accessibilityLabel={`${props.selected ? "Managing: " : "Assign manager: "}${thread.title}`}
      icon={props.selected ? "checkmark.circle" : "text.bubble"}
      disabled={props.disabled}
      onPress={props.onPress}
    />
  );
}

/** URLs select a watch only. Every write requires the authenticated session and a user action. */
export function PullRequestWatchRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; watchId: string }>) {
  return (
    <View className="flex-1 bg-screen">
      <ArcaneBackdrop />
      <PullRequestWatchControls
        key={`${route.params.environmentId}:${route.params.watchId}`}
        environmentId={EnvironmentId.make(route.params.environmentId)}
        watchId={route.params.watchId}
      />
    </View>
  );
}

function PullRequestWatchControls({
  environmentId,
  watchId,
}: {
  readonly environmentId: EnvironmentId;
  readonly watchId: string;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const navigation = useNavigation();
  const focused = useIsFocused();
  const projects = useProjects();
  const config = useEnvironmentServerConfig(environmentId);
  const [viewport, setViewport] = useState({ y: 0, height: 0 });
  const [cardLayouts, setCardLayouts] = useState<Record<string, { y: number; height: number }>>({});
  const sagaIndex = useMobileSagaIndex(projects, true);
  const threads = useThreadShells();
  const runtime = useRemoteEnvironmentRuntime(environmentId);
  const access = useEnvironmentQuery(environmentSession.sessionStateAtom(environmentId));
  const connected = runtime?.connectionState === "connected";
  const authenticated = access.data?.authenticated === true;
  const canOperate =
    connected &&
    authenticated &&
    access.data?.scopes?.includes(AuthOrchestrationOperateScope) === true;
  const query = useEnvironmentQuery(
    authenticated && connected
      ? pullRequestWatchEnvironment.list({ environmentId, input: {} })
      : null,
  );
  const watch = query.data?.watches.find((item) => item.id === watchId);
  const manager = useThreadShell(
    watch?.managerThreadId ? { environmentId, threadId: watch.managerThreadId } : null,
  );
  const managerDetail = useThreadDetail(
    focused && connected && authenticated && manager ? environmentId : null,
    focused && connected && authenticated ? (manager?.id ?? null) : null,
  );
  const runCommand = useAtomCommand(pullRequestWatchEnvironment.command, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [steer, setSteer] = useState("");
  const [queued, setQueued] = useState(false);
  const [mergeQueuedTo, setMergeQueuedTo] = useState<string | null>(null);
  const observation = watch?.observation;
  const eligibleManagers = watch
    ? threads.filter(
        (thread) =>
          !thread.archivedAt &&
          isRepositoryWatchManagerEligible({ projects, sagaIndex, environmentId, thread, watch }),
      )
    : [];
  const recipient = watch ? selectMergeHandoffThread(watch, eligibleManagers) : null;
  const legacyAuthorization =
    watch?.authorization && !["merged", "needs-authorization"].includes(watch.authorization.status);
  // Keep the current access and target available before dispatch.
  const current = useRef({ canOperate, watch });
  useEffect(() => {
    current.current = { canOperate, watch };
  }, [canOperate, current, watch]);

  const command = async (input: Omit<PullRequestWatchCommandInput, "requestId" | "watchId">) => {
    if (!current.current.canOperate || !current.current.watch || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await runCommand({
        environmentId,
        input: { ...input, watchId, requestId: uuidv4() },
      });
      if (result._tag === "Failure") {
        const failure = Cause.squash(result.cause);
        setError(
          failure instanceof Error ? failure.message : "Could not update the pull request watch.",
        );
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const sendMergeHandoff = async () => {
    if (!canOperate || !watch || !recipient || legacyAuthorization || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // This explicit handoff assigns the sole associated recipient before
      // delivery, so subsequent monitoring identifies who owns the work.
      if (watch.managerThreadId === null) {
        const assignment = await runCommand({
          environmentId,
          input: {
            requestId: uuidv4(),
            watchId,
            action: "set-manager",
            managerThreadId: recipient.id,
            expectedBinding: watch.binding,
          },
        });
        if (assignment._tag === "Failure") {
          const failure = Cause.squash(assignment.cause);
          throw failure instanceof Error
            ? failure
            : new Error("Could not assign the managing thread. Merge instructions were not sent.");
        }
      }
      const metadata = makeQueuedMessageMetadata();
      await enqueueThreadOutboxMessage({
        environmentId,
        threadId: recipient.id,
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text: mergeHandoffMessage(watch),
        attachments: [],
        createdAt: metadata.createdAt,
      });
      setMergeQueuedTo(recipient.title);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not queue merge instructions.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const sendSteer = async () => {
    const text = steer.trim();
    if (!canOperate || !manager || !text || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const metadata = makeQueuedMessageMetadata();
      await enqueueThreadOutboxMessage({
        environmentId,
        threadId: manager.id,
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text,
        attachments: [],
        createdAt: metadata.createdAt,
      });
      setSteer((value) => (value.trim() === text ? "" : value));
      setQueued(true);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save the message. Your text is still here.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const managerProject = manager
    ? projects.find(
        (project) => project.environmentId === environmentId && project.id === manager.projectId,
      )
    : null;
  const managerProvider = config?.providers.find(
    (provider) =>
      provider.instanceId ===
      (manager?.session?.providerInstanceId ?? manager?.modelSelection.instanceId),
  );
  const managerVisualState = activityVisualState({
    status: !connected
      ? "offline"
      : manager?.hasPendingApprovals
        ? "approval"
        : manager?.hasPendingUserInput
          ? "needs input"
          : (manager?.session?.status ?? watch?.managerStatus ?? "idle"),
    settled: manager?.settledOverride === "settled",
  });
  const prVisualState = activityVisualState({
    status: !connected
      ? "offline"
      : [
          watch?.error ? "error" : "",
          observation?.state ?? "",
          observation?.checksState ?? "unknown",
          manager?.hasPendingApprovals ? "approval" : "",
          manager?.hasPendingUserInput ? "needs input" : "",
          manager?.session?.status ??
            (watch?.managerStatus === "offline" ? "idle" : (watch?.managerStatus ?? "idle")),
        ].join(" "),
    checks: observation?.checks ?? [],
  });

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-transparent"
      contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 32 }}
      keyboardShouldPersistTaps="handled"
      onLayout={({ nativeEvent }) =>
        setViewport((current) => ({ ...current, height: nativeEvent.layout.height }))
      }
      onScroll={({ nativeEvent }) =>
        setViewport({
          y: nativeEvent.contentOffset.y,
          height: nativeEvent.layoutMeasurement.height,
        })
      }
      scrollEventThrottle={160}
    >
      {!connected || !authenticated ? (
        <View className="gap-3">
          <Text className="text-foreground">
            Connect to this environment to view current pull request state and controls.
          </Text>
          <Action label="Open connections" onPress={() => navigation.navigate("Connections")} />
        </View>
      ) : null}
      {query.error || error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? query.error}
        </Text>
      ) : null}
      {connected && authenticated && !watch ? (
        <Text className="text-foreground-muted">
          {query.isPending ? "Loading pull request…" : "This pull request watch is unavailable."}
        </Text>
      ) : null}
      {watch ? (
        <>
          <WatchActivityFrame
            state={prVisualState}
            visible={
              focused && connected && watch.watching && cardIsVisible(cardLayouts.pr, viewport)
            }
            onLayout={({ nativeEvent }) =>
              setCardLayouts((current) => ({ ...current, pr: nativeEvent.layout }))
            }
          >
            <Text className="text-xl font-lecturn-bold text-foreground">
              #{watch.reference.number} · {watch.reference.repository}
            </Text>
            <Text className="text-foreground">
              {observation?.title ?? "Waiting for the first observation"}
            </Text>
            <View className="flex-row flex-wrap items-center gap-2">
              <StatusCue
                icon="arrow.triangle.pull"
                label="Pull request"
                value={observation?.state ?? "Unknown"}
              />
              <StatusCue
                icon={
                  observation?.checksState === "passing"
                    ? "checkmark.circle"
                    : observation?.checksState === "failing"
                      ? "xmark.circle.fill"
                      : observation?.checksState === "pending"
                        ? "clock"
                        : "ellipsis.circle"
                }
                label="CI"
                value={`CI ${observation?.checksState ?? "unknown"}`}
                tone={
                  observation?.checksState === "passing"
                    ? "good"
                    : observation?.checksState === "failing"
                      ? "bad"
                      : observation?.checksState === "pending"
                        ? "pending"
                        : "neutral"
                }
              />
              <StatusCue
                icon={watch.watching ? "eye" : "stop.fill"}
                label="Watch"
                value={watch.watching ? "Watching" : "Paused"}
              />
            </View>
            <WatchCheckSegments checks={observation?.checks ?? []} />
          </WatchActivityFrame>
          {manager ? (
            <WatchActivityFrame
              state={managerVisualState}
              visible={focused && connected && cardIsVisible(cardLayouts.manager, viewport)}
              onLayout={({ nativeEvent }) =>
                setCardLayouts((current) => ({ ...current, manager: nativeEvent.layout }))
              }
            >
              <View className="flex-row items-center gap-2">
                {managerProject ? (
                  <ProjectFavicon
                    environmentId={environmentId}
                    projectTitle={managerProject.title}
                    workspaceRoot={managerProject.workspaceRoot}
                    faviconPath={managerProject.faviconPath}
                    size={19}
                  />
                ) : null}
                <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                  {managerProject?.title ?? "Managing thread"}
                </Text>
                <ProviderIcon provider={managerProvider?.driver} size={18} />
                <Text
                  accessibilityLabel={activityVisualPresentation[managerVisualState].label}
                  style={{
                    color: activityVisualColor(managerVisualState, themeAppearance),
                    fontSize: 18,
                  }}
                >
                  {activityVisualPresentation[managerVisualState].glyph}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open managing thread: ${manager.title}`}
                onPress={() =>
                  navigation.navigate("Thread", { environmentId, threadId: manager.id })
                }
              >
                <Text className="font-lecturn-medium text-foreground" numberOfLines={2}>
                  {manager.title}
                </Text>
              </Pressable>
              <Text className="text-sm text-foreground-muted" numberOfLines={3}>
                {threadActivityExcerpt(manager, managerDetail.data?.messages)}
              </Text>
            </WatchActivityFrame>
          ) : null}
          {manager ? (
            <GlassCard className="gap-3 p-4">
              <View className="flex-row items-center gap-2">
                <SymbolView
                  name="square.and.pencil"
                  size={18}
                  tintColorClassName="accent-primary"
                />
                <Text accessibilityRole="header" className="font-lecturn-medium text-foreground">
                  Steer
                </Text>
                <Text
                  className="min-w-0 flex-1 text-right text-xs text-foreground-muted"
                  numberOfLines={1}
                >
                  {manager.title}
                </Text>
              </View>
              <Text className="text-foreground-muted">
                {describeThreadActivity(manager, managerDetail.data?.messages)}
              </Text>
              <TextInput
                accessibilityLabel="Instructions for managing thread"
                placeholder="What should the agent do next?"
                multiline
                value={steer}
                onChangeText={(value) => {
                  setSteer(value);
                  setQueued(false);
                }}
                editable={canOperate}
                className="min-h-24 rounded-2xl border border-border bg-glass-surface p-3 text-foreground"
              />
              <Action
                label="Send"
                accessibilityLabel={`Queue instructions for ${manager.title}`}
                icon="arrow.up"
                disabled={!canOperate || busy || !steer.trim()}
                onPress={() => {
                  void sendSteer();
                }}
              />
              {queued ? (
                <View accessibilityLiveRegion="polite" className="flex-row items-center gap-2">
                  <SymbolView
                    name="checkmark.circle"
                    size={16}
                    tintColorClassName="accent-primary"
                  />
                  <Text className="text-sm text-foreground-muted">Instructions queued</Text>
                </View>
              ) : null}
            </GlassCard>
          ) : null}
          {watch.error || watch.authorization?.message ? (
            <Text className="text-destructive">{watch.error ?? watch.authorization?.message}</Text>
          ) : null}
          {!canOperate ? (
            <Text className="text-foreground-muted">
              This connection needs permission to operate the environment before changing the watch
              or sending instructions.
            </Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            <Action
              label="Refresh"
              icon="arrow.clockwise"
              disabled={!canOperate || busy}
              onPress={() => {
                void command({ action: "refresh" });
              }}
            />
            <Action
              label={watch.watching ? "Pause" : "Resume"}
              icon={watch.watching ? "stop.fill" : "eye"}
              accessibilityLabel={watch.watching ? "Pause watching" : "Resume watching"}
              disabled={!canOperate || busy}
              onPress={() => {
                void command({ action: watch.watching ? "pause" : "resume" });
              }}
            />
            {observation?.url ? (
              <Action
                label="PR"
                icon="safari"
                accessibilityLabel="Open pull request"
                onPress={() => {
                  void tryOpenExternalUrl(observation.url, "pull-request");
                }}
              />
            ) : null}
          </View>
          <Disclosure
            label="CI jobs"
            icon="server.rack"
            summary={`${observation?.checks.filter((check) => check.status === "success").length ?? 0}/${observation?.checks.length ?? 0} passed`}
          >
            <Text className="text-xs text-foreground-muted">
              Required checks: {observation?.requiredChecks ?? "unknown"}
            </Text>
            {observation?.checks.length ? (
              observation.checks.map((check) => (
                <Pressable
                  key={`${check.name}:${check.url ?? check.description ?? ""}`}
                  accessibilityRole={check.url ? "link" : "text"}
                  accessibilityLabel={`${check.name}: ${check.status}${check.description ? `. ${check.description}` : ""}`}
                  disabled={!check.url}
                  onPress={() => {
                    if (check.url) void tryOpenExternalUrl(check.url, "pull-request");
                  }}
                  className="min-h-12 flex-row items-center gap-2 rounded-2xl border border-border-subtle bg-glass-surface px-3 py-2"
                >
                  <SymbolView
                    name={checkIcon(check.status)}
                    size={18}
                    tintColor={
                      check.status === "success"
                        ? activityVisualColor("complete", themeAppearance)
                        : check.status === "failure"
                          ? activityVisualColor("failed", themeAppearance)
                          : check.status === "action-required"
                            ? activityVisualColor("attention", themeAppearance)
                            : check.status === "pending"
                              ? activityVisualColor("active", themeAppearance)
                              : activityVisualColor("idle", themeAppearance)
                    }
                  />
                  <View className="flex-1">
                    <Text className="text-sm text-foreground">{check.name}</Text>
                    {check.description ? (
                      <Text className="text-xs text-foreground-muted">{check.description}</Text>
                    ) : null}
                  </View>
                  <Text className="text-xs text-foreground-muted">{check.status}</Text>
                  {check.url ? (
                    <SymbolView
                      name="arrow.up.right"
                      size={12}
                      tintColorClassName="accent-foreground-muted"
                    />
                  ) : null}
                </Pressable>
              ))
            ) : (
              <Text className="text-foreground-muted">No checks reported yet.</Text>
            )}
          </Disclosure>
          <Action
            label="Merge when ready"
            icon="arrow.triangle.branch"
            disabled={
              !canOperate ||
              busy ||
              observation?.state !== "open" ||
              !recipient ||
              !!legacyAuthorization
            }
            onPress={() => void sendMergeHandoff()}
          />
          <Text className="text-foreground-muted" accessibilityLiveRegion="polite">
            {mergeQueuedTo
              ? `Queued for ${mergeQueuedTo}`
              : recipient
                ? `Send to ${recipient.title}`
                : "Choose a managing thread below"}
          </Text>
          {watch.authorization ? (
            <>
              {legacyAuthorization ? (
                <Text className="text-foreground-muted">
                  Revoke automatic merging before handing off.
                </Text>
              ) : null}
              <Action
                label="Revoke automatic merge"
                disabled={!canOperate || busy}
                onPress={() => void command({ action: "revoke-merge" })}
              />
            </>
          ) : null}
          <Disclosure
            label="Manager"
            icon="person.crop.circle"
            summary={manager?.title ?? "Choose thread"}
          >
            <Text className="text-xs text-foreground-muted">{watch.managerStatus}</Text>
            {eligibleManagers.map(({ id: threadId }) => (
              <ManagerChoice
                key={threadId}
                environmentId={environmentId}
                threadId={threadId}
                selected={watch.managerThreadId === threadId}
                disabled={!canOperate || busy}
                onPress={() => {
                  void command({ action: "set-manager", managerThreadId: threadId });
                }}
              />
            ))}
            {eligibleManagers.length === 0 ? (
              <Text className="text-foreground-muted">No eligible threads in this workspace.</Text>
            ) : null}
            {watch.managerThreadId ? (
              <View className="flex-row flex-wrap gap-2">
                <Action
                  label="Open thread"
                  icon="text.bubble"
                  onPress={() =>
                    navigation.navigate("Thread", {
                      environmentId,
                      threadId: watch.managerThreadId!,
                    })
                  }
                />
                <Action
                  label="Unassign"
                  icon="xmark"
                  accessibilityLabel="Unassign manager"
                  disabled={!canOperate || busy}
                  onPress={() => {
                    void command({ action: "set-manager", managerThreadId: null });
                  }}
                />
              </View>
            ) : null}
          </Disclosure>
          <Disclosure label="Details" icon="info.circle" summary={observation?.baseBranch}>
            {observation ? (
              <Text className="text-xs text-foreground-muted">
                Observed {new Date(observation.observedAt).toLocaleString()}
              </Text>
            ) : null}
            {watch.authorization ? (
              <Text className="text-xs text-foreground-muted">
                Automatic merge: {watch.authorization.status}
              </Text>
            ) : null}
            {manager ? (
              <Text className="text-foreground-muted">
                {describeThreadActivity(manager, managerDetail.data?.messages)}
              </Text>
            ) : null}
            <Text className="text-xs text-foreground-muted">
              Merge when ready sends instructions to the thread named above.
            </Text>
          </Disclosure>
        </>
      ) : null}
    </ScrollView>
  );
}
