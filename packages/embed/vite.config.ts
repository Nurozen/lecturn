import { defineConfig } from "vite-plus";

const isElectron = (id: string) => id === "electron" || id.startsWith("electron/");

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack",
        cache: false,
      },
    },
  },
  pack: [
    {
      format: "esm",
      outDir: "dist",
      dts: true,
      tsconfig: "../tsconfig.embed-dts.json",
      sourcemap: true,
      clean: true,
      platform: "node",
      entry: ["src/node.ts", "src/electron.ts", "src/renderer.ts", "src/browser.ts"],
      deps: { neverBundle: isElectron },
    },
    {
      // Sandboxed preloads cannot load ES modules or resolve package imports,
      // so this entry is one self-contained CommonJS file.
      format: "cjs",
      outDir: "dist",
      dts: false,
      sourcemap: true,
      clean: false,
      platform: "node",
      outExtensions: () => ({ js: ".cjs" }),
      outputOptions: { codeSplitting: false },
      entry: ["src/electron-preload.ts"],
      deps: { neverBundle: isElectron },
    },
  ],
});
