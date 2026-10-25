// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Host-side tooling with no Effect runtime.
/**
 * Measures the example's Lecturn integration (bar B4: at most 60 lines): the
 * code between `// lecturn:begin` and `// lecturn:end` in every source file.
 * Blank and comment-only lines do not count.
 *
 *   node scripts/count-integration-lines.ts [--max 60] [--snippet <embed-snippet.md>]
 *
 * `--snippet` also measures the first fenced `ts` block of the B4 gold
 * snippet the same way, so the two can be compared. Exits 1 when the example
 * is over `--max`, 2 on unbalanced markers.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const BEGIN = /^\s*\/\/\s*lecturn:begin\b/;
const END = /^\s*\/\/\s*lecturn:end\b/;

interface FileCount {
  readonly file: string;
  readonly lines: number;
}

class MarkerError extends Error {}

const isCode = (line: string) => {
  const trimmed = line.trim();
  return (
    trimmed !== "" &&
    !trimmed.startsWith("//") &&
    !trimmed.startsWith("/*") &&
    !trimmed.startsWith("*")
  );
};

function countMarkedLines(text: string, file: string): number {
  let inside = false;
  let count = 0;
  for (const [index, line] of text.split("\n").entries()) {
    if (BEGIN.test(line)) {
      if (inside) throw new MarkerError(`${file}:${index + 1}: lecturn:begin inside a block`);
      inside = true;
    } else if (END.test(line)) {
      if (!inside) throw new MarkerError(`${file}:${index + 1}: lecturn:end without a begin`);
      inside = false;
    } else if (inside && isCode(line)) {
      count += 1;
    }
  }
  if (inside) throw new MarkerError(`${file}: lecturn:begin is never closed`);
  return count;
}

function countSnippetLines(markdown: string): number {
  const match = /```ts\r?\n([\s\S]*?)```/.exec(markdown);
  if (match === null) throw new MarkerError("the snippet has no fenced ts block");
  return match[1]!.split("\n").filter(isCode).length;
}

function sourceFiles(dir: string): Array<string> {
  return NodeFS.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => NodePath.join(entry.parentPath, entry.name))
    .toSorted();
}

function readFlag(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function main(argv: ReadonlyArray<string>): number {
  const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const max = Number(readFlag(argv, "--max") ?? "60");
  const snippet = readFlag(argv, "--snippet");
  try {
    const counts: Array<FileCount> = sourceFiles(NodePath.join(root, "src"))
      .map((path) => ({
        file: NodePath.relative(root, path),
        lines: countMarkedLines(NodeFS.readFileSync(path, "utf8"), path),
      }))
      .filter((count) => count.lines > 0);
    const total = counts.reduce((sum, count) => sum + count.lines, 0);
    for (const count of counts) console.log(`${count.file}: ${count.lines}`);
    console.log(`total: ${total} (max ${max})`);
    if (snippet !== undefined) {
      console.log(`snippet: ${countSnippetLines(NodeFS.readFileSync(snippet, "utf8"))}`);
    }
    return total > max ? 1 : 0;
  } catch (error) {
    if (!(error instanceof MarkerError)) throw error;
    console.error(error.message);
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
