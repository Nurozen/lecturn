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
  <symbol id="lecturn-file-icon-claude" viewBox="-4 -3 132 132"><g fill="#D97757"><path d="M78.44 37.78C64.76 30.26 48.27 35.96 39.98 48.65C31.09 62.18 34.82 79.81 47.36 89.16C56.48 95.92 69.24 97.29 79.66 90.75C64.99 93.03 52.07 81.02 51.16 66.43C50.09 51.76 62.33 37.70 78.44 37.78Z"/><path d="M86.75 85.06 L102.80 102.99 Q101.47 105.62 98.72 106.66 L82.57 88.82Z"/><path d="M73.68 93.45 L81.69 124.46 Q79.48 126.10 76.76 125.69 L69.28 94.55Z"/><path d="M63.03 94.98 L60.40 119.88 Q58.04 120.69 55.91 119.41 L58.51 94.51Z"/><path d="M51.00 92.14 L34.81 120.95 Q31.50 120.29 29.27 117.76 L46.13 89.33Z"/><path d="M41.40 85.22 L19.68 102.95 Q17.37 101.76 16.69 99.25 L38.54 81.69Z"/><path d="M35.30 75.71 L3.04 86.56 Q1.23 84.40 1.42 81.58 L33.89 71.39Z"/><path d="M33.00 64.11 L3.04 61.72 Q2.24 58.60 3.57 55.66 L33.49 58.51Z"/><path d="M35.42 51.99 L10.39 39.36 Q10.54 36.76 12.55 35.12 L37.48 47.94Z"/><path d="M42.00 42.16 L19.41 16.70 Q20.70 14.19 23.37 13.26 L45.43 39.18Z"/><path d="M50.80 35.95 L41.86 11.48 Q44.16 9.50 47.20 9.53 L56.08 34.03Z"/><path d="M63.35 33.01 L64.77 0.00 Q67.40 -0.91 69.92 0.27 L67.89 33.24Z"/><path d="M75.51 35.22 L87.71 9.97 Q90.30 10.07 91.98 12.06 L79.59 37.21Z"/><path d="M85.06 41.25 L102.99 25.20 Q105.62 26.53 106.66 29.28 L88.82 45.43Z"/></g></symbol>
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
