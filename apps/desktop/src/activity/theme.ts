import {
  activityVisualColor,
  type ActivityVisualState,
} from "@lecturn/client-runtime/state/activityContext";

// The app already sets Electron.nativeTheme through its theme preference bridge.
// Its media query propagates both app overrides and live system changes to every
// window, including this isolated panel before the activity bridge connects.
const dark = {
  text: "#f3ede0",
  bar: "#000",
  muted: "#a9acb3",
  detail: "#b8bbc0",
  accent: "#e6bc63",
  "accent-text": "#dfc58f",
  border: "#303a4a",
  divider: "#293248",
  "control-border": "#455166",
  "shell-border": "#5c5034",
  control: "#192639",
  input: "#101a2b",
  "on-accent": "#162032",
  card: "#0b1e2bdc",
  "wallpaper-top": "#05131fd9",
  "wallpaper-bottom": "#05131fe8",
  sheen: "#c8995455",
  "subtle-border": "#b8904933",
  hover: "#e6bc6312",
  "failed-border": "#f0786877",
  "complete-border": "#56c5a144",
  "offline-border": "#a6adb655",
  "thread-trail": "#c8995433",
  "thread-highlight": "#fff0bd",
  "thread-base": "#c89954",
};

const light: typeof dark = {
  text: "#342f26",
  bar: "#f3eddf",
  muted: "#686455",
  detail: "#625a4d",
  accent: "#e2b968",
  "accent-text": "#815519",
  border: "#c4b797",
  divider: "#d4c7ac",
  "control-border": "#a79777",
  "shell-border": "#a28a5a",
  control: "#f8f2e6",
  input: "#fffaf0",
  "on-accent": "#302719",
  card: "#fffaf0ed",
  "wallpaper-top": "#f3eddfeb",
  "wallpaper-bottom": "#f3eddfef",
  sheen: "#98671866",
  "subtle-border": "#9b783d66",
  hover: "#98671812",
  "failed-border": "#b33f32aa",
  "complete-border": "#24745b88",
  "offline-border": "#62687399",
  "thread-trail": "#986718cc",
  "thread-highlight": "#68400b",
  "thread-base": "#986718",
};

export function activityStateColorVariable(state: ActivityVisualState): string {
  return `var(--activity-${state})`;
}

function themeDeclarations(appearance: "light" | "dark"): string {
  const palette = appearance === "light" ? light : dark;
  const states = ["active", "attention", "failed", "complete", "idle", "offline"] as const;
  return [
    ...Object.entries(palette).map(([name, value]) => `--activity-${name}:${value}`),
    ...states.map((state) => `--activity-${state}:${activityVisualColor(state, appearance)}`),
  ].join(";");
}

export const activityThemeStyles = `:root{${themeDeclarations("dark")}}\n@media(prefers-color-scheme:light){:root{${themeDeclarations("light")}}}`;
