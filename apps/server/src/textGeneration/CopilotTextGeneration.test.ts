// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";
import { GithubCopilotSettings, ProviderInstanceId } from "@lecturn/contracts";

import * as ServerConfig from "../config.ts";
import { makeCopilotTextGeneration } from "./CopilotTextGeneration.ts";

const decodeSettings = Schema.decodeSync(GithubCopilotSettings);

/** Single-quotes a value for the generated `/bin/sh` wrapper. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const INSTANCE = ProviderInstanceId.make("githubCopilot");

const TestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "lecturn-copilot-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface LoggedMessage {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: { readonly outcome?: { readonly optionId?: string } };
}

/** Runs the mock agent in its Copilot profile, refusing any argv but the text-generation one. */
function withFakeCopilot<A, E, R>(
  env: Record<string, string>,
  run: (
    textGeneration: Effect.Success<ReturnType<typeof makeCopilotTextGeneration>>,
    readRequests: () => ReadonlyArray<LoggedMessage>,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lecturn-copilot-text-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const requestLogPath = NodePath.join(dir, "requests.ndjson");
    const binaryPath = NodePath.join(dir, "copilot");
    const exports = Object.entries({
      ...env,
      LECTURN_ACP_COPILOT: "1",
      LECTURN_ACP_REQUEST_LOG_PATH: requestLogPath,
    }).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
    NodeFS.writeFileSync(
      binaryPath,
      [
        "#!/bin/sh",
        ...exports,
        'if [ "$*" != "--acp --no-ask-user --disable-builtin-mcps" ]; then',
        '  echo "unexpected args: $*" >&2; exit 11',
        "fi",
        `exec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)}`,
        "",
      ].join("\n"),
    );
    NodeFS.chmodSync(binaryPath, 0o755);
    const textGeneration = yield* makeCopilotTextGeneration(
      decodeSettings({ enabled: true, binaryPath }),
    );
    return yield* run(textGeneration, () =>
      NodeFS.readFileSync(requestLogPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => decodeJsonLine(line) as LoggedMessage),
    );
  }).pipe(Effect.scoped);
}

it.layer(TestLayer)("CopilotTextGeneration", (it) => {
  it.effect("generates a title on the requested model", () =>
    withFakeCopilot(
      { LECTURN_ACP_PROMPT_RESPONSE_TEXT: '{"title":"Fix the login redirect"}' },
      (textGeneration, readRequests) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "login redirects to a 404",
            modelSelection: { instanceId: INSTANCE, model: "gpt-5-mini" },
          });
          expect(result.title).toBe("Fix the login redirect");
          expect(
            readRequests()
              .filter((entry) => entry.method === "session/set_model")
              .map((entry) => entry.params?.modelId),
          ).toEqual(["gpt-5-mini"]);
        }),
    ),
  );

  it.effect("rejects permission requests instead of waiting on a human", () =>
    withFakeCopilot({ LECTURN_ACP_EMIT_TOOL_CALLS: "1" }, (textGeneration, readRequests) =>
      Effect.gen(function* () {
        yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "anything",
            modelSelection: { instanceId: INSTANCE, model: "auto" },
          })
          .pipe(Effect.flip);
        expect(
          readRequests().flatMap((entry) =>
            entry.method === undefined && entry.result?.outcome?.optionId
              ? [entry.result.outcome.optionId]
              : [],
          ),
        ).toEqual(["reject_once"]);
      }),
    ),
  );
});
