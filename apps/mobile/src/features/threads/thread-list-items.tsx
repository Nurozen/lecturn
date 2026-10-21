import { useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import type { StaveSagaMemberStatus } from "@lecturn/contracts";
import { memo, useCallback, useEffect } from "react";
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GlassCard } from "../../components/GlassCard";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useGlassPalette } from "../../lib/useGlassPalette";
import { serverEnvironment } from "../../state/server";
import type { HomeGroupDisplayAction } from "../home/homeListItems";
import { StaveIcon } from "./StaveIcon";

/**
 * Shared hierarchy chrome for the v2 thread lists: the compact (phone) Home
 * list and the iPad sidebar render the same project/saga group headers and
 * disclosure chevrons, differing only in metrics via `variant`. Thread rows
 * themselves live in thread-list-v2-items.
 */
export type ThreadListVariant = "compact" | "sidebar";

export const THREAD_ACTIVITY_VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 0 };

/** A stable native glyph rotates instead of swapping on each disclosure toggle. */
export function ThreadHierarchyChevron({
  expanded,
  direction = "right",
  size = 12,
  tintColor,
}: {
  readonly expanded: boolean;
  readonly direction?: "right" | "down";
  readonly size?: number;
  readonly tintColor?: ColorValue;
}) {
  const target = expanded ? (direction === "right" ? 90 : 180) : 0;
  const angle = useSharedValue(target);
  useEffect(() => {
    angle.set(
      withTiming(target, {
        duration: 420,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      }),
    );
    return () => cancelAnimation(angle);
  }, [angle, target]);
  const rotation = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle.value}deg` }] }));
  return (
    <Animated.View pointerEvents="none" accessible={false} style={rotation}>
      <SymbolView
        name={direction === "right" ? "chevron.right" : "chevron.down"}
        size={size}
        type="monochrome"
        tintColor={tintColor}
        tintColorClassName={tintColor === undefined ? "accent-foreground-muted" : undefined}
      />
    </Animated.View>
  );
}

/* ─── Project group header ───────────────────────────────────────────── */

export const ThreadListGroupHeader = memo(function ThreadListGroupHeader(props: {
  readonly variant: ThreadListVariant;
  readonly project: EnvironmentProject;
  readonly title: string;
  readonly threadCount: number;
  readonly collapsed: boolean;
  readonly isFirst: boolean;
  readonly groupKey: string;
  readonly depth?: number;
  readonly memberStatus?: StaveSagaMemberStatus | null;
  readonly firstThread?: EnvironmentThreadShell;
  readonly onSelectThread?: (thread: EnvironmentThreadShell) => void;
  readonly onGroupAction: (key: string, action: HomeGroupDisplayAction) => void;
  /** Project a quick new thread should target; null hides the button. */
  readonly newThreadTarget?: EnvironmentProject | null;
  readonly onNewThread?: (project: EnvironmentProject) => void;
}) {
  const { groupKey, onGroupAction, onNewThread } = props;
  const navigation = useNavigation();
  const decisionConfig = useAtomValue(
    serverEnvironment.configValueAtom(props.project.environmentId),
  );
  const newThreadTarget = props.newThreadTarget ?? null;
  const compact = props.variant === "compact";
  const handleToggle = useCallback(
    () => onGroupAction(groupKey, "toggle-collapsed"),
    [groupKey, onGroupAction],
  );
  const handleNewThread = useCallback(() => {
    if (newThreadTarget) onNewThread?.(newThreadTarget);
  }, [newThreadTarget, onNewThread]);
  const showNewThreadButton = onNewThread !== undefined && newThreadTarget !== null;
  const glass = useGlassPalette();

  // Separate 44pt controls keep collapse, open, and new-thread actions reachable
  // to touch users and VoiceOver/TalkBack without overlapping hit areas.
  return (
    <GlassCard
      radius={22}
      style={{
        marginHorizontal: compact ? 14 : 0,
        marginTop: props.isFirst ? 8 : 16,
        marginBottom: 8,
      }}
    >
      <View
        className="flex-row items-center"
        style={{
          minHeight: 52,
          paddingLeft: 4 + (props.depth ?? 0) * 18,
          paddingRight: 4,
          paddingBottom: 4,
          paddingTop: 4,
        }}
      >
        {Array.from({ length: props.depth ?? 0 }, (_, level) => (
          <View
            key={level}
            pointerEvents="none"
            accessible={false}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: level * 18 + 8,
              width: 1,
              backgroundColor: glass.edge,
            }}
          />
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !props.collapsed }}
          accessibilityLabel={`${props.collapsed ? "Expand" : "Collapse"} ${props.title}`}
          accessibilityHint={props.collapsed ? "Expands the project" : "Collapses the project"}
          style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}
          onPress={handleToggle}
        >
          <ThreadHierarchyChevron expanded={!props.collapsed} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.title}, ${props.threadCount} threads`}
          accessibilityHint={
            props.firstThread
              ? "Opens the most recent project thread"
              : "Expands or collapses the project"
          }
          className="min-w-0 flex-1 flex-row items-center gap-2"
          style={{ minHeight: 44 }}
          onPress={() => {
            if (props.firstThread && props.onSelectThread) props.onSelectThread(props.firstThread);
            else handleToggle();
          }}
        >
          {props.project.stave ? (
            <View accessibilityLabel={props.project.stave.isSaga ? "Stave saga" : "Stave space"}>
              <StaveIcon size={compact ? 22 : 18} />
            </View>
          ) : null}
          {!props.project.stave || props.project.faviconPath ? (
            <ProjectFavicon
              environmentId={props.project.environmentId}
              faviconPath={props.project.faviconPath}
              open={!props.collapsed}
              size={compact ? 22 : 18}
              projectTitle={props.project.title}
              workspaceRoot={props.project.workspaceRoot}
            />
          ) : null}
          <Text
            className={
              compact
                ? "flex-shrink text-base font-lecturn-bold tracking-[0.2px] text-foreground-muted"
                : "flex-shrink text-sm font-lecturn-bold tracking-[0.2px] text-foreground-muted"
            }
            numberOfLines={1}
          >
            {props.title}
          </Text>
          <Text
            className={
              compact
                ? "flex-1 text-sm font-lecturn-medium text-foreground-tertiary"
                : "flex-1 text-xs font-lecturn-medium text-foreground-tertiary"
            }
          >
            {props.threadCount}
          </Text>
        </Pressable>
        {newThreadTarget && decisionConfig?.environment.capabilities.threadDecisions ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Decisions for ${props.title}`}
            style={{ minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" }}
            onPress={() =>
              navigation.navigate("Decisions", {
                environmentId: props.project.environmentId,
                projectId: props.project.id,
              })
            }
          >
            <Text className="text-primary">Decisions</Text>
          </Pressable>
        ) : null}
        {showNewThreadButton ? (
          <Pressable
            accessibilityLabel={`Create new thread in ${props.title}`}
            accessibilityRole="button"
            onPress={handleNewThread}
            style={({ pressed }) => ({
              opacity: pressed ? 0.5 : 1,
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
            })}
          >
            <SymbolView
              name="plus"
              size={compact ? 20 : 16}
              tintColorClassName={"accent-icon-muted"}
              type="monochrome"
              weight="medium"
            />
          </Pressable>
        ) : null}
      </View>
    </GlassCard>
  );
});
