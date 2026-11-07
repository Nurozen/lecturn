// @effect-diagnostics nodeBuiltinImport:off -- the bundler API reads and writes a real temporary output directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { parse } from "acorn";
import { build } from "vite-plus/pack";
import { assert, it } from "vite-plus/test";

import desktopConfig from "../../vite.config.ts";

const desktopRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));

interface SyntaxNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

const isSyntaxNode = (value: unknown): value is SyntaxNode =>
  typeof value === "object" && value !== null && typeof (value as SyntaxNode).type === "string";

/** Every require() specifier the bundle would ask the Electron sandbox for at runtime. */
function bundleRequires(source: string): string[] {
  const requires: string[] = [];
  const visit = (node: SyntaxNode) => {
    const callee = node.callee;
    if (node.type === "CallExpression" && isSyntaxNode(callee) && callee.name === "require") {
      const [argument] = node.arguments as SyntaxNode[];
      requires.push(typeof argument?.value === "string" ? argument.value : "<dynamic>");
    }
    for (const child of Object.values(node)) {
      for (const item of Array.isArray(child) ? child : [child]) {
        if (isSyntaxNode(item)) visit(item);
      }
    }
  };
  visit(parse(source, { ecmaVersion: "latest", sourceType: "script" }) as unknown as SyntaxNode);
  return requires;
}

// oxlint-disable-next-line lecturn/no-test-timeout-or-unreasoned-skip -- CPU-bound real bundle build, not a hidden wait.
it("bundles the sandboxed activity preload without runtime requires beyond electron", async () => {
  const packConfig = (Array.isArray(desktopConfig.pack) ? desktopConfig.pack : []).find(
    (config) => Array.isArray(config.entry) && config.entry.includes("src/activity-preload.ts"),
  );
  assert.ok(packConfig, "activity preload pack entry");
  const outDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-activity-preload-"));
  try {
    await build({
      ...packConfig,
      config: false,
      cwd: desktopRoot,
      outDir,
      clean: false,
      sourcemap: false,
      logLevel: "silent",
    });
    const source = await NodeFSP.readFile(NodePath.join(outDir, "activity-preload.cjs"), "utf8");
    assert.deepStrictEqual(
      [...new Set(bundleRequires(source))].filter((specifier) => specifier !== "electron"),
      [],
    );
  } finally {
    await NodeFSP.rm(outDir, { recursive: true, force: true });
  }
}, 60_000);
