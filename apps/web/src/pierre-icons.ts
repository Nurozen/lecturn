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
  <symbol id="lecturn-file-icon-agents" viewBox="0 0 32 32">
    <path fill="currentColor" d="M27.2 16c0-6.19-5.01-11.2-11.2-11.2C9.81 4.8 4.8 9.81 4.8 16S9.81 27.2 16 27.2c6.19 0 11.2-5.01 11.2-11.2Zm-5.6 2.1a1.4 1.4 0 1 1 0 2.8h-4.2a1.4 1.4 0 1 1 0-2.8Zm-11.2-6.8c.622-.373 1.42-.208 1.84.361l.079.119 2.1 3.5.088.171c.15.351.15.748 0 1.1l-.088.171-2.1 3.5a1.4 1.4 0 0 1-2.4-1.44L11.59 16l-1.67-2.78-.067-.127c-.302-.642-.075-1.42.547-1.79ZM30 16c0 7.73-6.27 14-14 14S2 23.73 2 16 8.27 2 16 2s14 6.27 14 14Z" />
  </symbol>
  <!-- Original Lecturn Claude emblem; also the source for the native file icon. -->
  <symbol id="lecturn-file-icon-claude" viewBox="-4 -3 132 132"><g fill="#D97757"><path d="M78.44 37.78C64.76 30.26 48.27 35.96 39.98 48.65C31.09 62.18 34.82 79.81 47.36 89.16C56.48 95.92 69.24 97.29 79.66 90.75C64.99 93.03 52.07 81.02 51.16 66.43C50.09 51.76 62.33 37.70 78.44 37.78Z"/><path d="M86.75 85.06 L102.80 102.99 Q101.47 105.62 98.72 106.66 L82.57 88.82Z"/><path d="M73.68 93.45 L81.69 124.46 Q79.48 126.10 76.76 125.69 L69.28 94.55Z"/><path d="M63.03 94.98 L60.40 119.88 Q58.04 120.69 55.91 119.41 L58.51 94.51Z"/><path d="M51.00 92.14 L34.81 120.95 Q31.50 120.29 29.27 117.76 L46.13 89.33Z"/><path d="M41.40 85.22 L19.68 102.95 Q17.37 101.76 16.69 99.25 L38.54 81.69Z"/><path d="M35.30 75.71 L3.04 86.56 Q1.23 84.40 1.42 81.58 L33.89 71.39Z"/><path d="M33.00 64.11 L3.04 61.72 Q2.24 58.60 3.57 55.66 L33.49 58.51Z"/><path d="M35.42 51.99 L10.39 39.36 Q10.54 36.76 12.55 35.12 L37.48 47.94Z"/><path d="M42.00 42.16 L19.41 16.70 Q20.70 14.19 23.37 13.26 L45.43 39.18Z"/><path d="M50.80 35.95 L41.86 11.48 Q44.16 9.50 47.20 9.53 L56.08 34.03Z"/><path d="M63.35 33.01 L64.77 0.00 Q67.40 -0.91 69.92 0.27 L67.89 33.24Z"/><path d="M75.51 35.22 L87.71 9.97 Q90.30 10.07 91.98 12.06 L79.59 37.21Z"/><path d="M85.06 41.25 L102.99 25.20 Q105.62 26.53 106.66 29.28 L88.82 45.43Z"/></g></symbol>
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
    "package.json": "file-tree-builtin-npm",
    "tsconfig.json": "file-tree-builtin-typescript",
    "agents.md": "lecturn-file-icon-agents",
    "claude.md": "lecturn-file-icon-claude",
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
