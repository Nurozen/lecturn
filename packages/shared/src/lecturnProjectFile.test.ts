import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseLecturnProjectFile, LecturnProjectFileFromJson } from "./lecturnProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(LecturnProjectFileFromJson);

describe("LecturnProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });
});

describe("parseLecturnProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseLecturnProjectFile(`{
        /* See https://lecturn.cloudgatherer.net/schema/lecturn.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});
