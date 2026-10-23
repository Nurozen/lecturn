import { Platform } from "react-native";

const FONT_FAMILIES = {
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  bold: "DMSans-Bold",
} as const;

export function useFontFamily(weight: keyof typeof FONT_FAMILIES): string {
  return Platform.OS === "ios" ? "System" : FONT_FAMILIES[weight];
}
