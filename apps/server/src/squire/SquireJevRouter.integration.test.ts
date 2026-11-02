/**
 * Live Jev routing against a funded test environment (13.5, R100). Never runs
 * in CI: it spends allowance and needs a relay credential. Run with
 *
 *   LECTURN_SQUIRE_JEV_LIVE=1 LECTURN_SQUIRE_JEV_RELAY_URL=... \
 *   LECTURN_SQUIRE_JEV_CREDENTIAL=... LECTURN_SQUIRE_JEV_ENVIRONMENT_ID=... \
 *   LECTURN_SQUIRE_JEV_GENERATION=... vp test run <this file>
 *
 * and it writes p50/p95 latency and the confidence spread to
 * `artifacts/squire-bar/jev/latency.json`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type SquireRoutingRequest } from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpClient } from "effect/http";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "../cloud/config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as ExtensionsCloudClient from "../extensions/ExtensionsCloudClient.ts";

const env = process.env;

const members: SquireRoutingRequest["members"] = [
  {
    squireId: "squire:release",
    name: "Release",
    brief: "Watches the billing service: invoices, rounding, payment retries, and its deploys.",
    scope: {
      containers: ["billing-service"],
      threadTitles: ["Invoice rounding", "Retry webhook payments"],
      pullRequests: [412],
    },
    recentActivity: ["Invoice rounding is off by a cent"],
  },
  {
    squireId: "squire:research",
    name: "Research",
    brief: "Watches the web app: checkout UI, currency formatting, and accessibility.",
    scope: {
      containers: ["web-app"],
      threadTitles: ["Currency formatter", "Checkout button focus ring"],
      pullRequests: [318],
    },
    recentActivity: ["2 posts in this room in the last 24 h"],
  },
  {
    squireId: "squire:infra",
    name: "Infra",
    brief: "Watches CI, the deploy pipeline, and the database migrations.",
    scope: {
      containers: ["infra"],
      threadTitles: ["Flaky e2e shard", "Postgres 17 upgrade"],
      pullRequests: [77],
    },
    recentActivity: [],
  },
];

const posts = [
  "Why does the checkout total drift by a cent on some invoices?",
  "The currency formatter shows 1.000,00 for US users now.",
  "CI shard 3 has been red since this morning.",
  "Can someone review PR 318?",
  "Is the Postgres upgrade still on for Friday?",
  "Payment retries fire twice after a webhook timeout.",
  "The focus ring on the checkout button disappeared.",
  "Thanks everyone, that's all for today.",
  "What should we prioritize this week?",
  "The migration for invoices locks the table for minutes.",
  "Prices render without the currency symbol in Safari.",
  "Deploys are taking 40 minutes again.",
  "Who owns the refund flow?",
  "Ack, merged.",
  "PR 412 changes rounding; does it touch the web display?",
  "The e2e suite times out on the login step.",
  "Screen readers skip the order summary.",
  "Billing sent duplicate receipts last night.",
  "Should we pause the release until the formatter fix lands?",
  "Great work on the fix!",
];

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
const spread = (values: ReadonlyArray<number>) =>
  values.length === 0
    ? null
    : {
        min: Math.min(...values),
        max: Math.max(...values),
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      };

describe.skipIf(env.LECTURN_SQUIRE_JEV_LIVE !== "1")("Jev routing (live)", () => {
  it.live("routes 20 sample posts within the 5 s deadline", () =>
    Effect.gen(function* () {
      const secrets = new Map([
        [RELAY_URL_SECRET, env.LECTURN_SQUIRE_JEV_RELAY_URL ?? ""],
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, env.LECTURN_SQUIRE_JEV_CREDENTIAL ?? ""],
      ]);
      const store: ServerSecretStore["Service"] = {
        get: (name) =>
          Effect.sync(() =>
            Option.map(Option.fromNullishOr(secrets.get(name)), (value) =>
              new TextEncoder().encode(value),
            ),
          ),
        set: (name, value) =>
          Effect.sync(() => void secrets.set(name, new TextDecoder().decode(value))),
        remove: (name) => Effect.sync(() => void secrets.delete(name)),
        create: () => Effect.die("unused"),
        getOrCreateRandom: () => Effect.die("unused"),
      };
      const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const client = yield* ExtensionsCloudClient.make.pipe(
        Effect.provideService(ServerSecretStore, store),
        Effect.provideService(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(
            EnvironmentId.make(env.LECTURN_SQUIRE_JEV_ENVIRONMENT_ID ?? "unset"),
          ),
        }),
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const fundingGeneration = Number(env.LECTURN_SQUIRE_JEV_GENERATION ?? "0");
      const startedAt = yield* DateTime.now;
      const run = DateTime.toEpochMillis(startedAt).toString(36);

      const samples = [];
      for (const [index, body] of posts.entries()) {
        const requestId = `squire-route:live-${run}-${index}`;
        const started = performance.now();
        const outcome = yield* Effect.result(
          client.route({
            featureId: "squires",
            requestId,
            runId: requestId,
            fundingGeneration,
            templateVersion: "squire-routing-v1",
            members,
            post: { body },
          }),
        );
        const ms = performance.now() - started;
        samples.push(
          outcome._tag === "Success"
            ? { body, ms, ...outcome.success.judgments[0]! }
            : { body, ms, failure: outcome.failure.reason },
        );
      }

      const latencies = samples.map((sample) => sample.ms).toSorted((a, b) => a - b);
      const answered = samples.filter((sample) => "choice" in sample);
      const report = {
        recordedAt: DateTime.formatIso(startedAt),
        deadlineMs: 5_000,
        count: samples.length,
        failures: samples.length - answered.length,
        p50Ms: percentile(latencies, 50),
        p95Ms: percentile(latencies, 95),
        confidence: spread(answered.map((sample) => sample.confidence)),
        noReplyConfidence: spread(answered.map((sample) => sample.noReplyConfidence)),
        samples,
      };
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const output = path.resolve(
        import.meta.dirname,
        "../../../../artifacts/squire-bar/jev/latency.json",
      );
      yield* fs.makeDirectory(path.dirname(output), { recursive: true });
      yield* fs.writeFileString(output, `${JSON.stringify(report, null, 2)}\n`);
      assert.strictEqual(report.failures, 0);
      assert.isBelow(report.p95Ms, 5_000);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
