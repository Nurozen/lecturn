// S0d (OQ20): live summary latency and isolation. Runs only with
// SQUIRE_S0D_PROVIDER set (claudeAgent or codex) and spends provider tokens.
// Each of SQUIRE_S0D_TURNS (default 20) gold fixture turns carries a fresh
// nonce in its conversation text, so a leak into spans, logs, or provider
// transcripts shows up as that nonce. Results go to artifacts/squire-bar/s0d/.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SquireSummaryGoldFixture,
  squireOutcome,
} from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makeClaudeTextGeneration } from "../textGeneration/ClaudeTextGeneration.ts";
import { makeCodexTextGeneration } from "../textGeneration/CodexTextGeneration.ts";
import { resolveInferenceModel } from "../textGeneration/inferenceModel.ts";
import goldJson from "./testdata/scenarios/summary-gold.json" with { type: "json" };

const provider = process.env.SQUIRE_S0D_PROVIDER;
const turns = Number(process.env.SQUIRE_S0D_TURNS ?? "20");
const P95_LIMIT_MS = 20_000;
const { fixture } = Schema.decodeUnknownSync(SquireSummaryGoldFixture)(goldJson);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

const percentile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? Number.NaN;
};

/** Each predicate the provider's isolated runner must put on the summary call. */
const isolationArgs: Record<string, ReadonlyArray<string>> = {
  claudeAgent: ["--safe-mode", "--no-session-persistence", "--strict-mcp-config", "--tools"],
  codex: [
    "--ignore-rules",
    "--ephemeral",
    "features.shell_tool=false",
    "features.plugins=false",
    "features.apps=false",
    'web_search="disabled"',
  ],
};

describe.runIf(provider)("S0d summary latency and isolation (live)", () => {
  const driverKind = ProviderDriverKind.make(provider ?? "claudeAgent");
  const preferred = driverKind === "codex" ? "gpt-5.6-luna" : "claude-sonnet-5";
  const modelSelection = resolveInferenceModel(
    { instanceId: ProviderInstanceId.make(driverKind), model: preferred },
    driverKind,
    [{ slug: preferred }],
  );
  const layer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "lecturn-squire-s0d-",
  }).pipe(Layer.provideMerge(NodeServices.layer));

  it.layer(layer, { timeout: 1_800_000, excludeTestServices: true })(`${driverKind}`, (it) => {
    it.effect(
      `${turns} isolated summaries, p95 under ${P95_LIMIT_MS} ms`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const here = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
          const checkout = path.resolve(here, "../../../..");
          const home = process.env.HOME ?? "";

          const spawns: Array<{ command: string; args: ReadonlyArray<string>; cwd?: string }> = [];
          const recordingSpawner = ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand") {
              spawns.push({
                command: command.command,
                args: command.args,
                ...(command.options.cwd ? { cwd: command.options.cwd } : {}),
              });
            }
            return realSpawner.spawn(command);
          });
          const spans: Array<Tracer.NativeSpan> = [];
          const tracer = Tracer.make({
            span: (options) => {
              const span = new Tracer.NativeSpan(options);
              spans.push(span);
              return span;
            },
          });
          const logs: Array<string> = [];
          const logger = Logger.make(({ message, cause, logLevel }) => {
            logs.push(`${logLevel} ${JSON.stringify(message)} ${Cause.pretty(cause)}`);
          });

          const nonce = `s0d${(yield* Clock.currentTimeMillis).toString(36)}${(yield* Random.next).toString(36).slice(2, 10)}`;
          const marker = yield* fs.makeTempFileScoped({ prefix: "lecturn-s0d-marker-" });
          const runs: Array<{
            turn: number;
            durationMs: number;
            ok: boolean;
            error?: string;
            spawnCwds: ReadonlyArray<string | null>;
          }> = [];

          yield* Effect.gen(function* () {
            yield* Effect.logInfo("s0d-logger-control");
            const generation =
              driverKind === "codex"
                ? yield* makeCodexTextGeneration(
                    yield* decodeCodexSettings({}),
                    process.env,
                    undefined,
                    undefined,
                    ProviderInstanceId.make("codex"),
                  )
                : yield* makeClaudeTextGeneration(yield* decodeClaudeSettings({}), process.env);
            const generate = generation.generateSquireTurnSummary!;
            const outcome = squireOutcome(fixture.session)!;
            for (let turn = 1; turn <= turns; turn++) {
              const summaryInput = {
                ...fixture,
                turnId: RunId.make(`${fixture.turnId}-${turn}`),
                messages: fixture.messages.map((message) => ({
                  ...message,
                  text: `${message.text} (ref ${nonce})`,
                })),
              };
              const spawnStart = spawns.length;
              const started = yield* Clock.currentTimeMillis;
              // The caller's cwd is the checkout, as a tracked thread's would be.
              const exit = yield* generate({
                cwd: checkout,
                summaryInput,
                outcome,
                modelSelection,
              }).pipe(Effect.exit);
              const durationMs = (yield* Clock.currentTimeMillis) - started;
              runs.push({
                turn,
                durationMs,
                ok: Exit.isSuccess(exit),
                ...(Exit.isFailure(exit) ? { error: Cause.pretty(exit.cause) } : {}),
                spawnCwds: spawns.slice(spawnStart).map((spawn) => spawn.cwd ?? null),
              });
            }
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner),
            Effect.provideService(Tracer.Tracer, tracer),
            Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          );

          // Isolation predicates: every spawn ran outside the checkout in a
          // throwaway inference dir, and the summary call carried each flag.
          const outsideCheckout = spawns.every(
            (spawn) =>
              spawn.cwd !== undefined &&
              spawn.cwd !== checkout &&
              !spawn.cwd.startsWith(`${checkout}/`) &&
              path.basename(spawn.cwd).startsWith("lecturn-workflow-inference-"),
          );
          const summaryCalls = spawns.filter((spawn) =>
            driverKind === "codex"
              ? spawn.args.includes("exec")
              : spawn.args.includes("--json-schema"),
          );
          const missingArgs = (isolationArgs[driverKind] ?? []).filter(
            (flag) => !summaryCalls.every((spawn) => spawn.args.some((arg) => arg.includes(flag))),
          );
          const noTools =
            driverKind === "codex"
              ? summaryCalls.every((spawn) =>
                  spawn.args.some((arg) => arg.startsWith("model_catalog_json=")),
                )
              : summaryCalls.every((spawn) => spawn.args[spawn.args.indexOf("--tools") + 1] === "");
          const isolatedSpans = spans.filter((span) =>
            span.name.endsWith(".generateSquireTurnSummary"),
          ).length;

          // Leak search: span names, attributes, events, and failure causes;
          // every log line; and any provider transcript written during the run.
          const spanText = spans.map((span) =>
            JSON.stringify({
              name: span.name,
              attributes: Object.fromEntries(span.attributes),
              events: span.events.map(([name, , attributes]) => ({ name, attributes })),
              failure:
                span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
                  ? Cause.pretty(span.status.exit.cause)
                  : null,
            }),
          );
          const needles = [
            nonce,
            "off by a cent",
            "matches the ledger",
            "PDF rendering",
            "banker's rounding",
          ];
          const leaks = (texts: ReadonlyArray<string>) =>
            needles.filter((needle) => texts.some((text) => text.includes(needle)));
          const transcriptDirs = [
            path.join(home, ".claude/projects"),
            path.join(home, ".codex/sessions"),
          ];
          const transcriptHits = yield* Effect.forEach(transcriptDirs, (dir) =>
            Effect.gen(function* () {
              if (!(yield* fs.exists(dir))) return [];
              const child = yield* realSpawner.spawn(
                ChildProcess.make(
                  "find",
                  [dir, "-type", "f", "-newer", marker, "-exec", "grep", "-l", nonce, "{}", "+"],
                  {},
                ),
              );
              const [stdout] = yield* Effect.all(
                [
                  child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                  child.stderr.pipe(Stream.runDrain),
                  child.exitCode,
                ],
                { concurrency: "unbounded" },
              );
              return stdout.split("\n").filter(Boolean);
            }),
          ).pipe(Effect.map((hits) => hits.flat()));
          const inferenceProjectDirs = (yield* fs.exists(transcriptDirs[0]!))
            ? (yield* fs.readDirectory(transcriptDirs[0]!)).filter((name) =>
                name.includes("lecturn-workflow-inference"),
              )
            : [];

          const durations = runs.filter((run) => run.ok).map((run) => run.durationMs);
          const result = {
            provider: driverKind,
            modelSelection,
            binary: summaryCalls[0]?.command ?? null,
            turns,
            ok: durations.length,
            failed: runs.filter((run) => !run.ok).length,
            p50Ms: percentile(durations, 0.5),
            p95Ms: percentile(durations, 0.95),
            maxMs: Math.max(...durations),
            p95LimitMs: P95_LIMIT_MS,
            isolation: {
              outsideCheckout,
              missingArgs,
              noTools,
              isolatedSpans,
              spawnCount: spawns.length,
              summaryCalls: summaryCalls.length,
            },
            leaks: {
              spans: leaks(spanText),
              logs: leaks(logs),
              transcripts: transcriptHits,
              inferenceProjectDirs,
              spanCount: spans.length,
              logCount: logs.length,
              loggerControlCaptured: logs.some((line) => line.includes("s0d-logger-control")),
            },
            runs,
            exampleSummaryCall: summaryCalls[0]
              ? {
                  command: summaryCalls[0].command,
                  args: summaryCalls[0].args,
                  cwd: summaryCalls[0].cwd,
                }
              : null,
          };
          const target = path.join(checkout, "artifacts/squire-bar/s0d", `${driverKind}.json`);
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.writeFileString(target, `${JSON.stringify(result, null, 2)}\n`);

          assert.strictEqual(result.failed, 0);
          assert.isBelow(result.p95Ms, P95_LIMIT_MS);
          assert.isTrue(outsideCheckout);
          assert.deepStrictEqual(missingArgs, []);
          assert.isTrue(noTools);
          assert.strictEqual(isolatedSpans, turns);
          assert.isTrue(result.leaks.loggerControlCaptured);
          assert.deepStrictEqual(result.leaks.spans, []);
          assert.deepStrictEqual(result.leaks.logs, []);
          assert.deepStrictEqual(transcriptHits, []);
          assert.deepStrictEqual(inferenceProjectDirs, []);
        }).pipe(Effect.scoped),
      1_800_000,
    );
  });
});
