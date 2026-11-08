// @effect-diagnostics nodeBuiltinImport:off - Recorded fixtures are read synchronously, outside the code under test.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  SquireCardId,
  SquireEvidence,
  SquireId,
  ThreadId,
  type ThreadPullRequestLink,
} from "@lecturn/contracts";
import * as SourceControlRateLimit from "@lecturn/source-control-core/server/SourceControlRateLimit";
import * as GitHubCiFailure from "@lecturn/source-control-github/server/gitHubCiFailure";
import * as GitHubCredentials from "@lecturn/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@lecturn/source-control-github/server/GitHubQuota";
import * as GitHubRest from "@lecturn/source-control-github/server/GitHubRest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SquireCiExcerpt from "./SquireCiExcerpt.ts";
import * as SquireRepository from "./SquireRepository.ts";

// Token-shaped strings are built here, never stored, so the recorded files pass push protection.
const TOKENS = {
  "{{GHS_TOKEN}}": `${"gh"}s_${"A1b2".repeat(9)}`,
  "{{GHP_TOKEN}}": `${"gh"}p_${"x".repeat(36)}`,
  "{{GITHUB_PAT}}": `${"github"}_pat_11${"Z9".repeat(20)}_${"q".repeat(30)}`,
  "{{STRIPE_KEY}}": `${"sk"}_live_51Hc${"0ffee0ddba11deadbeef"}`,
};
const fixture = (name: string) =>
  Object.entries(TOKENS).reduce(
    (text, [placeholder, token]) => text.split(placeholder).join(token),
    NodeFS.readFileSync(new URL(`./testdata/ci/${name}`, import.meta.url), "utf8"),
  );

const SEEDED_TOKEN = "lecturn-seeded-7f3c9a1e";
const HEAD = "9f2c4e1b7a3d5e6f8091a2b3c4d5e6f708192a3b";
const LOG_URL =
  "https://pipelines.actions.githubusercontent.com/serviceHosts/abc/_apis/pipelines/1/runs/9001/signedlogcontent/101?urlExpires=2026-10-31T14%3A20%3A00Z&signature=sig";
const API = "/repos/acme/billing-service";

type Route = (request: HttpClientRequest.HttpClientRequest) => Response | undefined;

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

/** Recorded GitHub answers: job 101 has only the exit-code annotation, so its log is read. */
const recorded =
  (overrides: { readonly log?: () => Response; readonly blob?: () => Response } = {}): Route =>
  (request) => {
    const url = new URL(request.url);
    if (url.pathname === `${API}/commits/${HEAD}/check-runs`)
      return json(fixture("check-runs.json"));
    if (url.pathname === `${API}/check-runs/101/annotations`)
      return json(fixture("annotations-exit-code-only.json"));
    if (url.pathname === `${API}/check-runs/102/annotations`)
      return json(fixture("annotations-typecheck.json"));
    if (url.pathname === `${API}/actions/jobs/101/logs`)
      return (
        overrides.log?.() ?? new Response(null, { status: 302, headers: { location: LOG_URL } })
      );
    if (url.origin === new URL(LOG_URL).origin)
      return overrides.blob?.() ?? new Response(fixture("job-api-e2e.txt"), { status: 200 });
    return undefined;
  };

const gitHubHarness = (route: Route) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.succeed({
          host,
          token: Redacted.make(SEEDED_TOKEN),
          source: "gh" as const,
          fingerprint: `${host}:seeded`,
        }),
      invalidate: () => Effect.void,
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      const response = route(request) ?? new Response("{}", { status: 404 });
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }),
  );
  const layer = Layer.mergeAll(
    GitHubRest.layer.pipe(
      Layer.provide(Layer.mergeAll(credentials, http)),
      Layer.provideMerge(GitHubQuota.layer),
      Layer.provideMerge(SourceControlRateLimit.layer),
    ),
    http,
  );
  const read = (maxLogBytes = SquireCiExcerpt.SQUIRE_CI_MAX_LOG_BYTES) =>
    GitHubCiFailure.readGitHubCiFailure({
      host: "github.com",
      repository: "acme/billing-service",
      headRevision: HEAD,
      maxJobs: SquireCiExcerpt.SQUIRE_CI_MAX_JOBS,
      maxLogBytes,
    }).pipe(Effect.provide(layer));
  return { requests, read, layer };
};

describe("GitHub CI excerpt on recorded answers", () => {
  it.effect("reads annotations first and follows the log redirect without the token", () =>
    Effect.gen(function* () {
      const github = gitHubHarness(recorded());
      const failure = yield* github.read();
      const excerpt = SquireCiExcerpt.squireCiExcerpt(failure, HEAD);

      assert.deepStrictEqual(failure.checks, {
        passed: 2,
        failed: 4,
        failingJobs: ["api-e2e", "typecheck", "lint", "codecov/patch"],
      });
      // Two Actions jobs only: lint and the non-Actions check are never read.
      assert.deepStrictEqual(
        failure.jobs.map((job) => job.name),
        ["api-e2e", "typecheck"],
      );
      const paths = github.requests.map((request) => new URL(request.url).pathname);
      assert.strictEqual(github.requests.length, 5);
      assert.isFalse(paths.some((path) => path.includes("/103/")));

      const blob = github.requests.find((request) => request.url === LOG_URL);
      assert.isDefined(blob);
      assert.isUndefined(blob?.headers.authorization);
      const logRequest = github.requests.find((request) =>
        request.url.endsWith("/actions/jobs/101/logs"),
      );
      assert.strictEqual(logRequest?.headers.authorization, `Bearer ${SEEDED_TOKEN}`);

      assert.deepStrictEqual(excerpt.ciLog, {
        status: "annotations",
        headSha: HEAD,
        jobs: [
          {
            name: "api-e2e",
            url: "https://github.com/acme/billing-service/actions/runs/9001/job/101",
          },
          {
            name: "typecheck",
            url: "https://github.com/acme/billing-service/actions/runs/9001/job/102",
          },
        ],
        truncated: false,
      });
      assert.deepStrictEqual(excerpt.errorLines, [
        "❯ tests/e2e/invoices.e2e.test.ts (48 tests | 1 failed) 3311ms",
        "FAIL tests/e2e/invoices.e2e.test.ts > POST /invoices/:id/finalize > EUR totals match the ledger",
        "AssertionError: expected '€1,234.57' to equal '€1,234.56'",
        "Ledger client error: request rejected for API_KEY=[redacted] with Authorization: [redacted] [redacted]",
        "src/invoice/InvoiceTotals.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      ]);
    }),
  );

  it.effect("a refused log (403) is unavailable, not an error", () =>
    Effect.gen(function* () {
      const github = gitHubHarness(recorded({ log: () => json(fixture("logs-403.json"), 403) }));
      const failure = yield* github.read();
      const api = failure.jobs[0];
      assert.isTrue(api?.logUnavailable);
      assert.isNull(api?.log ?? null);

      const onlyApi = SquireCiExcerpt.squireCiExcerpt({ ...failure, jobs: [api!] }, HEAD);
      assert.strictEqual(onlyApi.ciLog.status, "unavailable");
      assert.deepStrictEqual(onlyApi.errorLines, []);
      // Never followed anywhere after the refusal.
      assert.isFalse(github.requests.some((request) => request.url === LOG_URL));
    }),
  );

  it.effect("a large log is read only up to its bound and still yields bounded lines", () =>
    Effect.gen(function* () {
      const noise = `${"2026-10-31T14:11:00.0000000Z compiling module ".padEnd(120, "x")}\n`;
      const huge = `${fixture("job-api-e2e.txt")}${noise.repeat(40_000)}error: ${"y".repeat(5_000)}\n`;
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = new TextEncoder().encode(huge.slice(pulled, pulled + 64 * 1024));
          pulled += 64 * 1024;
          if (chunk.byteLength === 0) controller.close();
          else controller.enqueue(chunk);
        },
      });
      const maxLogBytes = 256 * 1024;
      const github = gitHubHarness(recorded({ blob: () => new Response(body, { status: 200 }) }));
      const failure = yield* github.read(maxLogBytes);
      const log = failure.jobs[0]?.log;
      assert.isTrue(log?.truncated);
      assert.isAtMost(Buffer.byteLength(log?.text ?? ""), maxLogBytes);
      // The transfer stopped near the bound instead of draining the whole body.
      assert.isBelow(pulled, huge.length / 2);

      const excerpt = SquireCiExcerpt.squireCiExcerpt(failure, HEAD);
      assert.isTrue(excerpt.ciLog.truncated);
      assert.isAtMost(excerpt.errorLines.length, 5);
      for (const line of excerpt.errorLines) assert.isAtMost(line.length, 300);
    }),
  );

  it.effect("redacts the seeded token, token shapes, and key=value secrets", () =>
    Effect.gen(function* () {
      const failure = yield* gitHubHarness(recorded()).read();
      const text = failure.jobs[0]?.log?.text ?? "";
      assert.notInclude(text, SEEDED_TOKEN);
      const lines = SquireCiExcerpt.logErrorLines(text);
      const joined = lines.join("\n");
      for (const secret of [
        SEEDED_TOKEN,
        TOKENS["{{GHP_TOKEN}}"],
        TOKENS["{{GITHUB_PAT}}"],
        TOKENS["{{STRIPE_KEY}}"],
      ]) {
        assert.notInclude(joined, secret);
      }
      assert.include(joined, "error: upstream refused [redacted] ([redacted])");
      assert.notInclude(joined, "\u001b");

      const seeded = SquireCiExcerpt.redactSecrets(
        `push failed: hunter2-value and ${"gh"}o_${"0123456789abcdefghijABCDEFGHIJ"} password: 'x y'`,
        ["hunter2-value"],
      );
      assert.strictEqual(seeded, "push failed: [redacted] and [redacted] password: [redacted]");
    }),
  );
});

// ── The card fiber ────────────────────────────────────────────

const squireId = SquireId.make("squire-release");
const threadId = ThreadId.make("thread-billing");
const NOW = "2026-10-31T14:12:00.000Z";

const prLink = (host: string): ThreadPullRequestLink => ({
  host,
  repository: "acme/billing-service",
  number: 318,
  url: `https://${host}/acme/billing-service/pull/318`,
  source: "manual",
  linkedAt: NOW,
  snapshot: {
    state: "open",
    title: "Fix invoice rounding",
    headBranch: "fix/invoice-rounding",
    baseBranch: "main",
    isDraft: false,
    updatedAt: NOW,
    syncedAt: NOW,
    additions: 38,
    deletions: 12,
    changedFiles: 4,
    reviewDecision: "approved",
    checksState: "failing",
    mergeability: "mergeable",
    headSha: HEAD,
  },
  stack: null,
});

const shellWith = (links: ReadonlyArray<ThreadPullRequestLink>): OrchestrationV2ThreadShell => {
  const at = DateTime.makeUnsafe(NOW);
  return {
    id: threadId,
    projectId: ProjectId.make("project-billing"),
    title: "Fix invoice rounding",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "fix/invoice-rounding",
    worktreePath: "/workspace/billing",
    pullRequests: [...links],
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

const squireRow: SquireRepository.SquireRow = {
  id: squireId,
  role: "squire",
  name: "Release",
  lifecycle: "ready",
  home_generation: 0,
  home_thread_id: ThreadId.make("home-release"),
  home_project_id: ProjectId.make("project-billing"),
  provider_instance_id: "codex",
  model_selection_json: "{}",
  summary_model_selection_json: null,
  brief: "Keep billing green",
  status: "active",
  events_json: "{}",
  permissions_json: "{}",
  budgets_json: "{}",
  undo_window_seconds: 10,
  digest_json: null,
  digest_last_date: null,
  onboarded_at: null,
  sweep_json: null,
  user_active_at: null,
  inactivity_prompted_at: null,
  automation_paused_at: null,
  companion_json: "{}",
  revision: 0,
  create_request_id: null,
  created_at: NOW,
  updated_at: NOW,
};

const cardRow = (id: string): SquireRepository.SquireCardRow => ({
  id: SquireCardId.make(id),
  squire_id: squireId,
  owner_squire_id: squireId,
  kind: "steer",
  status: "open",
  target_thread_id: threadId,
  project_id: null,
  title: "Fix invoice rounding",
  why: "api-e2e failed on #318",
  payload_json: "{}",
  evidence_json: "{}",
  trigger_json: "{}",
  intent_json: null,
  origin: "event",
  steer_kind: null,
  routed_task_id: null,
  rule_id: null,
  finding_key: null,
  escalate_at: null,
  opened_at: null,
  executes_at: null,
  expires_at: null,
  attempt: 0,
  command_id: null,
  execution_key: null,
  dedupe_key: null,
  replaced_count: 0,
  ask_json: null,
  resolution: null,
  created_at: NOW,
  updated_at: NOW,
});

const decodeEvidence = Schema.decodeUnknownSync(Schema.fromJsonString(SquireEvidence));

const fiberHarness = (links: ReadonlyArray<ThreadPullRequestLink>) => {
  const github = gitHubHarness(recorded());
  let reads = 0;
  const source = Layer.succeed(
    SquireCiExcerpt.SquireCiSource,
    SquireCiExcerpt.SquireCiSource.of({
      read: (input) =>
        Effect.sync(() => reads++).pipe(
          Effect.andThen(
            GitHubCiFailure.readGitHubCiFailure({
              ...input,
              maxJobs: SquireCiExcerpt.SQUIRE_CI_MAX_JOBS,
              maxLogBytes: SquireCiExcerpt.SQUIRE_CI_MAX_LOG_BYTES,
            }),
          ),
          Effect.provide(github.layer),
          Effect.asSome,
          Effect.mapError((cause) => new SquireCiExcerpt.SquireCiReadError({ cause })),
        ),
    }),
  );
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadShell: (id) => Effect.succeed(id === threadId ? shellWith(links) : null),
  });
  const layer = SquireCiExcerpt.layer.pipe(
    Layer.provide(Layer.mergeAll(source, projections)),
    Layer.provideMerge(SquireRepository.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return { layer, reads: () => reads };
};

const raise = (id: string) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    yield* repository.insertCard(cardRow(id));
    yield* repository.insertActionLog({
      squire_id: squireId,
      kind: "card.created",
      room_id: null,
      post_id: null,
      trigger_id: null,
      task_id: null,
      thread_id: threadId,
      card_id: SquireCardId.make(id),
      event_id: null,
      run_id: null,
      invocation_key: null,
      execution_key: null,
      data_json: "{}",
      created_at: NOW,
    });
  });

describe("SquireCiExcerpt", () => {
  it.effect("stores the excerpt on a CI-failure card once, off its card.created row", () => {
    const harness = fiberHarness([prLink("github.com")]);
    return Effect.gen(function* () {
      const repository = yield* SquireRepository.SquireRepository;
      const excerpts = yield* SquireCiExcerpt.SquireCiExcerpt;
      yield* repository.createSquire(squireRow);
      yield* raise("card-ci");
      yield* excerpts.runPending;

      const card = Option.getOrThrow(yield* repository.getCard(SquireCardId.make("card-ci")));
      const evidence = decodeEvidence(card.evidence_json);
      assert.strictEqual(evidence.ciLog?.status, "annotations");
      assert.strictEqual(evidence.errorLines?.length, 5);
      assert.deepStrictEqual(evidence.pullRequest?.checks, {
        passed: 2,
        failed: 4,
        failingJobs: ["api-e2e", "typecheck", "lint", "codecov/patch"],
      });
      for (const secret of [SEEDED_TOKEN, ...Object.values(TOKENS)]) {
        assert.notInclude(card.evidence_json, secret);
      }

      // A later pass and a re-raise of the same head cost no request.
      yield* excerpts.runPending;
      yield* excerpts.excerptCard(SquireCardId.make("card-ci"));
      assert.strictEqual(harness.reads(), 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a fixture-owned PR takes its scenario's evidence and is never read", () => {
    const harness = fiberHarness([prLink("fixture.invalid")]);
    const errorLines = [
      "FAIL tests/e2e/invoices.e2e.test.ts > POST /invoices/:id/finalize > EUR totals match the ledger",
      "AssertionError: expected '€1,234.57' to equal '€1,234.56'",
    ];
    const injected = (head: string, lines: ReadonlyArray<string>, createdAt: string) => ({
      squire_id: squireId,
      thread_id: threadId,
      kind: "pull-request-changed",
      state_key: `fixture.invalid/acme/billing-service#318:${head}:checks:failed`,
      payload_json: JSON.stringify({
        outcome: null,
        runId: `run-${head}`,
        pendingRequest: null,
        pullRequest: {
          host: "fixture.invalid",
          repository: "acme/billing-service",
          number: 318,
          url: "https://fixture.invalid/acme/billing-service/pull/318",
          headSha: head,
          transition: "checks:failed",
          state: "open",
          title: "Fix invoice rounding",
          headBranch: "fix/invoice-rounding",
          baseBranch: "main",
          checksState: "failing",
          reviewDecision: null,
          mergeability: null,
          threadSelfWatching: false,
        },
        evidence: {
          errorLines: lines,
          headBranch: "fix/invoice-rounding",
          diffStats: { insertions: 38, deletions: 12, files: 2 },
        },
      }),
      status: "delivered" as const,
      defer_reason: null,
      not_before: NOW,
      batch_id: null,
      created_at: createdAt,
    });
    return Effect.gen(function* () {
      const repository = yield* SquireRepository.SquireRepository;
      const excerpts = yield* SquireCiExcerpt.SquireCiExcerpt;
      yield* repository.createSquire(squireRow);
      // An older head's lines must not land on this head's card.
      yield* repository.insertEvent(
        injected("0ld0ld0", ["stale line"], "2026-10-31T14:00:00.000Z"),
      );
      yield* repository.insertEvent(injected(HEAD, errorLines, "2026-10-31T14:11:00.000Z"));
      // The check counts the card shows come from the summary the fixture stored for the run.
      const checks = { passed: 11, failed: 1, failingJobs: ["api-e2e"] };
      yield* repository.insertSummary({
        thread_id: threadId,
        run_id: RunId.make(`run-${HEAD}`),
        stage: "terminal",
        status: "complete",
        summary_json: JSON.stringify({
          threadId,
          threadTitle: "Fix invoice rounding",
          project: "billing-service",
          provider: "claudeAgent",
          turnId: `run-${HEAD}`,
          outcome: "finished",
          summaryStatus: "complete",
          goal: "Fix one-cent rounding errors",
          completed: [],
          remaining: [],
          blocked: [],
          pendingQuestion: null,
          suggestedNextStep: null,
          files: { entries: [], counts: { added: 0, modified: 2, deleted: 0 } },
          commands: [],
          pullRequest: {
            repository: "acme/billing-service",
            number: 318,
            headSha: HEAD,
            transition: "checks:failed",
            baseBranch: "main",
            checks,
            review: "approved",
            mergeable: "blocked-by-checks",
            merged: false,
            closed: false,
          },
        }),
        payer_squire_id: null,
        created_at: NOW,
        updated_at: NOW,
      });
      yield* raise("card-fixture");
      yield* excerpts.runPending;

      const card = Option.getOrThrow(yield* repository.getCard(SquireCardId.make("card-fixture")));
      const evidence = decodeEvidence(card.evidence_json);
      assert.deepStrictEqual(evidence.errorLines, errorLines);
      assert.deepStrictEqual(evidence.ciLog, {
        status: "log",
        headSha: HEAD,
        jobs: [],
        truncated: false,
      });
      assert.deepStrictEqual(evidence.pullRequest?.checks, checks);
      assert.deepStrictEqual(evidence.diffStats, { insertions: 38, deletions: 12, files: 2 });
      assert.strictEqual(evidence.headBranch, "fix/invoice-rounding");
      assert.strictEqual(harness.reads(), 0);
    }).pipe(Effect.provide(harness.layer));
  });
});
