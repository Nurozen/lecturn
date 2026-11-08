import { StackActions, useNavigation } from "@react-navigation/native";
import { Platform } from "react-native";

import { useSelectWorkspaceDetail } from "./useSelectWorkspaceDetail";

/**
 * Opens a thread from a page drilled into from the workspace (Squire, Decisions, Contextual,
 * PR watch, an app's threads). iOS pushes it over the page so Back returns there; Android
 * selects it, as returning to the Android workspace list expects.
 */
export function useOpenThreadOverPage() {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  return (params: ReactNavigation.RootParamList["Thread"]) => {
    if (Platform.OS === "android") selectDetail({ name: "Thread", params });
    else navigation.dispatch(StackActions.push("Thread", params));
  };
}
