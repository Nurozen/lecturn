// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GithubCopilotSettings } from "@lecturn/contracts";

import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
  parseCopilotConfigLogin,
  parseCopilotHelpConfigModels,
  resolveCopilotAuth,
} from "./CopilotProvider.ts";

const decodeSettings = Schema.decodeSync(GithubCopilotSettings);
const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);
/** Single-quotes a value for the generated `/bin/sh` script. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Captured from `copilot help config` (GitHub Copilot CLI 1.0.88). */
const HELP_CONFIG_FIXTURE = `  \`banner\`: frequency of showing animated banner; defaults to "once".
    - "always" displays it every time
    - "never" disables it

  \`logLevel\`: log level for CLI; defaults to "default". Set to "all" for debug logging.

  \`model\`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.
    - "claude-sonnet-5"
    - "claude-fable-5.1"
    - "claude-fable-5"
    - "claude-opus-5"
    - "claude-opus-4.8"
    - "claude-opus-4.8-fast"
    - "claude-opus-4.7"
    - "claude-sonnet-4.6"
    - "claude-haiku-4.5"
    - "gpt-6-astra"
    - "gpt-5.6-sol"
    - "gpt-5.6-terra"
    - "gpt-5.6-luna"
    - "gpt-5.5"
    - "gpt-5.4"
    - "gpt-5.4-mini"
    - "gpt-5.3-codex"
    - "gpt-5-mini"
    - "mai-code-1.1-flash"
    - "gemini-3.8-flash"
    - "gemini-3.7-flash"
    - "gemini-3.6-flash"
    - "gemini-3.5-flash"
    - "grok-4.5"
    - "kimi-k3"
    - "kimi-k2.7-code"

  \`contextTier\`: context window tier for tiered-pricing models (e.g., "default" or "long_context").
    - Can also be set with --context flag (overrides persisted setting)
`;

describe("parseCopilotHelpConfigModels", () => {
  it("reads only the model list", () => {
    const slugs = parseCopilotHelpConfigModels(HELP_CONFIG_FIXTURE).map((model) => model.slug);
    expect(slugs[0]).toBe("claude-sonnet-5");
    expect(slugs).toHaveLength(26);
    expect(slugs).toContain("gpt-5-mini");
    expect(slugs.at(-1)).toBe("kimi-k2.7-code");
    expect(slugs).not.toContain("always");
    expect(slugs).not.toContain("default");
  });

  it("returns nothing when the model key is absent", () => {
    expect(parseCopilotHelpConfigModels('  `banner`: x\n    - "once"\n')).toEqual([]);
  });
});

describe("parseCopilotConfigLogin", () => {
  it("reads the last login from Copilot's commented config", () => {
    const raw = [
      "// User settings belong in settings.json.",
      "// This file is managed automatically.",
      '{ "lastLoggedInUser": { "host": "https://github.com", "login": "octocat" } }',
    ].join("\n");
    expect(parseCopilotConfigLogin(raw)).toBe("octocat");
  });

  it("returns undefined for a config without a login", () => {
    expect(parseCopilotConfigLogin("{}")).toBeUndefined();
    expect(parseCopilotConfigLogin("not json")).toBeUndefined();
  });
});

const writeCopilotHome = (login: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-copilot-home-" });
    if (login !== undefined) {
      yield* fs.writeFileString(
        path.join(home, "config.json"),
        `// managed\n{ "lastLoggedInUser": { "host": "https://github.com", "login": "${login}" } }\n`,
      );
    }
    return home;
  });

const writeFakeCopilot = (script: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-copilot-bin-" });
    const binary = path.join(dir, "copilot");
    yield* fs.writeFileString(binary, ["#!/bin/sh", ...script, ""].join("\n"));
    yield* fs.chmod(binary, 0o755);
    return binary;
  });

/** A fake `copilot` whose `--acp` mode is the mock ACP agent in its Copilot profile. */
const writeMockAcpCopilot = (options: { readonly loggedOut?: boolean } = {}) =>
  writeFakeCopilot([
    'if [ "$1" = "--version" ]; then echo "GitHub Copilot CLI 1.0.88."; exit 0; fi',
    'if [ "$1" = "help" ]; then exit 0; fi',
    "export LECTURN_ACP_COPILOT=1",
    ...(options.loggedOut ? ["export LECTURN_ACP_COPILOT_LOGGED_OUT=1"] : []),
    `exec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)} "$@"`,
  ]);

it.layer(NodeServices.layer)("resolveCopilotAuth", (it) => {
  it.effect("labels a login the CLI accepts with the recorded user", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* writeCopilotHome("octocat");
        const binary = yield* writeMockAcpCopilot();
        const auth = yield* resolveCopilotAuth(
          decodeSettings({ enabled: true, binaryPath: binary }),
          { PATH: process.env.PATH ?? "", COPILOT_HOME: home },
        );
        expect(auth).toEqual({ status: "authenticated", type: "github", label: "GitHub @octocat" });
      }),
    ),
  );

  it.effect("reports an accepted login without a label when config.json has none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* writeCopilotHome(undefined);
        const binary = yield* writeMockAcpCopilot();
        const auth = yield* resolveCopilotAuth(
          decodeSettings({ enabled: true, binaryPath: binary }),
          { PATH: process.env.PATH ?? "", COPILOT_HOME: home },
        );
        expect(auth).toEqual({ status: "authenticated", type: "github" });
      }),
    ),
  );

  it.effect("trusts the CLI's auth_required answer over a token and a recorded login", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* writeCopilotHome("octocat");
        const binary = yield* writeMockAcpCopilot({ loggedOut: true });
        const auth = yield* resolveCopilotAuth(
          decodeSettings({ enabled: true, binaryPath: binary }),
          { PATH: process.env.PATH ?? "", COPILOT_HOME: home, COPILOT_GITHUB_TOKEN: "invalid" },
        );
        expect(auth).toEqual({ status: "unauthenticated" });
      }),
    ),
  );

  it.effect("reports unknown, not unauthenticated, when the handshake fails otherwise", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* writeCopilotHome("octocat");
        const binary = yield* writeFakeCopilot(['echo "boom" >&2', "exit 2"]);
        const auth = yield* resolveCopilotAuth(
          decodeSettings({ enabled: true, binaryPath: binary }),
          { PATH: process.env.PATH ?? "", COPILOT_HOME: home },
        );
        expect(auth).toEqual({ status: "unknown" });
      }),
    ),
  );
});

describe("buildInitialCopilotProviderSnapshot", () => {
  it.effect("is disabled by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCopilotProviderSnapshot(decodeSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.showInteractionModeToggle).toBe(true);
      expect(snapshot.conversationFork).toBe("unsupported");
    }),
  );
});

it.layer(NodeServices.layer)("checkCopilotProviderStatus", (it) => {
  it.effect("does not probe a disabled instance", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCopilotProviderStatus(
        decodeSettings({ enabled: false, binaryPath: "/definitely/not/copilot" }),
      );
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
    }),
  );

  it.effect("reports a missing binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCopilotProviderStatus(
        decodeSettings({ enabled: true, binaryPath: "/definitely/not/installed/copilot" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
    }),
  );

  it.effect("reports a CLI whose --version exits non-zero as failing to run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binary = yield* writeFakeCopilot(['echo "broken" >&2', "exit 3"]);
        const snapshot = yield* checkCopilotProviderStatus(
          decodeSettings({ enabled: true, binaryPath: binary }),
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toBe("GitHub Copilot CLI is installed but failed to run.");
      }),
    ),
  );

  it.effect("lists models from help config and reports the recorded login", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* writeCopilotHome("octocat");
        const helpPath = path.join(home, "help.txt");
        yield* fs.writeFileString(helpPath, HELP_CONFIG_FIXTURE);
        const binary = yield* writeFakeCopilot([
          'if [ "$1" = "--version" ]; then echo "GitHub Copilot CLI 1.0.88."; exit 0; fi',
          `if [ "$1" = "help" ]; then cat "${helpPath}"; exit 0; fi`,
          "export LECTURN_ACP_COPILOT=1",
          `exec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)} "$@"`,
        ]);
        const snapshot = yield* checkCopilotProviderStatus(
          decodeSettings({ enabled: true, binaryPath: binary, customModels: ["my-model"] }),
          { PATH: process.env.PATH ?? "", COPILOT_HOME: home },
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.version).toBe("1.0.88");
        expect(snapshot.auth.label).toBe("GitHub @octocat");
        const slugs = snapshot.models.map((model) => model.slug);
        expect(slugs.slice(0, 2)).toEqual(["auto", "claude-sonnet-5"]);
        expect(slugs.filter((slug) => slug === "auto")).toHaveLength(1);
        expect(slugs).toContain("gpt-5-mini");
        expect(slugs.at(-1)).toBe("my-model");
        expect(snapshot.models.find((model) => model.isDefault)?.slug).toBe("auto");
      }),
    ),
  );

  it.effect("reports a CLI without a usable login as an error that points at copilot login", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* writeCopilotHome("octocat");
        const binary = yield* writeMockAcpCopilot({ loggedOut: true });
        const snapshot = yield* checkCopilotProviderStatus(
          decodeSettings({ enabled: true, binaryPath: binary }),
          { PATH: process.env.PATH ?? "", COPILOT_HOME: home },
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.message).toContain("copilot login");
      }),
    ),
  );
});
