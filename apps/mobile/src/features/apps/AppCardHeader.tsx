import { Image } from "expo-image";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useGlassPalette } from "../../lib/useGlassPalette";
import { ThreadHierarchyChevron } from "../threads/thread-list-items";
import {
  appStatusPresentation,
  type AppCardHeaderItem,
  type AppStatusTone,
} from "./apps-tab-state";

const STATUS_DOT_CLASS = {
  running: "bg-adaptive-emerald-600-400",
  closed: "bg-foreground-muted",
  attention: "bg-warning-foreground",
  off: "bg-danger-foreground",
} as const satisfies Record<AppStatusTone, string>;

const STATUS_TEXT_CLASS = {
  running: "text-adaptive-emerald-600-400",
  closed: "text-foreground-muted",
  attention: "text-warning-foreground",
  off: "text-danger-foreground",
} as const satisfies Record<AppStatusTone, string>;

// The trailing controls draw narrower than 44pt so the status line keeps "Running" and the
// working chip on one row at phone widths; the slop restores the 44pt touch targets.
const ACTION_HIT_SLOP = { top: 6, bottom: 6, left: 4, right: 4 };
const CHEVRON_HIT_SLOP = { top: 6, bottom: 6, left: 8, right: 8 };

function HeaderAction(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const { accent } = useGlassPalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={ACTION_HIT_SLOP}
      onPress={props.onPress}
      className="h-11 w-9 items-center justify-center"
      style={({ pressed }) => ({ opacity: props.disabled ? 0.35 : pressed ? 0.6 : 1 })}
    >
      <SymbolView name={props.icon} size={22} tintColor={accent} />
    </Pressable>
  );
}

/** The app's row at the top of its box, after `AccountSectionHeader`: tap to see the app, chevron to fold it. */
export function AppCardHeader(props: {
  readonly item: AppCardHeaderItem;
  readonly onToggle: () => void;
  readonly onOpenDetails: () => void;
  readonly onNewThread: (() => void) | null;
  readonly onOpenInApp: (() => void) | null;
}) {
  const { accent, dark } = useGlassPalette();
  const { card, collapsed } = props.item;
  const status = card.primary === null ? null : appStatusPresentation(card.primary.app);

  return (
    <View
      className="flex-row items-center gap-2 py-3 pl-3 pr-1"
      style={{
        backgroundColor: themeColorWithAlpha(accent, dark ? 0.035 : 0.025),
        borderTopLeftRadius: 14,
        borderTopRightRadius: 14,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          card.name,
          status?.label,
          card.workingCount > 0 ? `${card.workingCount} working` : null,
        ]
          .filter(Boolean)
          .join(", ")}
        accessibilityHint="Shows the app's status and access."
        onPress={props.onOpenDetails}
        className="min-w-0 flex-1 flex-row items-center gap-2.5"
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <View
          className="h-12 w-12 items-center justify-center overflow-hidden rounded-xl border border-border bg-subtle"
          style={{ borderCurve: "continuous" }}
        >
          {card.iconDataUrl !== null ? (
            <Image
              accessibilityIgnoresInvertColors
              source={{ uri: card.iconDataUrl }}
              contentFit="contain"
              style={{ width: 32, height: 32 }}
            />
          ) : (
            <SymbolView name="square.grid.2x2" size={22} tintColor={accent} />
          )}
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <AppText className="font-lecturn-medium text-lg text-foreground" numberOfLines={1}>
            {card.name}
          </AppText>
          {status !== null || card.workingCount > 0 ? (
            <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
              {status !== null ? (
                <View className="flex-row items-center gap-1.5">
                  <View className={cn("h-2 w-2 rounded-full", STATUS_DOT_CLASS[status.tone])} />
                  <AppText
                    className={cn("text-sm font-lecturn-medium", STATUS_TEXT_CLASS[status.tone])}
                  >
                    {status.label}
                  </AppText>
                </View>
              ) : null}
              {card.workingCount > 0 ? (
                <View
                  className="flex-row items-center gap-1.5 rounded-full px-2.5 py-0.5"
                  style={{
                    borderWidth: 1,
                    borderColor: themeColorWithAlpha(accent, 0.6),
                    backgroundColor: themeColorWithAlpha(accent, dark ? 0.12 : 0.08),
                  }}
                >
                  <View className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent }} />
                  <AppText className="text-xs font-lecturn-medium text-foreground">
                    {card.workingCount} working
                  </AppText>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </Pressable>
      <View className="flex-row items-center gap-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={collapsed ? `Show ${card.name} threads` : `Hide ${card.name} threads`}
          accessibilityState={{ expanded: !collapsed }}
          hitSlop={CHEVRON_HIT_SLOP}
          onPress={props.onToggle}
          className="h-11 w-7 items-center justify-center"
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <ThreadHierarchyChevron expanded={!collapsed} size={16} />
        </Pressable>
        <View className="h-8 w-px bg-border" />
        <HeaderAction
          icon="plus"
          label={`New ${card.name} thread`}
          disabled={props.onNewThread === null}
          onPress={() => props.onNewThread?.()}
        />
        <HeaderAction
          icon="arrow.up.right.square"
          label={`Open in ${card.name}`}
          disabled={props.onOpenInApp === null}
          onPress={() => props.onOpenInApp?.()}
        />
      </View>
    </View>
  );
}
