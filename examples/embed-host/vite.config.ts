import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack",
        dependsOn: ["@lecturn/embed#build"],
        cache: false,
      },
    },
  },
  pack: {
    format: "esm",
    outDir: "dist",
    dts: false,
    sourcemap: true,
    clean: true,
    platform: "node",
    entry: ["src/main.ts"],
    // The helper resolves its preload next to its own module, so it must load
    // from its packed dist rather than being inlined here.
    deps: {
      neverBundle: (id: string) =>
        id === "electron" || id.startsWith("electron/") || id.startsWith("@lecturn/embed"),
    },
  },
});
