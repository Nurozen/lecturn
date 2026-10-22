import type { ReactNode } from "react";
import { Platform, useWindowDimensions, View } from "react-native";

import { cn } from "../../lib/cn";
import { AppText } from "./AppText";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

export interface ListRowContentProps {
  readonly icon?: AppSymbolName;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly disabled?: boolean;
}

/** Shared row geometry; controls own their behavior and accessibility. */
export function ListRowLayout({
  icon,
  label,
  description,
  detail,
  disabled,
  accessory,
  tone = "default",
}: ListRowContentProps & { readonly accessory?: ReactNode; readonly tone?: "default" | "danger" }) {
  const { fontScale } = useWindowDimensions();
  // Leave the label room to wrap at accessibility text sizes.
  const stackDetail = fontScale >= 1.5;
  return (
    <View
      className={cn(
        "min-h-14 flex-row items-center gap-3 px-4 py-3",
        description && "min-h-18",
        disabled && "opacity-45",
      )}
    >
      {icon ? (
        Platform.OS === "android" ? (
          <View className="size-6 items-center justify-center">
            <SymbolView
              name={icon}
              size={24}
              tintColorClassName={tone === "danger" ? "accent-danger-foreground" : "accent-icon"}
              type="monochrome"
              weight="regular"
            />
          </View>
        ) : (
          // Lecturn's iOS rows sit their icon on a glass disc tinted with the accent.
          <View className="h-8 w-8 items-center justify-center rounded-full border border-border-subtle bg-glass-surface">
            <SymbolView
              name={icon}
              size={18}
              tintColorClassName={tone === "danger" ? "accent-danger-foreground" : "accent-primary"}
              type="monochrome"
              weight="regular"
            />
          </View>
        )
      ) : null}
      <View className="min-w-0 flex-1 gap-1">
        <AppText
          textRole="body"
          className={tone === "danger" ? "text-danger-foreground" : "text-foreground"}
        >
          {label}
        </AppText>
        {description ? (
          <AppText textRole="footnote" className="text-foreground-muted">
            {description}
          </AppText>
        ) : null}
        {detail && stackDetail ? (
          <AppText textRole="footnote" className="text-foreground-muted">
            {detail}
          </AppText>
        ) : null}
      </View>
      {detail && !stackDetail ? (
        <AppText
          textRole="footnote"
          className="max-w-[40%] shrink text-right text-foreground-muted"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {detail}
        </AppText>
      ) : null}
      {accessory}
    </View>
  );
}
