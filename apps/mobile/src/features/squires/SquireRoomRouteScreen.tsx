import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  squireRoomMarkReadTarget,
  squireRoomNameOf,
  squireRoomPostsInput,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import {
  EnvironmentId,
  SquireRoomId,
  type SquireRoomPostId,
  type SquireRoomRow,
} from "@lecturn/contracts";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState, ScrollView, View, type ScrollViewInstance } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { squireEnvironment, useSquireSupported } from "../../state/squire";
import { useAtomCommand } from "../../state/use-atom-command";
import { SquireMotionClock } from "./SquireIndicator";
import { SquireRoomComposer } from "./SquireRoomComposer";
import { SquireRoomHeader } from "./SquireRoomHeader";
import { SquireRoomLog } from "./SquireRoomLog";
import { SquireViewportContext, useSquireScrollViewport } from "./SquireViewport";
import {
  SQUIRE_ROOM_LOG_ANCHOR_INDEX,
  squireRoomPinned,
  squireRoomScreenState,
  withSquireRoomSeen,
} from "./squireRooms.logic";
import { squireRoomSeenAtom } from "./squireRoomSeen";

export type SquireRoomRouteParams = { environmentId: string; roomId: string };

export function SquireRoomRouteScreen({ route }: StaticScreenProps<SquireRoomRouteParams>) {
  const { environmentId, roomId } = route.params;
  return (
    <SquireRoomScreen
      key={`${environmentId}:${roomId}`}
      environmentId={EnvironmentId.make(environmentId)}
      roomId={SquireRoomId.make(roomId)}
    />
  );
}

function SquireRoomScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly roomId: SquireRoomId;
}) {
  const supported = useSquireSupported(props.environmentId);
  const state = useAtomValue(squireEnvironment.state(props.environmentId));
  const screen = squireRoomScreenState(supported, state, props.roomId);
  switch (screen.status) {
    case "unsupported":
      return <Message title="No Squires here" detail="This environment doesn't run Squires." />;
    case "loading":
      return <Message title="Loading…" detail="" />;
    case "missing":
      return (
        <Message
          title="Room not found"
          detail="It may have been removed, or this connection cannot see it."
        />
      );
    case "ready":
      return (
        <SquireMotionClock>
          <SquireRoomView
            environmentId={props.environmentId}
            row={screen.row}
            squires={screen.squires}
            lead={screen.lead}
          />
        </SquireMotionClock>
      );
  }
}

function Message(props: { readonly title: string; readonly detail: string }) {
  return (
    <View className="flex-1 justify-center bg-screen">
      <EmptyState variant="plain" title={props.title} detail={props.detail} />
    </View>
  );
}

/** Focused in navigation and the app in the foreground: the only time a post counts as seen. */
function useScreenShowing() {
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) =>
      setForeground(next === "active"),
    );
    return () => subscription.remove();
  }, []);
  return focused && foreground;
}

function SquireRoomView(props: {
  readonly environmentId: EnvironmentId;
  readonly row: SquireRoomRow;
  readonly squires: ReadonlyArray<SquireSnapshotEntry>;
  readonly lead: SquireSnapshotEntry | null;
}) {
  const { environmentId, row, squires, lead } = props;
  const navigation = useNavigation();
  const registry = useContext(RegistryContext);
  const showing = useScreenShowing();
  const newest = useEnvironmentQuery(
    squireEnvironment.roomPosts({ environmentId, input: squireRoomPostsInput(row.id, null) }),
  );
  const canMarkRead = useAtomValue(squireEnvironment.roomMarkRead.permissionAtom(environmentId));
  const markRead = useAtomCommand(squireEnvironment.roomMarkRead, { reportFailure: false });
  const scrollRef = useRef<ScrollViewInstance>(null);
  const scrollViewport = useSquireScrollViewport(scrollRef);
  // The ref drives scrolling synchronously; the state drives the mark-read effect.
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const markedRef = useRef<SquireRoomPostId | null>(null);
  const [earlierPages, setEarlierPages] = useState(0);

  useLayoutEffect(() => {
    navigation.setOptions({ title: row.topic });
  }, [navigation, row.topic]);

  const room = newest.data?.room ?? null;
  const newestPostId = newest.data?.posts[0]?.id ?? null;
  const lastPostAt = room?.lastPostAt ?? null;
  const showingNewest = showing && pinned && room !== null;

  useEffect(() => {
    if (!showingNewest) return;
    registry.update(squireRoomSeenAtom, (seen) =>
      withSquireRoomSeen(seen, environmentId, row.id, lastPostAt),
    );
    const target = squireRoomMarkReadTarget({
      newestPostId,
      lastMarkedPostId: markedRef.current,
      showingNewest,
      canMarkRead,
    });
    if (target === null) return;
    markedRef.current = target;
    void markRead({
      environmentId,
      input: { requestId: uuidv4(), roomId: row.id, throughPostId: target },
    });
  }, [
    canMarkRead,
    environmentId,
    lastPostAt,
    markRead,
    newestPostId,
    registry,
    row.id,
    showingNewest,
  ]);

  const nameOf = squireRoomNameOf(squires);
  const members = row.members.map((squireId) => ({ squireId, name: nameOf(squireId) }));
  const followEnd = () => {
    if (pinnedRef.current) scrollRef.current?.scrollToEnd({ animated: false });
  };

  return (
    <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1 bg-screen">
      <SquireViewportContext.Provider value={scrollViewport.viewport}>
        <ScrollView
          ref={scrollRef}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          // Earlier pages insert above what the user is reading; keep it in place.
          maintainVisibleContentPosition={{ minIndexForVisible: SQUIRE_ROOM_LOG_ANCHOR_INDEX }}
          contentContainerStyle={{ padding: 16, gap: 14 }}
          scrollEventThrottle={100}
          onScroll={({ nativeEvent }) => {
            const next = squireRoomPinned({
              contentHeight: nativeEvent.contentSize.height,
              offsetY: nativeEvent.contentOffset.y,
              viewportHeight: nativeEvent.layoutMeasurement.height,
            });
            pinnedRef.current = next;
            if (next !== pinned) setPinned(next);
            scrollViewport.onScroll();
          }}
          onContentSizeChange={followEnd}
          onLayout={() => {
            followEnd();
            scrollViewport.onLayout();
          }}
        >
          <SquireRoomHeader
            environmentId={environmentId}
            row={row}
            room={room}
            nameOf={nameOf}
            leadName={lead?.squire.name ?? null}
          />
          {room === null || newest.data === null ? (
            newest.error === null ? null : (
              <Text className="py-8 text-center font-sans text-sm text-foreground-muted">
                The room could not be loaded.
              </Text>
            )
          ) : (
            <SquireRoomLog
              context={{
                environmentId,
                room,
                squires,
                leadId: lead?.squire.id ?? null,
                nameOf,
                onLoadEarlier: () => {
                  pinnedRef.current = false;
                  setPinned(false);
                  setEarlierPages(earlierPages + 1);
                },
              }}
              posts={newest.data.posts}
              nextBefore={newest.data.nextBefore}
              earlierPages={earlierPages}
            />
          )}
        </ScrollView>
      </SquireViewportContext.Provider>
      <SquireRoomComposer
        environmentId={environmentId}
        roomId={row.id}
        members={members}
        lead={lead === null ? null : { squireId: lead.squire.id, name: lead.squire.name }}
        closed={row.status === "closed"}
        onSent={() => {
          pinnedRef.current = true;
          setPinned(true);
        }}
      />
    </KeyboardAvoidingView>
  );
}
