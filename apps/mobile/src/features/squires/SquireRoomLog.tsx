import { useAtomValue } from "@effect/atom-react";
import {
  squireRoomAuthorLabel,
  squireRoomLogRows,
  squireRoomPostsInput,
  squireRoomRerouteTargets,
  squireRoutingChip,
  type SquireRoomLogRow,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  SquireId,
  SquireRoom,
  SquireRoomPost,
  SquireRoomPostId,
} from "@lecturn/contracts";
import { useRef, useState } from "react";
import { Pressable, View, type ViewInstance } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { squireEnvironment, useSquireIndicator } from "../../state/squire";
import { useAtomCommand } from "../../state/use-atom-command";
import { SquireIndicator } from "./SquireIndicator";
import { useSquireInView } from "./SquireViewport";
import {
  SQUIRE_HANDOFF_COLLAPSED_LINES,
  squireHandoffToggle,
  squireRoomPostTime,
} from "./squireRooms.logic";

const AUTHOR_SIZE = 28;

export interface SquireRoomLogContext {
  readonly environmentId: EnvironmentId;
  readonly room: SquireRoom;
  readonly squires: ReadonlyArray<SquireSnapshotEntry>;
  readonly leadId: SquireId | null;
  readonly nameOf: (squireId: SquireId) => string;
  readonly onLoadEarlier: () => void;
}

/**
 * Pages of at most 50 posts, oldest at the top. Each earlier page starts where the page after it
 * ends now, so a new post that pushes one off the newest page never leaves a gap. Rows render as
 * direct children of the scroll content so `maintainVisibleContentPosition` can anchor them.
 */
export function SquireRoomLog(props: {
  readonly context: SquireRoomLogContext;
  readonly posts: ReadonlyArray<SquireRoomPost>;
  readonly nextBefore: SquireRoomPostId | null;
  readonly earlierPages: number;
}) {
  return (
    <>
      <EarlierPosts
        context={props.context}
        before={props.nextBefore}
        remaining={props.earlierPages}
      />
      {props.posts.length === 0 && props.nextBefore === null ? (
        <Text className="py-8 text-center font-sans text-sm text-foreground-muted">
          No posts yet. Mention a Squire with @ to wake it.
        </Text>
      ) : (
        <LogRows context={props.context} posts={props.posts} />
      )}
    </>
  );
}

function EarlierPosts(props: {
  readonly context: SquireRoomLogContext;
  readonly before: SquireRoomPostId | null;
  readonly remaining: number;
}) {
  if (props.before === null) return null;
  if (props.remaining === 0) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={props.context.onLoadEarlier}
        className="items-center py-2 active:opacity-70"
      >
        <Text className="font-lecturn-medium text-sm text-foreground-secondary">Load earlier</Text>
      </Pressable>
    );
  }
  return (
    <EarlierPage context={props.context} before={props.before} remaining={props.remaining - 1} />
  );
}

function EarlierPage(props: {
  readonly context: SquireRoomLogContext;
  readonly before: SquireRoomPostId;
  readonly remaining: number;
}) {
  const { context } = props;
  const page = useEnvironmentQuery(
    squireEnvironment.roomPosts({
      environmentId: context.environmentId,
      input: squireRoomPostsInput(context.room.id, props.before),
    }),
  );
  if (page.data === null) {
    return page.error === null ? null : (
      <Text className="text-center font-sans text-xs text-foreground-muted">
        Earlier posts could not load.
      </Text>
    );
  }
  return (
    <>
      <EarlierPosts context={context} before={page.data.nextBefore} remaining={props.remaining} />
      <LogRows context={context} posts={page.data.posts} />
    </>
  );
}

function LogRows(props: {
  readonly context: SquireRoomLogContext;
  readonly posts: ReadonlyArray<SquireRoomPost>;
}) {
  const now = Date.now();
  return squireRoomLogRows(props.posts).map((row) => (
    <LogRow
      key={row.post.id}
      context={props.context}
      row={row}
      time={squireRoomPostTime(row.post.createdAt, now)}
    />
  ));
}

function LogRow(props: {
  readonly context: SquireRoomLogContext;
  readonly row: SquireRoomLogRow;
  readonly time: string;
}) {
  const { context, row, time } = props;
  if (row.kind === "system") {
    return (
      <Text className="px-6 text-center font-sans text-xs text-foreground-muted">
        {row.post.body} · {time}
      </Text>
    );
  }
  if (row.kind === "handoff") return <HandoffRow context={context} row={row} time={time} />;
  const author = row.post.author;
  const entry =
    author.kind === "squire" || author.kind === "lead"
      ? (context.squires.find((candidate) => candidate.squire.id === author.squireId) ?? null)
      : null;
  const name = squireRoomAuthorLabel(author, context.nameOf);
  return (
    <View className="flex-row gap-2.5">
      {entry === null ? (
        <View
          className="items-center justify-center rounded-full bg-subtle-strong"
          style={{ width: AUTHOR_SIZE, height: AUTHOR_SIZE }}
        >
          <SymbolView
            name="person.crop.circle"
            size={14}
            type="monochrome"
            tintColorClassName="accent-foreground-muted"
          />
        </View>
      ) : (
        <AuthorPortrait environmentId={context.environmentId} entry={entry} label={name} />
      )}
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text className="font-lecturn-bold text-sm text-foreground">{name}</Text>
          <Text className="font-sans text-xs text-foreground-muted tabular-nums">{time}</Text>
        </View>
        <Text selectable className="font-sans text-sm leading-5 text-foreground">
          {row.post.body}
        </Text>
        <RoutingChip context={context} post={row.post} />
      </View>
    </View>
  );
}

function AuthorPortrait(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly label: string;
}) {
  const indicator = useSquireIndicator(props.environmentId, props.entry);
  const portraitRef = useRef<ViewInstance>(null);
  const inView = useSquireInView(portraitRef, indicator.state === "working");
  return (
    <View ref={portraitRef} onLayout={inView.onLayout} collapsable={false}>
      <SquireIndicator
        state={indicator.state}
        companion={props.entry.squire.companion}
        isLead={props.entry.squire.role === "lead"}
        size={AUTHOR_SIZE}
        label={props.label}
        visible={inView.visible}
      />
    </View>
  );
}

/**
 * A handoff, "Release → Research: ...", in full up to a few lines. A longer one offers "more";
 * an invisible copy without a line limit measures how many lines the full text needs.
 */
function HandoffRow(props: {
  readonly context: SquireRoomLogContext;
  readonly row: Extract<SquireRoomLogRow, { kind: "handoff" }>;
  readonly time: string;
}) {
  const { context, row } = props;
  const [expanded, setExpanded] = useState(false);
  const [fullLineCount, setFullLineCount] = useState(0);
  const from = context.nameOf(row.from);
  const to = row.to.map(context.nameOf).join(", ");
  const toggle = squireHandoffToggle(fullLineCount, expanded);
  const text = (
    <>
      <Text className="font-lecturn-bold text-foreground">
        {from} → {to}:
      </Text>{" "}
      {row.post.body}
    </>
  );
  return (
    <View className="gap-0.5 pl-9">
      <Pressable
        accessibilityRole={toggle === null ? undefined : "button"}
        accessibilityLabel={`${from} to ${to}: ${row.post.body}`}
        accessibilityState={toggle === null ? undefined : { expanded }}
        disabled={toggle === null}
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-start gap-2 active:opacity-70"
      >
        <View className="min-w-0 flex-1">
          <Text
            className="font-sans text-sm leading-5 text-foreground-secondary"
            numberOfLines={expanded ? undefined : SQUIRE_HANDOFF_COLLAPSED_LINES}
          >
            {text}
          </Text>
          <View aria-hidden pointerEvents="none" className="absolute inset-x-0 top-0 opacity-0">
            <Text
              onTextLayout={(event) => setFullLineCount(event.nativeEvent.lines.length)}
              className="font-sans text-sm leading-5"
            >
              {text}
            </Text>
          </View>
          {toggle === null ? null : (
            <Text className="font-lecturn-medium text-xs text-foreground-secondary">{toggle}</Text>
          )}
        </View>
        <Text className="font-sans text-xs text-foreground-muted tabular-nums">{props.time}</Text>
      </Pressable>
      <RoutingChip context={context} post={row.post} />
    </View>
  );
}

function RoutingChip(props: {
  readonly context: SquireRoomLogContext;
  readonly post: SquireRoomPost;
}) {
  const { context, post } = props;
  const canReroute = useAtomValue(
    squireEnvironment.roomReroute.permissionAtom(context.environmentId),
  );
  const reroute = useAtomCommand(squireEnvironment.roomReroute, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const targets =
    canReroute && context.room.status === "open"
      ? squireRoomRerouteTargets(context.room, context.leadId, post)
      : [];

  const send = async (to: SquireId) => {
    setError(null);
    const result = await reroute({
      environmentId: context.environmentId,
      input: { requestId: uuidv4(), postId: post.id, to },
    });
    if (result._tag === "Failure") setError("The post could not be rerouted. Try again.");
  };

  return (
    <View className="gap-0.5">
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 shrink font-sans text-xs text-foreground-muted" numberOfLines={1}>
          {squireRoutingChip(post.routing, context.nameOf)}
        </Text>
        {targets.length === 0 ? null : (
          <Menu
            title="Send this post to"
            actions={targets.map((squireId) => ({
              id: squireId,
              title: context.nameOf(squireId),
              ...(squireId === context.leadId ? { subtitle: "Lead" } : {}),
            }))}
            onPressAction={({ nativeEvent }) => {
              const to = targets.find((squireId) => squireId === nativeEvent.event);
              if (to !== undefined) void send(to);
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reroute"
              hitSlop={8}
              className="active:opacity-70"
            >
              <Text className="font-lecturn-medium text-xs text-foreground-secondary">Reroute</Text>
            </Pressable>
          </Menu>
        )}
      </View>
      {error === null ? null : (
        <Text accessibilityRole="alert" className="font-sans text-xs text-danger-foreground">
          {error}
        </Text>
      )}
    </View>
  );
}
