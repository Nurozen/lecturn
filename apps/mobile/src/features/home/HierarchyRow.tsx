import type { ReactNode } from "react";
import { View } from "react-native";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useGlassPalette } from "../../lib/useGlassPalette";
import type { SidebarHierarchyLine } from "../threads/sidebar-hierarchy";
import type { AccountSectionFrame } from "./accountSectionFrames";

/** Row fragments meet without gaps, retaining list recycling and independent row actions. */
export function HierarchyRow({
  depth,
  settled,
  frame,
  guides,
  children,
}: {
  readonly depth: number;
  readonly settled: boolean;
  readonly frame: AccountSectionFrame | undefined;
  readonly guides: readonly SidebarHierarchyLine[] | undefined;
  readonly children: ReactNode;
}) {
  const { accent, light, dark, opaque } = useGlassPalette();
  const rail = opaque ? accent : themeColorWithAlpha(light, dark ? 0.64 : 0.7);
  const red = dark ? "#e99080" : "#ad3c2f";
  return (
    <View
      style={{
        marginHorizontal: 12,
        paddingTop: frame?.first ? 12 : 0,
        paddingBottom: frame?.last ? 12 : 0,
      }}
    >
      <View
        pointerEvents="none"
        accessible={false}
        className={opaque ? "bg-card" : undefined}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: frame?.first ? 12 : 0,
          bottom: frame?.last ? 12 : 0,
          borderLeftWidth: 2,
          borderRightWidth: 1,
          borderTopWidth: frame?.first ? 1 : 0,
          borderBottomWidth: frame?.last ? 1 : 0,
          borderColor: themeColorWithAlpha(accent, dark ? 0.25 : 0.3),
          borderLeftColor: rail,
          borderTopLeftRadius: frame?.first ? 16 : 0,
          borderTopRightRadius: frame?.first ? 16 : 0,
          borderBottomLeftRadius: frame?.last ? 16 : 0,
          borderBottomRightRadius: frame?.last ? 16 : 0,
          ...(!opaque
            ? {
                experimental_backgroundImage: `linear-gradient(90deg, ${themeColorWithAlpha(accent, dark ? 0.075 : 0.045)} 0%, #ffffff00 28%)`,
              }
            : {}),
        }}
      />
      <View style={{ paddingLeft: depth * 18 + 4, paddingRight: 4 }}>
        {guides?.map(({ level, continues }) => {
          const color = settled && level === depth - 1 ? red : rail;
          return (
            <View
              key={level}
              pointerEvents="none"
              accessible={false}
              style={{
                position: "absolute",
                left: level * 18 + 14,
                top: 0,
                bottom: continues ? 0 : "50%",
                width: 1,
                borderRadius: 1,
                backgroundColor: color,
                ...(!opaque ? { boxShadow: `0 0 3px ${themeColorWithAlpha(color, 0.2)}` } : {}),
              }}
            />
          );
        })}
        {depth > 0 ? (
          <View
            pointerEvents="none"
            accessible={false}
            style={{
              position: "absolute",
              left: (depth - 1) * 18 + 14,
              top: "50%",
              width: 12,
              height: 1,
              backgroundColor: settled ? red : rail,
              borderRadius: 1,
            }}
          />
        ) : null}
        {children}
      </View>
    </View>
  );
}
