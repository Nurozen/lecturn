// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Evidence goes to the repo-root artifacts folder as raw JSON.
/**
 * A Codex Squire summary runs in the instance's Squire
 * CODEX_HOME, so the source home's AGENTS.md, skill, and memories never reach
 * the model. Spends provider tokens, so it runs only with
 * SQUIRE_CODEX_SUMMARY_LIVE=1. Every model request goes through the S0a2
 * recording proxy; the source home is a temp home carrying the S0a2
 * sentinels and a copy of the user's login without its refresh token.
 * Control: a workflow summary on the same instance runs in the source home
 * and must carry the AGENTS.md sentinel, or the check proves nothing.
 * Evidence goes to artifacts/squire-bar/p7/codex-summary-home/.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  SquireSummaryGoldFixture,
  squireOutcome,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { codexSquireHomePath } from "../provider/Drivers/CodexSquireHome.ts";
import { makeCodexTextGeneration } from "../textGeneration/CodexTextGeneration.ts";
import { resolveInferenceModel } from "../textGeneration/inferenceModel.ts";
import { CODEX_CONTEXT_SENTINELS, makeBarProviderHome } from "./testkit/barProviders.ts";
import { makeCodexRecordingProxy } from "./testkit/codexLive.ts";
import goldJson from "./testdata/scenarios/summary-gold.json" with { type: "json" };

const live = process.env.SQUIRE_CODEX_SUMMARY_LIVE === "1";
const { fixture } = Schema.decodeUnknownSync(SquireSummaryGoldFixture)(goldJson);
const evidenceDir = NodePath.resolve(
  import.meta.dirname,
  "../../../../artifacts/squire-bar/p7/codex-summary-home",
);
const instanceId = ProviderInstanceId.make("codex");
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const sentinelsIn = (body: unknown) => {
  const text = JSON.stringify(body);
  return Object.entries(CODEX_CONTEXT_SENTINELS).flatMap(([source, token]) =>
    text.includes(token) ? [source] : [],
  );
};

describe.runIf(live)("Codex Squire summary home (live)", () => {
  const preferred = process.env.SQUIRE_BAR_MODEL ?? "gpt-5.6-luna";
  const modelSelection = resolveInferenceModel(
    { instanceId, model: preferred },
    ProviderDriverKind.make("codex"),
    [{ slug: preferred }],
  );
  const layer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "lecturn-squire-codex-summary-home-",
  }).pipe(Layer.provideMerge(NodeServices.layer));

  // oxlint-disable-next-line lecturn/no-test-timeout-or-unreasoned-skip -- a live provider run behind an env gate, on real model latency, not a hidden wait.
  it.layer(layer, { timeout: 600_000, excludeTestServices: true })("codex", (it) => {
    // oxlint-disable-next-line lecturn/no-test-timeout-or-unreasoned-skip -- a live provider run behind an env gate, on real model latency, not a hidden wait.
    it.effect(
      "keeps the source home's AGENTS.md out of a Squire summary request",
      () =>
        Effect.gen(function* () {
          NodeFS.rmSync(evidenceDir, { recursive: true, force: true });
          const home = yield* makeBarProviderHome("codex");
          const proxy = yield* makeCodexRecordingProxy(NodePath.join(evidenceDir, "raw"));
          const settings = decodeCodexSettings({
            homePath: home.homePath,
            launchArgs: proxy.launchArgs,
          });
          const { CODEX_HOME: _home, ...environment } = home.environment;
          const generation = yield* makeCodexTextGeneration(
            settings,
            environment,
            undefined,
            undefined,
            instanceId,
          );
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const outcome = squireOutcome(fixture.session)!;

          const squire = yield* generation.generateSquireTurnSummary!({
            cwd: process.cwd(),
            summaryInput: fixture,
            outcome,
            modelSelection,
          });
          const squireRequests = proxy.requests();
          const control = yield* generation.generateWorkflowSummary({
            cwd: process.cwd(),
            message:
              '{"priorSummary":null,"turns":[{"question":"Fix the invoice rounding","response":"Rounding fixed; tests pass."}]}',
            modelSelection,
          });
          const controlRequests = proxy.requests().slice(squireRequests.length);

          const rows = (phase: string, requests: typeof squireRequests) =>
            requests.map((entry) => ({ phase, n: entry.n, sentinels: sentinelsIn(entry.body) }));
          const squireRows = rows("squire-summary", squireRequests);
          const controlRows = rows("control-workflow-summary", controlRequests);
          const squireHomePath = codexSquireHomePath(yield* Path.Path, stateDir, instanceId);
          const evidence = {
            note: [
              "One Squire summary (generateSquireTurnSummary) and one control (generateWorkflowSummary) on one Codex instance whose source CODEX_HOME is a temp home with the S0a2 sentinels in AGENTS.md, a user skill, and memories, and the user's login without its refresh token.",
              "Every /responses body went through the S0a2 recording proxy; raw bodies are in raw/. sentinels lists which planted tokens each body carried.",
              "Pass: the Squire summary's requests carry no sentinel and the control's carry the AGENTS.md sentinel.",
            ],
            model: modelSelection.model,
            sourceHome: home.homePath,
            squireHome: squireHomePath,
            squireHomeEntries: NodeFS.readdirSync(squireHomePath).toSorted(),
            requests: [...squireRows, ...controlRows],
            squireSummary: squire,
            controlSummary: control,
          };
          NodeFS.mkdirSync(evidenceDir, { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(evidenceDir, "evidence.json"),
            `${JSON.stringify(evidence, null, 2)}\n`,
          );

          assert.isAbove(squireRows.length, 0, "no Squire summary request was recorded");
          assert.isTrue(
            squireRows.every((row) => row.sentinels.length === 0),
            `a Squire summary request carries ${JSON.stringify(squireRows)}`,
          );
          assert.notInclude(evidence.squireHomeEntries, "AGENTS.md");
          assert.isTrue(
            controlRows.some((row) => row.sentinels.includes("agents")),
            "control: the AGENTS.md sentinel never reached the control, so the check proves nothing",
          );
        }).pipe(Effect.scoped),
      600_000,
    );
  });
});
