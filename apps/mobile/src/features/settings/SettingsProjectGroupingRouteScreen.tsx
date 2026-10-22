import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useGlassPalette } from "../../lib/useGlassPalette";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { SidebarProjectGroupingMode } from "@lecturn/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  mobileProjectGroupingModePatch,
  resolveMobileProjectGroupingSettings,
} from "../../state/project-grouping";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useSidebarNestSagas } from "../../state/stave";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";

const GROUPING_OPTIONS: ReadonlyArray<{
  readonly mode: SidebarProjectGroupingMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "repository",
    label: "Group by repository",
    description: "Matching repositories appear as one project.",
  },
  {
    mode: "repository_path",
    label: "Group by repository path",
    description: "Keep monorepo paths separate.",
  },
  {
    mode: "separate",
    label: "Keep separate",
    description: "Show every workspace as its own project.",
  },
];

export function SettingsProjectGroupingRouteScreen() {
  const glass = useGlassPalette();
  const nestSagas = useSidebarNestSagas();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedMode = AsyncResult.isSuccess(preferencesResult)
    ? resolveMobileProjectGroupingSettings(preferencesResult.value).sidebarProjectGroupingMode
    : null;

  return (
    <SettingsScreen title="Organization">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Project grouping">
          {GROUPING_OPTIONS.map((option, index) => (
            <SettingsChoiceRow
              key={option.mode}
              label={option.label}
              description={option.description}
              selected={selectedMode === option.mode}
              separated={index > 0}
              disabled={!preferencesReady}
              onPress={() => savePreferences(mobileProjectGroupingModePatch(option.mode))}
            />
          ))}
        </SettingsSection>
        <SettingsSection title="Stave sagas">
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: nestSagas, disabled: !preferencesReady }}
            disabled={!preferencesReady}
            onPress={() => savePreferences({ sidebarNestSagas: !nestSagas })}
            style={({ pressed }) => ({
              backgroundColor: pressed
                ? themeColorWithAlpha(glass.accent, glass.dark ? 0.12 : 0.07)
                : "transparent",
              opacity: preferencesReady ? 1 : 0.5,
            })}
            className="flex-row items-center gap-4 p-4"
          >
            <View className="min-w-0 flex-1 gap-1">
              <Text className="text-base text-foreground">Nest saga members</Text>
              <Text className="text-sm text-foreground-muted">
                Use dependency order in the tablet sidebar and legacy list.
              </Text>
            </View>
            <Text className="text-sm text-foreground-muted">{nestSagas ? "On" : "Off"}</Text>
          </Pressable>
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
