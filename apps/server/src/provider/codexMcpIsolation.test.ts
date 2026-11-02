import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CodexMcpServerList,
  codexConfiguredMcpServerNames,
  codexMcpServersOffArg,
  codexMcpServersOffConfig,
} from "./codexMcpIsolation.ts";

const decodeCodexMcpServerList = Schema.decodeEffect(CodexMcpServerList);

describe("codexMcpIsolation", () => {
  it("names every server to turn off, keeping a dotted name one key", () => {
    assert.isNull(codexMcpServersOffArg([]));
    assert.equal(
      codexMcpServersOffArg(["github", "acme.docs"]),
      'mcp_servers={"github"={enabled=false},"acme.docs"={enabled=false}}',
    );
    assert.deepEqual(codexMcpServersOffConfig(["github", "acme.docs"]), {
      github: { enabled: false },
      "acme.docs": { enabled: false },
    });
  });

  it("reads server names from app-server config, and nothing from anything else", () => {
    assert.deepEqual(
      codexConfiguredMcpServerNames({
        model: "gpt-5.4",
        mcp_servers: { github: { command: "gh-mcp" }, "acme.docs": { url: "https://x" } },
      }),
      ["github", "acme.docs"],
    );
    for (const config of [{}, { mcp_servers: null }, { mcp_servers: ["github"] }, null, "x"]) {
      assert.deepEqual(codexConfiguredMcpServerNames(config), []);
    }
  });

  it.effect("decodes `codex mcp list --json`", () =>
    Effect.gen(function* () {
      const servers = yield* decodeCodexMcpServerList(
        '[{"name":"github","enabled":true,"transport":{"type":"stdio"}}]',
      );
      assert.deepEqual(servers, [{ name: "github", enabled: true }]);
    }),
  );
});
