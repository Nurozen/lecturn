import { useAtomValue } from "@effect/atom-react";
import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireId, SquireRoomId } from "@lecturn/contracts";
import { useRecyclingState, useViewabilityAmount } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { memo, useCallback, useMemo } from "react";
import { Pressable, View } from "react-native";
import { AsyncResult, Atom } from "effect/reactivity";

import { GlassCard } from "../../components/GlassCard";
import { AppText as Text } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  squireEnvironment,
  squireEnvironmentStatesAtom,
  useSquireEntry,
  useSquireIndicator,
  useSquireReadableEnvironments,
  useSquireSidebarState,
} from "../../state/squire";
import { setMobileProjectGroupCollapsed } from "../home/accountSectionExpansion";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { ThreadHierarchyChevron } from "../threads/thread-list-items";
import { SquireIndicator } from "./SquireIndicator";
import { SquireRoomPortraits } from "./SquireRoomPortraits";
import { squireRoomSeenAtom } from "./squireRoomSeen";
import { squireTint } from "./squirePalette";
import {
  buildSquireHomeItems,
  homeSquireItemsAreEqual,
  squireHomeLeadAggregateCount,
  squireHomeLeadTrailing,
  squireHomeRowLabel,
  squireHomeRowStatusLine,
  type HomeSquireItem,
} from "./squireHomeItems.logic";

const ROW_RADIUS = 22;
const INDICATOR_SIZE = 28;
const ROOM_PORTRAIT_SIZE = 22;

type Pane = "screen" | "sidebar";

type HomeEnvironment = { readonly environmentId: EnvironmentId; readonly label: string };

type LeadFold = { readonly key: string; readonly collapsed: boolean };

const NO_KEYS: ReadonlyArray<string> = [];

// Only a folded Lead reads its group's total, so an open list never subscribes to it.
const leadAggregateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => squireHomeLeadAggregateCount(get(squireEnvironment.state(environmentId)))),
);
const NO_AGGREGATE_ATOM = Atom.make(0);

/**
 * Rows read their own entries, so a count or state change must not re-render the list: the
 * atom keeps the previous array while the section's structure is unchanged.
 */
function squireHomeItemsAtom(
  input: Omit<Parameters<typeof buildSquireHomeItems>[0], "states"> & {
    readonly readable: ReadonlySet<EnvironmentId>;
  },
) {
  const statesAtom = squireEnvironmentStatesAtom(input.readable);
  let previous: ReadonlyArray<HomeSquireItem> = [];
  return Atom.make((get) => {
    const preferences = get(mobilePreferencesAtom);
    const next = buildSquireHomeItems({
      ...input,
      states: get(statesAtom),
      roomSeen: get(squireRoomSeenAtom),
      collapsedKeys: new Set(
        AsyncResult.isSuccess(preferences)
          ? (preferences.value.collapsedProjectGroups ?? NO_KEYS)
          : NO_KEYS,
      ),
    });
    const same =
      next.length === previous.length &&
      next.every((item, index) => homeSquireItemsAreEqual(previous[index]!, item));
    if (!same) previous = next;
    return previous;
  });
}

/** The Squires section's items for a list whose environment array is rebuilt every render. */
export function useSquireHomeItems(input: {
  readonly environments: ReadonlyArray<HomeEnvironment>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly searching: boolean;
}) {
  // The scope and state atoms are keyed on the array's identity, so keep it stable by content.
  const environmentsKey = JSON.stringify(
    input.environments.map(({ environmentId, label }) => [environmentId, label]),
  );
  const environments = useMemo(
    () =>
      (JSON.parse(environmentsKey) as Array<[EnvironmentId, string]>).map(
        ([environmentId, label]): HomeEnvironment => ({ environmentId, label }),
      ),
    [environmentsKey],
  );
  const readable = useSquireReadableEnvironments(environments);
  const { selectedEnvironmentId, searching } = input;
  const itemsAtom = useMemo(
    () => squireHomeItemsAtom({ environments, readable, selectedEnvironmentId, searching }),
    [environments, readable, selectedEnvironmentId, searching],
  );
  return useAtomValue(itemsAtom);
}

/** Renders one Squires-section item; the list's `itemsAreEqual` keeps it from re-rendering. */
export function SquireHomeListRow(props: { readonly item: HomeSquireItem; readonly pane: Pane }) {
  const { item, pane } = props;
  if (item.type === "squire-room") {
    return (
      <SquireHomeRoomRow
        environmentId={item.environmentId}
        roomId={item.roomId}
        topic={item.topic}
        portraits={item.portraits}
        overflow={item.overflow}
        unread={item.unread}
        pane={pane}
      />
    );
  }
  return (
    <SquireHomeRow
      environmentId={item.environmentId}
      squireId={item.squireId}
      isLead={item.type === "squire-lead"}
      environmentLabel={item.type === "squire-lead" ? item.environmentLabel : null}
      fold={
        item.type === "squire-lead" && item.expandable
          ? { key: item.key, collapsed: item.collapsed }
          : null
      }
      pane={pane}
    />
  );
}

const SquireHomeRow = memo(function SquireHomeRow(props: {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  readonly isLead: boolean;
  readonly environmentLabel: string | null;
  readonly fold: LeadFold | null;
  readonly pane: Pane;
}) {
  // Each row reads its own entry, so a snapshot update re-renders only the row it changed.
  const entry = useSquireEntry(props.environmentId, props.squireId);
  if (entry === null) return null;
  return <SquireHomeRowBody {...props} entry={entry} />;
});

function SquireHomeRowBody(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly isLead: boolean;
  readonly environmentLabel: string | null;
  readonly fold: LeadFold | null;
  readonly pane: Pane;
}) {
  const { environmentId, entry, isLead, fold } = props;
  const folded = fold?.collapsed === true;
  const squire = entry.squire;
  const navigation = useNavigation();
  const { themeAppearance } = useAppearancePreferences();
  const [visible, setVisible] = useRecyclingState(false);
  useViewabilityAmount(useCallback((token) => setVisible(token.sizeVisible > 0), [setVisible]));
  const indicator = useSquireIndicator(environmentId, entry);
  const aggregate = useAtomValue(folded ? leadAggregateAtom(environmentId) : NO_AGGREGATE_ATOM);
  const sidebarState = useSquireSidebarState(environmentId, entry);
  const trailing = isLead ? squireHomeLeadTrailing(sidebarState, aggregate, folded) : sidebarState;
  const statusLine = squireHomeRowStatusLine(entry, indicator);
  const label = squireHomeRowLabel(squire.name, trailing, indicator);
  const subtitle = [props.environmentLabel, statusLine].filter(Boolean).join(" · ");
  const tint = squireTint(squire.companion.palette, isLead, themeAppearance);
  const sidebarPane = props.pane === "sidebar";

  // The fold is its own 44pt control beside the row, as on project group headers, so opening
  // the chat and folding the group stay separate for touch and VoiceOver/TalkBack.
  return (
    <GlassCard
      radius={ROW_RADIUS}
      className="flex-row"
      style={{
        marginHorizontal: sidebarPane ? 0 : 14,
        marginTop: isLead ? 8 : 0,
        marginBottom: 8,
      }}
    >
      {fold === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !fold.collapsed }}
          accessibilityLabel={`${fold.collapsed ? "Expand" : "Collapse"} ${squire.name}'s Squires`}
          style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}
          className="self-stretch pl-1"
          onPress={() => setMobileProjectGroupCollapsed(fold.key, !fold.collapsed)}
        >
          <ThreadHierarchyChevron expanded={!fold.collapsed} />
        </Pressable>
      )}
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={[label, props.environmentLabel, statusLine].filter(Boolean).join(", ")}
        accessibilityHint="Opens the Squire's chat"
        onPress={() => navigation.navigate("Squire", { environmentId, squireId: squire.id })}
        className="min-w-0 flex-1"
      >
        <View
          className={cn(
            "flex-row items-center gap-2.5",
            isLead ? "min-h-[52px] py-2.5" : "min-h-[44px] py-2",
            // The chevron's column stands in for the leading padding.
            fold === null ? (sidebarPane ? "px-3" : "px-4") : sidebarPane ? "pr-3" : "pr-4",
          )}
        >
          <SquireIndicator
            state={indicator.state}
            companion={squire.companion}
            isLead={isLead}
            size={INDICATOR_SIZE}
            label={label}
            visible={visible}
          />
          <View className="min-w-0 flex-1">
            <Text
              className={cn(
                "text-base text-foreground",
                isLead ? "font-lecturn-bold" : "font-lecturn-medium",
              )}
              numberOfLines={1}
            >
              {squire.name}
            </Text>
            {subtitle === "" ? null : (
              <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                {subtitle}
              </Text>
            )}
          </View>
          {trailing === "working" ? (
            <Text className="text-xs text-foreground-muted">working</Text>
          ) : trailing === "needs-you" ? (
            <View
              className="items-center justify-center rounded-full px-2"
              style={{
                height: 22,
                backgroundColor: themeColorWithAlpha(tint.ring, 0.22),
                borderWidth: 1,
                borderColor: themeColorWithAlpha(tint.ring, 0.55),
              }}
            >
              {/* The thread tone is the palette's text-safe one: light on dark, deepened on light. */}
              <Text className="text-xs font-lecturn-bold" style={{ color: tint.thread }}>
                Needs you
              </Text>
            </View>
          ) : trailing === "unread" ? (
            <View className="size-2 rounded-full bg-primary" />
          ) : null}
        </View>
      </RowPressable>
    </GlassCard>
  );
}

const SquireHomeRoomRow = memo(function SquireHomeRoomRow(props: {
  readonly environmentId: EnvironmentId;
  readonly roomId: SquireRoomId;
  readonly topic: string;
  readonly portraits: ReadonlyArray<SquireId>;
  readonly overflow: number;
  readonly unread: boolean;
  readonly pane: Pane;
}) {
  const { environmentId, roomId } = props;
  const navigation = useNavigation();
  const [visible, setVisible] = useRecyclingState(false);
  useViewabilityAmount(useCallback((token) => setVisible(token.sizeVisible > 0), [setVisible]));
  const sidebarPane = props.pane === "sidebar";
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={props.unread ? `${props.topic}, new posts` : props.topic}
      accessibilityHint="Opens the room"
      onPress={() => navigation.navigate("SquireRoom", { environmentId, roomId })}
      style={{
        borderRadius: ROW_RADIUS,
        borderCurve: "continuous",
        marginHorizontal: sidebarPane ? 0 : 14,
        marginBottom: 8,
      }}
    >
      <GlassCard radius={ROW_RADIUS}>
        <View
          className={cn(
            "min-h-[44px] flex-row items-center gap-2.5 py-2",
            sidebarPane ? "px-3" : "px-4",
          )}
        >
          <SquireRoomPortraits
            environmentId={environmentId}
            portraits={props.portraits}
            overflow={props.overflow}
            size={ROOM_PORTRAIT_SIZE}
            visible={visible}
          />
          <Text
            className={cn(
              "min-w-0 flex-1 text-base",
              props.unread ? "text-foreground" : "text-foreground-muted",
            )}
            numberOfLines={1}
          >
            {props.topic}
          </Text>
          {props.unread ? <View className="size-2 rounded-full bg-primary" /> : null}
        </View>
      </GlassCard>
    </RowPressable>
  );
});
