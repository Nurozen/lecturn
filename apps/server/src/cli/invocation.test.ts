import { assert, it } from "@effect/vitest";

import { formatCliCommand } from "./invocation.ts";

it("never suggests package runner commands from cache entry paths", () => {
  for (const entryPath of [
    "/home/theo/.npm/_npx/abc123/node_modules/lecturn/dist/bin.mjs",
    "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\lecturn\\dist\\bin.mjs",
    "/home/theo/.cache/pnpm/dlx/abc/node_modules/lecturn/dist/bin.mjs",
    "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/lecturn/dist/bin.mjs",
    "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\lecturn\\dist\\bin.mjs",
    "/home/theo/.bun/install/cache/lecturn@0.0.31/dist/bin.mjs",
    "/tmp/bunx-1000-lecturn@latest/node_modules/lecturn/dist/bin.mjs",
    "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-lecturn@latest\\node_modules\\lecturn\\dist\\bin.mjs",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "lecturn serve",
    );
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/lecturn/dist/bin.mjs",
    "/home/theo/Code/work/lecturn/apps/server/dist/bin.mjs",
    "/home/theo/.lecturn/runtime/0.0.31/node_modules/lecturn/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "lecturn serve",
    );
  }
});

it("never re-suggests the nightly channel, even for nightly builds", () => {
  for (const version of ["0.0.31-nightly.20260729", "0.0.31"]) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/lecturn/dist/bin.mjs",
        version,
      }),
      "lecturn serve",
    );
  }
});

it("formats the requested subcommand", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "connect",
      entryPath: "/tmp/bunx-1000-lecturn@latest/node_modules/lecturn/dist/bin.mjs",
      version: "0.0.31",
    }),
    "lecturn connect",
  );
});
