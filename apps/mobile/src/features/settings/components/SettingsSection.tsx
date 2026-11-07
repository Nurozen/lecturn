import { GlassCard } from "../../../components/GlassCard";
import { createContext, use, type ReactNode } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";

/**
 * Set while the Settings list is a split view's sidebar, naming the page open beside it. Like the
 * system Settings app, the sidebar lists plain rows and highlights that page instead of cards.
 */
export const SettingsSidebarContext = createContext<{ readonly selected: string | null } | null>(
  null,
);

/** Upstream's `ListSection` API on Lecturn's glass card. */
export function SettingsSection(props: {
  readonly title?: string;
  readonly titleIcon?: ReactNode;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: string;
}) {
  if (use(SettingsSidebarContext)) {
    return (
      <View className="gap-1">
        {props.title ? (
          <View className="flex-row items-center justify-between gap-3 px-2">
            <View className="min-w-0 flex-1 flex-row items-center gap-2">
              {props.titleIcon}
              <Text
                textRole="footnote"
                className="shrink font-lecturn-medium text-foreground-muted"
              >
                {props.title}
              </Text>
            </View>
            {props.trailing}
          </View>
        ) : null}
        <View>{props.children}</View>
        {props.footer ? (
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            {props.footer}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <View className="gap-2">
      {props.title ? (
        <View className="flex-row items-center justify-between gap-3">
          <View
            className={
              Platform.OS === "android"
                ? "min-w-0 flex-1 flex-row items-center gap-2 px-4"
                : "min-w-0 flex-1 flex-row items-center gap-2 px-2"
            }
          >
            {props.titleIcon}
            <Text
              className={
                Platform.OS === "android"
                  ? "shrink text-sm font-lecturn-medium text-primary-text"
                  : "shrink text-sm font-lecturn-medium text-foreground-muted"
              }
            >
              {props.title}
            </Text>
          </View>
          {props.trailing}
        </View>
      ) : null}
      <GlassCard radius={Platform.OS === "android" ? 28 : 24} className="overflow-hidden">
        {props.children}
      </GlassCard>
      {props.footer ? (
        <Text className="px-4 text-sm text-foreground-muted">{props.footer}</Text>
      ) : null}
    </View>
  );
}
