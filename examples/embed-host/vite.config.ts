import { defineConfig } from "vite-plus";

const isElectron = (id: string) => id === "electron" || id.startsWith("electron/");

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack",
        // The sidecar runs Lecturn's built server, which serves the embed
        // route from its built web client.
        dependsOn: ["lecturn#build", "@lecturn/embed#build"],
        cache: false,
      },
    },
  },
  pack: [
    {
      format: "esm",
      outDir: "dist",
      dts: false,
      sourcemap: true,
      clean: true,
      platform: "node",
      entry: {
        main: "src/main.ts",
        "static-main": "src/staticMain.ts",
        "counter-mcp": "tools/counter-mcp.ts",
      },
      // The helper resolves its preload next to its own module, so it must load
      // from its packed dist rather than being inlined here.
      deps: {
        neverBundle: (id: string) =>
          isElectron(id) || id.startsWith("@lecturn/embed") || id === "lecturn",
      },
    },
    {
      // Sandboxed preloads cannot load ES modules or resolve package imports.
      format: "cjs",
      outDir: "dist",
      dts: false,
      sourcemap: true,
      clean: false,
      platform: "node",
      outExtensions: () => ({ js: ".cjs" }),
      outputOptions: { codeSplitting: false },
      entry: { preload: "src/preload.ts" },
      deps: { neverBundle: isElectron, alwaysBundle: [/^@lecturn\/embed/] },
    },
    {
      // A sandboxed file:// page loads one classic script.
      format: "iife",
      outDir: "dist/renderer",
      dts: false,
      sourcemap: true,
      clean: false,
      platform: "browser",
      entry: { renderer: "src/renderer/main.ts" },
      deps: { alwaysBundle: [/^@lecturn\/embed/] },
      copy: [{ from: "src/renderer/index.html", to: "dist/renderer" }],
    },
  ],
});
