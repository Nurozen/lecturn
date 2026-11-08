import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import {
  squireLeadHello,
  squireLeadIntro,
  squireLeadShowsIntro,
  squireStateLine,
  squireScopeLine,
  SQUIRE_LEAD_INTRO_START_LABEL,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import { EnvironmentId, SquireId } from "@lecturn/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  View,
  type ScrollViewInstance,
  type ViewInstance,
} from "react-native";

import { EmptyState } from "../../components/ui/EmptyState";
import { AppText as Text } from "../../components/ui/AppText";
import { uuidv4 } from "../../lib/uuid";
import { useQuietThreadShell } from "../../state/entities";
import { squireEnvironment, useSquireIndicator, useSquireSupported } from "../../state/squire";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "../threads/RequestActionButton";
import { SquireIndicator, SquireMotionClock } from "./SquireIndicator";
import { SquireRules } from "./SquireRules";
import {
  SquireViewportContext,
  useSquireInView,
  useSquireScrollViewport,
  useSquireViewportScroll,
} from "./SquireViewport";
import {
  squireHeaderActions,
  squireRouteDestination,
  squireScreenState,
} from "./squireApproval.logic";
import { useOpenThreadOverPage, useReplaceWithThread } from "../workspace/useOpenThreadOverPage";

export type SquireRouteParams = {
  environmentId: string;
  squireId: string;
  /** The Squire's details rather than its chat, from the chat's own menu. */
  details?: boolean;
};

export function SquireRouteScreen({ route }: StaticScreenProps<SquireRouteParams>) {
  const { environmentId, squireId, details } = route.params;
  return (
    <SquireScreen
      key={`${environmentId}:${squireId}:${details === true}`}
      environmentId={EnvironmentId.make(environmentId)}
      squireId={SquireId.make(squireId)}
      detailsRequested={details === true}
    />
  );
}

function SquireScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  readonly detailsRequested: boolean;
}) {
  const supported = useSquireSupported(props.environmentId);
  const state = useAtomValue(squireEnvironment.state(props.environmentId));
  const screen = squireScreenState(supported, state, props.squireId);
  switch (screen.status) {
    case "unsupported":
      return (
        <ScreenMessage title="No Squires here" detail="This environment doesn't run Squires." />
      );
    case "loading":
      return <ScreenMessage title="Loading…" detail="" />;
    case "missing":
      return (
        <ScreenMessage
          title="Squire not found"
          detail="It may have been deleted, or this connection cannot see it."
        />
      );
    case "ready":
      return (
        <SquireMotionClock>
          <SquireReady
            environmentId={props.environmentId}
            entry={screen.entry}
            isLead={screen.isLead}
            team={screen.team}
            detailsRequested={props.detailsRequested}
          />
        </SquireMotionClock>
      );
  }
}

function ScreenMessage(props: { readonly title: string; readonly detail: string }) {
  return (
    <View className="flex-1 justify-center bg-screen">
      <EmptyState variant="plain" title={props.title} detail={props.detail} />
    </View>
  );
}

function SquireReady(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly isLead: boolean;
  readonly team: ReadonlyArray<SquireSnapshotEntry>;
  readonly detailsRequested: boolean;
}) {
  const { environmentId, entry } = props;
  const { squire } = entry;
  const homeShell = useQuietThreadShell(
    squire.homeThreadId === null ? null : scopeThreadRef(environmentId, squire.homeThreadId),
  );
  const destination = squireRouteDestination({
    squire,
    detailsRequested: props.detailsRequested,
    homeVisibleItemCount: squire.homeThreadId === null ? 0 : (homeShell?.visibleItemCount ?? null),
  });
  const replaceWithThread = useEffectEvent(useReplaceWithThread());
  const chatThreadId = destination.kind === "chat" ? destination.threadId : null;
  // oxlint-disable-next-line lecturn/react-effect-budget -- navigation runs after commit, before paint, so the blank route never shows.
  useLayoutEffect(() => {
    if (chatThreadId !== null) replaceWithThread({ environmentId, threadId: chatThreadId });
  }, [environmentId, chatThreadId]);
  if (chatThreadId !== null) return <View className="flex-1 bg-screen" />;
  return <SquireDetails {...props} />;
}

/** What the chat cannot show: setup, the Lead's introduction, pause, the team, and rules. */
function SquireDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly isLead: boolean;
  readonly team: ReadonlyArray<SquireSnapshotEntry>;
}) {
  const { environmentId, entry, isLead, team } = props;
  const { squire } = entry;
  const navigation = useNavigation();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const scrollViewport = useSquireScrollViewport(scrollRef);
  useLayoutEffect(() => {
    navigation.setOptions({ title: squire.name });
  }, [navigation, squire.name]);

  return (
    <SquireViewportContext.Provider value={scrollViewport.viewport}>
      <ScrollView
        ref={scrollRef}
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 18, paddingBottom: 48 }}
        scrollEventThrottle={100}
        onScroll={scrollViewport.onScroll}
        onLayout={scrollViewport.onLayout}
      >
        <SquireHeader environmentId={environmentId} entry={entry} isLead={isLead} team={team} />
        {isLead ? <SquireLeadIntro environmentId={environmentId} lead={squire} /> : null}
        {isLead && team.length > 0 ? (
          <SquireTeamStrip environmentId={environmentId} team={team} />
        ) : null}
        {isLead ? null : <SquireRules environmentId={environmentId} squire={squire} />}
      </ScrollView>
    </SquireViewportContext.Provider>
  );
}

function SquireHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly isLead: boolean;
  readonly team: ReadonlyArray<SquireSnapshotEntry>;
}) {
  const { environmentId, entry } = props;
  const { squire } = entry;
  const openThread = useOpenThreadOverPage();
  const indicator = useSquireIndicator(environmentId, entry);
  const portraitRef = useRef<ViewInstance>(null);
  const inView = useSquireInView(portraitRef, indicator.state === "working");
  const actions = squireHeaderActions(squire);
  const canSetStatus = useAtomValue(squireEnvironment.setStatus.permissionAtom(environmentId));
  const setStatus = useAtomCommand(squireEnvironment.setStatus, { reportFailure: false });
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const stateLine = squireStateLine({
    squire,
    indicator,
    openDecisionCount: entry.openDecisionCount,
    heldCount: entry.held.length,
  });
  const scopeLine = squireScopeLine(entry, props.team);

  const togglePause = async () => {
    setStatusBusy(true);
    setStatusError(null);
    const result = await setStatus({
      environmentId,
      input: { requestId: uuidv4(), squireId: squire.id, status: actions.pause.next },
    });
    setStatusBusy(false);
    if (result._tag === "Failure") setStatusError("The Squire could not be updated. Try again.");
  };

  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-3.5">
        <View ref={portraitRef} onLayout={inView.onLayout} collapsable={false}>
          <SquireIndicator
            state={indicator.state}
            companion={squire.companion}
            isLead={props.isLead}
            size={56}
            label={`${squire.name}, ${stateLine}`}
            visible={inView.visible}
          />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="font-lecturn-bold text-xl text-foreground" numberOfLines={1}>
            {squire.name}
          </Text>
          <Text className="font-sans text-sm text-foreground-secondary">{stateLine}</Text>
          <Text className="font-sans text-xs text-foreground-muted" numberOfLines={2}>
            {scopeLine}
          </Text>
        </View>
      </View>
      {actions.setupPrompt === null ? null : (
        <Text className="font-sans text-sm text-foreground-muted">{actions.setupPrompt}</Text>
      )}
      <View className="flex-row flex-wrap gap-2">
        {actions.chatThreadId === null ? null : (
          <RequestActionButton
            label="Chat"
            onPress={() => openThread({ environmentId, threadId: actions.chatThreadId! })}
          />
        )}
        {canSetStatus && actions.setupPrompt === null ? (
          <RequestActionButton
            label={actions.pause.label}
            tone="secondary"
            disabled={statusBusy}
            onPress={() => void togglePause()}
          />
        ) : null}
      </View>
      {statusError === null ? null : (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {statusError}
        </Text>
      )}
    </View>
  );
}

/** The Lead's fixed first message, until onboarding runs or its home thread gains a message. */
function SquireLeadIntro(props: {
  readonly environmentId: EnvironmentId;
  readonly lead: SquireSnapshotEntry["squire"];
}) {
  const { environmentId, lead } = props;
  const homeShell = useQuietThreadShell(
    lead.homeThreadId === null ? null : scopeThreadRef(environmentId, lead.homeThreadId),
  );
  const homeVisibleItemCount =
    lead.homeThreadId === null ? 0 : (homeShell?.visibleItemCount ?? null);
  const canOpen = useAtomValue(squireEnvironment.leadOpen.permissionAtom(environmentId));
  const leadOpen = useAtomCommand(squireEnvironment.leadOpen, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!squireLeadShowsIntro({ lead, homeVisibleItemCount })) return null;

  // Stays disabled after success: the block leaves once the server records onboarding.
  const start = async () => {
    setBusy(true);
    setError(null);
    const result = await leadOpen({
      environmentId,
      input: { requestId: uuidv4(), onboarding: "start" },
    });
    if (result._tag === "Failure") {
      setBusy(false);
      setError("Your Lead could not start. Try again.");
    }
  };

  return (
    <View className="gap-3 rounded-2xl border border-border bg-card px-3.5 py-3">
      <View className="flex-row items-center gap-2.5">
        <SquireIndicator
          state="waiting"
          companion={lead.companion}
          isLead
          size={32}
          label={lead.name}
        />
        <Text className="min-w-0 flex-1 font-lecturn-bold text-sm text-foreground">
          {`${squireLeadHello(lead.name)} Here's what Squires can do for you.`}
        </Text>
      </View>
      {squireLeadIntro("mobile").map((paragraph) => (
        <Text key={paragraph} className="font-sans text-sm text-foreground-secondary">
          {paragraph}
        </Text>
      ))}
      {canOpen ? (
        <View className="flex-row">
          <RequestActionButton
            label={SQUIRE_LEAD_INTRO_START_LABEL}
            disabled={busy}
            onPress={() => void start()}
          />
        </View>
      ) : null}
      {error === null ? null : (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      )}
    </View>
  );
}

/** The Lead's team: tapping a portrait opens that Squire. */
function SquireTeamStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly team: ReadonlyArray<SquireSnapshotEntry>;
}) {
  const navigation = useNavigation();
  const onScroll = useSquireViewportScroll();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      scrollEventThrottle={100}
      onScroll={onScroll}
      contentContainerStyle={{ gap: 14 }}
      accessibilityLabel="Your Squires"
    >
      {props.team.map((member) => (
        <TeamPortrait
          key={member.squire.id}
          environmentId={props.environmentId}
          entry={member}
          onPress={() =>
            navigation.navigate("Squire", {
              environmentId: props.environmentId,
              squireId: member.squire.id,
            })
          }
        />
      ))}
    </ScrollView>
  );
}

function TeamPortrait(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly onPress: () => void;
}) {
  const { squire } = props.entry;
  const indicator = useSquireIndicator(props.environmentId, props.entry);
  const portraitRef = useRef<ViewInstance>(null);
  const inView = useSquireInView(portraitRef, indicator.state === "working");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={squire.name}
      onPress={props.onPress}
      className="items-center gap-1"
    >
      <View ref={portraitRef} onLayout={inView.onLayout} collapsable={false}>
        <SquireIndicator
          state={indicator.state}
          companion={squire.companion}
          size={40}
          label={squire.name}
          visible={inView.visible}
        />
      </View>
      <Text className="max-w-16 font-sans text-2xs text-foreground-muted" numberOfLines={1}>
        {squire.name}
      </Text>
    </Pressable>
  );
}
