#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a one-shot build check over local files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Asserts the /embed page never loads the app shell. Route code splitting cannot see what the
 * root route imports statically, so a stray import from __root.tsx (or anything the embed route
 * imports) silently drags the sidebar back into the embed's startup graph.
 *
 * Usage: node scripts/check-embed-chunks.ts [apps/web/dist]
 */

export interface ManifestChunk {
  readonly file: string;
  readonly isEntry?: boolean;
  readonly imports?: ReadonlyArray<string>;
}

export type Manifest = Readonly<Record<string, ManifestChunk>>;

export const FORBIDDEN_EMBED_MODULES = [
  "src/components/Sidebar.tsx",
  "src/components/settings/SettingsSidebarNav.tsx",
  "src/components/CommandPalette.tsx",
];

// bootstrap.ts reaches main.tsx through a dynamic import that always runs, so main counts as
// startup code even though the manifest lists it as a dynamic entry.
const ALWAYS_LOADED_ROOTS = new Set(["src/main.tsx"]);
const EMBED_ROUTE_PREFIX = "src/routes/embed.";

/** Manifest keys the embed page loads before its first render: entries, main, embed routes. */
export function embedStartupChunks(manifest: Manifest): ReadonlyArray<string> {
  const roots = Object.keys(manifest).filter(
    (key) =>
      manifest[key]?.isEntry === true ||
      ALWAYS_LOADED_ROOTS.has(key) ||
      key.startsWith(EMBED_ROUTE_PREFIX),
  );
  if (!roots.some((key) => key.startsWith(EMBED_ROUTE_PREFIX))) {
    throw new Error("No /embed route chunk in the manifest; did the embed route move?");
  }
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const key = pending.pop();
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    pending.push(...(manifest[key]?.imports ?? []));
  }
  return [...seen];
}

function normalizeSource(source: string): string {
  return source.replaceAll("\\", "/");
}

function matchesModule(source: string, module: string): boolean {
  const normalized = normalizeSource(source);
  return normalized === module || normalized.endsWith(`/${module}`);
}

export interface EmbedChunkReport {
  readonly violations: ReadonlyArray<{ readonly module: string; readonly chunk: string }>;
  /** Forbidden modules found nowhere in the build: the check would pass vacuously. */
  readonly missingEverywhere: ReadonlyArray<string>;
}

export function checkEmbedChunks(
  manifest: Manifest,
  sourcesOf: (file: string) => ReadonlyArray<string>,
  forbidden: ReadonlyArray<string> = FORBIDDEN_EMBED_MODULES,
): EmbedChunkReport {
  const startup = new Set(embedStartupChunks(manifest).map((key) => manifest[key]?.file));
  const violations: Array<{ module: string; chunk: string }> = [];
  const found = new Set<string>();
  const files = new Set(Object.values(manifest).map((chunk) => chunk.file));
  for (const file of files) {
    const sources = sourcesOf(file);
    for (const module of forbidden) {
      if (!sources.some((source) => matchesModule(source, module))) continue;
      found.add(module);
      if (startup.has(file)) violations.push({ module, chunk: file });
    }
  }
  return {
    violations,
    missingEverywhere: forbidden.filter((module) => !found.has(module)),
  };
}

// Generated chunks (the rolldown runtime, some vendor chunks) ship without maps. A build with
// sourcemaps off has none at all, which surfaces as every forbidden module being "in no chunk".
function readSourceMapSources(distDir: string, file: string): ReadonlyArray<string> {
  const mapPath = NodePath.join(distDir, `${file}.map`);
  if (!file.endsWith(".js") || !NodeFS.existsSync(mapPath)) return [];
  const map = JSON.parse(NodeFS.readFileSync(mapPath, "utf8")) as { sources?: unknown };
  return Array.isArray(map.sources)
    ? map.sources.filter((source): source is string => typeof source === "string")
    : [];
}

function main(argv: ReadonlyArray<string>): number {
  const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const distDir = NodePath.resolve(argv[0] ?? NodePath.join(repoRoot, "apps/web/dist"));
  const manifestPath = NodePath.join(distDir, ".vite/manifest.json");
  if (!NodeFS.existsSync(manifestPath)) {
    process.stderr.write(
      `No manifest at ${manifestPath}; run \`vp run --filter @lecturn/web build\`.\n`,
    );
    return 1;
  }
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as Manifest;
  const report = checkEmbedChunks(manifest, (file) => readSourceMapSources(distDir, file));
  for (const module of report.missingEverywhere) {
    process.stderr.write(
      `${module} is in no mapped chunk; build with sourcemaps or update FORBIDDEN_EMBED_MODULES.\n`,
    );
  }
  for (const { module, chunk } of report.violations) {
    process.stderr.write(`/embed startup graph includes ${module} (in ${chunk}).\n`);
  }
  if (report.missingEverywhere.length > 0 || report.violations.length > 0) return 1;
  process.stdout.write(
    `/embed startup graph (${embedStartupChunks(manifest).length} chunks) excludes ${FORBIDDEN_EMBED_MODULES.join(", ")}.\n`,
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
