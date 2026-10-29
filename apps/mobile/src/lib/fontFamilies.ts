import { Platform } from "react-native";

const DM_SANS = {
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  bold: "DMSans-Bold",
} as const;

/**
 * iOS uses the system family for every weight: style objects must also set
 * fontWeight (500 for medium, 700 for bold), or use the native API's weight prop.
 */
export const FONT_FAMILIES: Readonly<Record<keyof typeof DM_SANS, string>> =
  Platform.OS === "ios" ? { regular: "System", medium: "System", bold: "System" } : DM_SANS;
