import { Platform } from "react-native";

const FONT_FAMILIES = {
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  bold: "DMSans-Bold",
} as const;

/**
 * Resolves a font family for APIs that require a style object or native prop.
 * Prefer Uniwind font classes when the target component accepts `className`.
 * iOS uses the system family for every weight: style objects must also set
 * fontWeight (500 for medium, 700 for bold), or use the native API's weight prop.
 */
export function useFontFamily(weight: keyof typeof FONT_FAMILIES): string {
  return Platform.OS === "ios" ? "System" : FONT_FAMILIES[weight];
}
