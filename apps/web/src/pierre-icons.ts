import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
  type FileTreeIcons,
} from "@pierre/trees";
import { VIDEO_FILE_EXTENSIONS } from "@lecturn/shared/video";

export interface PierreIconResolution {
  name: string;
  token?: string;
}

const PIERRE_ICON_SPRITE_ID = "lecturn-pierre-file-icon-sprite";

const LECTURN_FILE_ICON_SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
  <!-- Lucide Film icon, ISC license. -->
  <symbol id="lecturn-file-icon-video" viewBox="0 0 24 24">
    <g fill="none" stroke="#a631be" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M7 3v18M3 7.5h4M3 12h18M3 16.5h4M17 3v18M17 7.5h4M17 16.5h4" />
    </g>
  </symbol>
  <symbol id="lecturn-file-icon-package-json" viewBox="0 0 32 32">
    <path d="M2 2H30V30H2" fill="#c12127" />
    <path d="M7.25 7.25h17.5v17.5h-3.5v-14H16v14H7.25" fill="#fff" />
  </symbol>
  <symbol id="lecturn-file-icon-tsconfig" viewBox="0 0 32 32">
    <path d="M23.827 8.243a4.424 4.424 0 0 1 2.223 1.281 5.853 5.853 0 0 1 .852 1.143c.011.045-1.534 1.083-2.471 1.662-.034.023-.169-.124-.322-.35a2.014 2.014 0 0 0-1.67-1c-1.077-.074-1.771.49-1.766 1.433a1.3 1.3 0 0 0 .153.666c.237.49.677.784 2.059 1.383 2.544 1.1 3.636 1.817 4.31 2.843a5.158 5.158 0 0 1 .416 4.333 4.764 4.764 0 0 1-3.932 2.815 10.9 10.9 0 0 1-2.708-.028 6.531 6.531 0 0 1-3.616-1.884 6.278 6.278 0 0 1-.926-1.371 2.655 2.655 0 0 1 .327-.208c.158-.09.756-.434 1.32-.761l1.024-.6.214.312a4.771 4.771 0 0 0 1.35 1.292 3.3 3.3 0 0 0 3.458-.175 1.545 1.545 0 0 0 .2-1.974c-.276-.4-.84-.727-2.443-1.422a8.8 8.8 0 0 1-3.349-2.055 4.687 4.687 0 0 1-.976-1.777 7.116 7.116 0 0 1-.062-2.268 4.332 4.332 0 0 1 3.644-3.374 9 9 0 0 1 2.71.01ZM15.484 9.726l.011 1.454h-4.63v13.148H7.6V11.183H2.97V9.755a13.986 13.986 0 0 1 .04-1.466c.017-.023 2.832-.034 6.245-.028l6.211.017Z" fill="#007acc" />
    <path d="m27.075 25.107.363-.361c1.68.055 1.706 0 1.78-.177l.462-1.124.034-.107-.038-.093c-.02-.049-.081-.2-1.13-1.2v-.526c1.211-1.166 1.185-1.226 1.116-1.4l-.46-1.136c-.069-.17-.1-.237-1.763-.191l-.364-.367a8.138 8.138 0 0 0-.057-1.657l-.047-.106-1.2-.525c-.177-.081-.239-.11-1.372 1.124l-.509-.008c-1.167-1.245-1.222-1.223-1.4-1.152l-1.115.452c-.175.071-.236.1-.169 1.79l-.36.359c-1.68-.055-1.7 0-1.778.177L18.606 20l-.036.108.038.094c.02.048.078.194 1.13 1.2v.525c-1.211 1.166-1.184 1.226-1.115 1.4l.459 1.137c.07.174.1.236 1.763.192l.363.377a8.169 8.169 0 0 0 .055 1.654l.047.107 1.208.528c.176.073.236.1 1.366-1.13l.509.006c1.168 1.247 1.228 1.223 1.4 1.154l1.113-.45c.176-.075.237-.102.169-1.795Zm-4.788-2.632a2 2 0 1 1 2.618 1.14 2.023 2.023 0 0 1-2.618-1.14Z" fill="#99b8c4" />
  </symbol>
  <symbol id="lecturn-file-icon-agents" viewBox="0 0 32 32">
    <path fill="currentColor" d="M27.2 16c0-6.19-5.01-11.2-11.2-11.2C9.81 4.8 4.8 9.81 4.8 16S9.81 27.2 16 27.2c6.19 0 11.2-5.01 11.2-11.2Zm-5.6 2.1a1.4 1.4 0 1 1 0 2.8h-4.2a1.4 1.4 0 1 1 0-2.8Zm-11.2-6.8c.622-.373 1.42-.208 1.84.361l.079.119 2.1 3.5.088.171c.15.351.15.748 0 1.1l-.088.171-2.1 3.5a1.4 1.4 0 0 1-2.4-1.44L11.59 16l-1.67-2.78-.067-.127c-.302-.642-.075-1.42.547-1.79ZM30 16c0 7.73-6.27 14-14 14S2 23.73 2 16 8.27 2 16 2s14 6.27 14 14Z" />
  </symbol>
  <!-- Original Lecturn Claude emblem; also the source for the native file icon. -->
  <symbol id="lecturn-file-icon-claude" viewBox="-8 -8 144 144"><g fill="#D97757"><path d="M83 29.5C65 19.6 43.3 27.1 32.4 43.8C20.7 61.6 25.6 84.8 42.1 97.1C54.1 106 70.9 107.8 84.6 99.2C65.3 102.2 48.3 86.4 47.1 67.2C45.7 47.9 61.8 29.4 83 29.5Z"/><path d="M89.72 95.99 L97.46 107.67 Q97.50 110.11 95.76 109.90 L86.66 98.59Z"/><path d="M77.95 103.59 L82.74 123.02 Q81.61 125.42 79.74 124.71 L73.23 105.25Z"/><path d="M62.86 106.82 L61.40 119.75 Q59.97 121.66 58.87 120.38 L59.15 106.87Z"/><path d="M50.28 102.72 L42.17 119.91 Q39.77 121.07 38.77 119.34 L45.56 101.04Z"/><path d="M37.45 96.48 L26.30 107.96 Q23.92 108.51 23.77 106.77 L34.28 94.02Z"/><path d="M27.66 86.72 L8.09 96.79 Q5.58 96.39 5.93 94.54 L25.21 82.93Z"/><path d="M23.90 72.88 L8.96 74.49 Q6.71 73.07 7.65 71.31 L22.82 67.99Z"/><path d="M22.60 57.24 L2.18 52.29 Q0.52 50.51 1.96 49.50 L23.14 53.27Z"/><path d="M26.54 43.19 L13.32 34.15 Q12.44 31.78 14.20 31.22 L28.61 39.29Z"/><path d="M36.79 33.23 L25.07 17.01 Q25.21 14.36 27.21 14.32 L40.54 29.92Z"/><path d="M49.15 24.77 L45.39 11.27 Q46.11 8.93 47.70 9.68 L52.86 23.25Z"/><path d="M63.84 21.13 L65.66 0.20 Q67.44 -1.71 68.91 -0.43 L68.65 21.08Z"/><path d="M78.85 25.73 L85.91 11.36 Q88.00 10.10 88.68 11.72 L82.63 27.08Z"/><path d="M90.74 31.69 L99.16 23.12 Q101.40 22.46 101.43 24.10 L93.54 33.81Z"/></g></symbol>
  <symbol id="lecturn-file-icon-readme" viewBox="0 0 32 32">
    <rect x="2.5" y="7.955" width="27" height="16.091" fill="none" stroke="#b48a5a" />
    <path fill="#b48a5a" d="M5.909 20.636v-9.272h2.727l2.728 3.409 2.727-3.409h2.727v9.272h-2.727v-5.318l-2.727 3.409-2.728-3.409v5.318H5.91Zm17.046 0-4.091-4.5h2.727v-4.772h2.727v4.772h2.727l-4.09 4.5Z" />
  </symbol>
  <symbol id="lecturn-file-icon-pnpm" viewBox="0 0 32 32">
    <path fill="#f9ad00" d="M30 10.75h-8.749V2H30Zm-9.626 0h-8.75V2h8.75Zm-9.625 0H2V2h8.749ZM30 20.375h-8.749v-8.75H30Z" />
    <path fill="currentColor" d="M20.374 20.375h-8.75v-8.75h8.75Zm0 9.625h-8.75v-8.75h8.75ZM30 30h-8.749v-8.75H30Zm-19.251 0H2v-8.75h8.749Z" />
  </symbol>
</svg>`;

export const LECTURN_PIERRE_ICONS = {
  set: "complete",
  colored: true,
  spriteSheet: LECTURN_FILE_ICON_SPRITE,
  byFileName: {
    "package.json": "lecturn-file-icon-package-json",
    "tsconfig.json": "lecturn-file-icon-tsconfig",
    "agents.md": "lecturn-file-icon-agents",
    "claude.md": "lecturn-file-icon-claude",
    "readme.md": "lecturn-file-icon-readme",
    "pnpm-lock.yaml": "lecturn-file-icon-pnpm",
    "pnpm-workspace.yaml": "lecturn-file-icon-pnpm",
  },
  byFileExtension: Object.fromEntries(
    VIDEO_FILE_EXTENSIONS.map((extension) => [extension, "lecturn-file-icon-video"]),
  ),
} satisfies FileTreeIcons;

const completeIconResolver = createFileTreeIconResolver(LECTURN_PIERRE_ICONS);

const LANGUAGE_EXTENSION_ALIASES: Record<string, string> = {
  bash: "sh",
  csharp: "cs",
  dockerfile: "dockerfile",
  javascript: "js",
  jsx: "jsx",
  markdown: "md",
  mdx: "mdx",
  plaintext: "txt",
  python: "py",
  ruby: "rb",
  rust: "rs",
  shell: "sh",
  shellscript: "sh",
  swift: "swift",
  typescript: "ts",
  tsx: "tsx",
  yaml: "yml",
};

export function basenameOfPath(pathValue: string): string {
  const slashIndex = pathValue.lastIndexOf("/");
  return slashIndex === -1 ? pathValue : pathValue.slice(slashIndex + 1);
}

export function inferEntryKindFromPath(pathValue: string): "file" | "directory" {
  const base = basenameOfPath(pathValue);
  if (base.startsWith(".") && !base.slice(1).includes(".")) return "directory";
  return base.includes(".") ? "file" : "directory";
}

export function syntheticFileNameForLanguageId(languageId: string): string {
  const normalized = languageId.toLowerCase();
  return `file.${LANGUAGE_EXTENSION_ALIASES[normalized] ?? normalized}`;
}

export function resolvePierreIconForEntry(
  pathValue: string,
  kind: "file" | "directory",
): PierreIconResolution | null {
  if (kind === "directory") return null;
  return completeIconResolver.resolveIcon("file-tree-icon-file", pathValue);
}

export function hasSpecificPierreIconForFileName(fileName: string): boolean {
  return resolvePierreIconForEntry(fileName, "file")?.token !== "default";
}

export function ensurePierreIconSprite(): void {
  if (typeof document === "undefined" || document.getElementById(PIERRE_ICON_SPRITE_ID)) return;
  const container = document.createElement("div");
  container.id = PIERRE_ICON_SPRITE_ID;
  container.setAttribute("aria-hidden", "true");
  container.style.position = "absolute";
  container.style.width = "0";
  container.style.height = "0";
  container.style.overflow = "hidden";
  container.style.pointerEvents = "none";
  // Pierre includes a vendor Claude mark even when our filename mapping overrides it.
  // Replace that built-in symbol too, so no unused vendor mark is inserted in the DOM.
  const claudeSymbol = LECTURN_FILE_ICON_SPRITE.match(
    /<symbol id="lecturn-file-icon-claude"[\s\S]*?<\/symbol>/,
  )![0].replace("lecturn-file-icon-claude", "file-tree-builtin-claude");
  const builtInSprite = getBuiltInSpriteSheet("complete").replace(
    /<symbol id="file-tree-builtin-claude"[\s\S]*?<\/symbol>/,
    claudeSymbol,
  );
  container.innerHTML = `${builtInSprite}${LECTURN_FILE_ICON_SPRITE}`;
  document.body.prepend(container);
}
