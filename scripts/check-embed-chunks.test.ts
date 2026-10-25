import { describe, expect, it } from "@effect/vitest";

import { checkEmbedChunks, embedStartupChunks, type Manifest } from "./check-embed-chunks.ts";

const manifest: Manifest = {
  "index.html": { file: "assets/index.js", isEntry: true },
  "src/main.tsx": { file: "assets/main.js", imports: ["_shared.js"] },
  "src/routes/embed.$environmentId.$projectId.tsx?tsr-split=component": {
    file: "assets/embed.js",
    imports: ["_ChatView.js"],
  },
  "_shared.js": { file: "assets/shared.js" },
  "_ChatView.js": { file: "assets/ChatView.js", imports: ["_shared.js"] },
  "src/components/AppShell.tsx": { file: "assets/AppShell.js", imports: ["_shared.js"] },
};

const forbidden = ["src/components/Sidebar.tsx"];

describe("check-embed-chunks", () => {
  it("follows static imports from the entry, main and the embed route only", () => {
    expect([...embedStartupChunks(manifest)].toSorted()).toEqual([
      "_ChatView.js",
      "_shared.js",
      "index.html",
      "src/main.tsx",
      "src/routes/embed.$environmentId.$projectId.tsx?tsr-split=component",
    ]);
  });

  it("passes when the sidebar lives only in the lazy shell", () => {
    const report = checkEmbedChunks(
      manifest,
      (file) => (file === "assets/AppShell.js" ? ["../../src/components/Sidebar.tsx"] : []),
      forbidden,
    );
    expect(report).toEqual({ violations: [], missingEverywhere: [] });
  });

  it("flags the sidebar once a startup chunk carries it", () => {
    const report = checkEmbedChunks(
      manifest,
      (file) => (file === "assets/shared.js" ? ["../../src/components/Sidebar.tsx"] : []),
      forbidden,
    );
    expect(report.violations).toEqual([
      { module: "src/components/Sidebar.tsx", chunk: "assets/shared.js" },
    ]);
  });

  it("refuses to pass vacuously when no chunk maps the module", () => {
    const report = checkEmbedChunks(manifest, () => [], forbidden);
    expect(report.missingEverywhere).toEqual(forbidden);
  });
});
