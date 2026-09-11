import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { GitHubCli } from "../sourceControl/GitHubCli.ts";
import type { ProviderAcceptanceEvidence, ProviderRepositoryRef } from "./PullRequestProvider.ts";

class GitHubAcceptanceReadError extends Schema.TaggedErrorClass<GitHubAcceptanceReadError>()(
  "GitHubAcceptanceReadError",
  { message: Schema.String },
) {}

const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/));
const Pull = Schema.Struct({
  number: Schema.Number,
  head: Schema.Struct({ sha: Revision }),
  base: Schema.Struct({
    sha: Revision,
    ref: Schema.String,
    repo: Schema.Struct({ full_name: Schema.String }),
  }),
  merged: Schema.Boolean,
});
const RequiredCheck = Schema.Struct({
  context: Schema.String,
  app_id: Schema.NullOr(Schema.Number),
});
const Protection = Schema.Struct({
  url: Schema.String,
  required_status_checks: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        contexts: Schema.Array(Schema.String),
        checks: Schema.optionalKey(Schema.Array(RequiredCheck)),
      }),
    ),
  ),
});
const Rule = Schema.Struct({
  type: Schema.String,
  parameters: Schema.optionalKey(Schema.Unknown),
});
const RuleChecks = Schema.Struct({
  required_status_checks: Schema.Array(
    Schema.Struct({
      context: Schema.String,
      integration_id: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    }),
  ),
});
const CheckPages = Schema.Array(
  Schema.Struct({
    total_count: Schema.Number,
    check_runs: Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        name: Schema.String,
        head_sha: Revision,
        app: Schema.NullOr(Schema.Struct({ id: Schema.Number })),
        status: Schema.String,
        conclusion: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
const StatusPages = Schema.Array(
  Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      context: Schema.String,
      state: Schema.String,
    }),
  ),
);

const decodeRuleChecks = Schema.decodeUnknownEffect(RuleChecks);
const decodeCandidates = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        number: Schema.Number,
        url: Schema.String,
        headRefName: Schema.String,
        headRefOid: Revision,
        headRepository: Schema.NullOr(Schema.Struct({ name: Schema.String })),
        headRepositoryOwner: Schema.NullOr(Schema.Struct({ login: Schema.String })),
        state: Schema.String,
      }),
    ),
  ),
);

type Required = typeof RequiredCheck.Type;
type Run = (typeof CheckPages.Type)[number]["check_runs"][number];
type Status = (typeof StatusPages.Type)[number][number];

/** Only explicit, fully enumerated required contexts can establish clean CI. */
export function evaluateGitHubRequiredChecks(
  requirements: ReadonlyArray<Required>,
  runs: ReadonlyArray<Run>,
  statuses: ReadonlyArray<Status>,
  revision: string,
): ProviderAcceptanceEvidence["requiredChecks"] {
  if (requirements.length === 0) return "none";
  let pending = false;
  for (const required of requirements) {
    const matching = runs.filter(
      (run) =>
        run.name === required.context &&
        run.head_sha === revision &&
        (required.app_id === null || required.app_id === -1 || run.app?.id === required.app_id),
    );
    const latestByApp = new Map<number | null, Run>();
    for (const run of matching.toSorted((a, b) => b.id - a.id)) {
      if (!latestByApp.has(run.app?.id ?? null)) latestByApp.set(run.app?.id ?? null, run);
    }
    const status =
      required.app_id === null || required.app_id === -1
        ? statuses
            .filter((row) => row.context === required.context)
            .toSorted((a, b) => b.id - a.id)[0]
        : undefined;
    if (latestByApp.size === 0 && status === undefined) pending = true;
    for (const run of latestByApp.values()) {
      if (run.status !== "completed" || run.conclusion === null) pending = true;
      else if (!["success", "neutral", "skipped"].includes(run.conclusion)) return "failing";
    }
    if (status !== undefined) {
      if (status.state === "failure" || status.state === "error") return "failing";
      if (status.state !== "success") pending = true;
    }
  }
  return pending ? "pending" : "passing";
}

/**
 * Direct reads deliberately bypass ordinary PR-detail caching. Branch protection AND applicable
 * rules are enumerated; an unreadable policy (including protection 404) never means zero checks.
 * Workflow rules and merge queues need provider-specific proof that this boundary cannot supply.
 */
export const readGitHubAcceptanceEvidence = Effect.fn("readGitHubAcceptanceEvidence")(function* (
  cli: GitHubCli["Service"],
  input: ProviderRepositoryRef & { readonly number: number },
) {
  const read = Effect.fn("readGitHubAcceptanceEvidence.api")(function* <S extends Schema.Top>(
    endpoint: string,
    schema: S,
    pages = false,
  ) {
    const result = yield* cli.execute({
      cwd: input.cwd,
      args: [
        "api",
        "--hostname",
        input.host,
        endpoint,
        ...(pages ? ["--paginate", "--slurp"] : []),
      ],
    });
    if (result.stdoutTruncated || result.stdoutInvalidUtf8) {
      return yield* new GitHubAcceptanceReadError({
        message: "GitHub acceptance evidence was truncated or invalid.",
      });
    }
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(result.stdout);
  });
  const pullPath = `repos/${input.repository}/pulls/${input.number}`;
  const pull = yield* read(pullPath, Pull);
  if (
    pull.number !== input.number ||
    pull.base.repo.full_name.toLowerCase() !== input.repository.toLowerCase()
  ) {
    return yield* new GitHubAcceptanceReadError({
      message: "GitHub returned a different pull request identity.",
    });
  }
  const facts = {
    headRevision: pull.head.sha,
    baseRevision: pull.base.sha,
    merged: pull.merged,
    mergedSourceRevision: pull.merged ? pull.head.sha : null,
  };
  return yield* Effect.gen(function* () {
    const base = encodeURIComponent(pull.base.ref);
    const protection = yield* read(
      `repos/${input.repository}/branches/${base}/protection`,
      Protection,
    );
    const rulePages = yield* read(
      `repos/${input.repository}/rules/branches/${base}?per_page=100`,
      Schema.Array(Schema.Array(Rule)),
      true,
    );
    const rules = rulePages.flat();
    if (
      rules.some((rule) =>
        [
          "workflows",
          "required_workflows",
          "merge_queue",
          "required_deployments",
          "code_scanning",
          "required_code_scanning",
        ].includes(rule.type),
      )
    ) {
      return {
        ...facts,
        requiredChecks: "unknown" as const,
        checksRevision: null,
        blockers: [
          "GitHub workflow rules or merge queues require evidence this provider cannot verify.",
        ],
      };
    }
    const legacy = protection.required_status_checks;
    const requirements: Required[] =
      legacy?.checks === undefined
        ? (legacy?.contexts ?? []).map((context) => ({ context, app_id: null }))
        : [...legacy.checks];
    // Some hosts return both forms with unequal coverage; retain every context.
    for (const context of legacy?.contexts ?? []) {
      if (!requirements.some((check) => check.context === context))
        requirements.push({ context, app_id: null });
    }
    for (const rule of rules) {
      if (rule.type !== "required_status_checks") continue;
      const checks = yield* decodeRuleChecks(rule.parameters);
      requirements.push(
        ...checks.required_status_checks.map((check) => ({
          context: check.context,
          app_id: check.integration_id ?? null,
        })),
      );
    }
    const pages = yield* read(
      `repos/${input.repository}/commits/${pull.head.sha}/check-runs?filter=latest&per_page=100`,
      CheckPages,
      true,
    );
    const runs = pages.flatMap((page) => page.check_runs);
    if (pages.length === 0 || pages.some((page) => page.total_count !== runs.length)) {
      return yield* new GitHubAcceptanceReadError({
        message: "GitHub did not enumerate all check runs.",
      });
    }
    const statuses = (yield* read(
      `repos/${input.repository}/commits/${pull.head.sha}/statuses?per_page=100`,
      StatusPages,
      true,
    )).flat();
    const after = yield* read(pullPath, Pull);
    if (
      after.head.sha !== pull.head.sha ||
      after.base.sha !== pull.base.sha ||
      after.merged !== pull.merged
    ) {
      return yield* new GitHubAcceptanceReadError({
        message: "The pull request changed during evidence collection.",
      });
    }
    const requiredChecks = evaluateGitHubRequiredChecks(
      requirements,
      runs,
      statuses,
      pull.head.sha,
    );
    return {
      ...facts,
      requiredChecks,
      checksRevision: pull.head.sha,
      blockers:
        requiredChecks === "passing" || requiredChecks === "none"
          ? []
          : [`Required checks are ${requiredChecks}.`],
    };
  }).pipe(
    Effect.orElseSucceed(() => ({
      ...facts,
      requiredChecks: "unknown" as const,
      checksRevision: null,
      blockers: [
        "GitHub required-check policy or revision-bound check results could not be verified.",
      ],
    })),
  );
});

export const listGitHubAcceptanceCandidates = Effect.fn("listGitHubAcceptanceCandidates")(
  function* (
    cli: GitHubCli["Service"],
    input: ProviderRepositoryRef & {
      readonly branch: string;
      readonly headRevision: string | null;
      readonly sourceHost: string;
      readonly sourceRepository: string;
    },
  ) {
    if (input.sourceHost.toLowerCase() !== input.host.toLowerCase())
      return yield* new GitHubAcceptanceReadError({
        message: "The pull request source and target hosts do not match.",
      });
    const result = yield* cli.execute({
      cwd: input.cwd,
      args: [
        "pr",
        "list",
        "--repo",
        `${input.host}/${input.repository}`,
        "--head",
        input.branch,
        "--state",
        "all",
        "--limit",
        "101",
        "--json",
        "number,url,headRefName,headRefOid,headRepository,headRepositoryOwner,state",
      ],
    });
    if (result.stdoutTruncated || result.stdoutInvalidUtf8) {
      return yield* new GitHubAcceptanceReadError({
        message: "GitHub pull request enumeration was truncated or invalid.",
      });
    }
    const rows = yield* decodeCandidates(result.stdout);
    const candidates = rows.filter(
      (row) =>
        row.headRefName === input.branch &&
        row.state !== "CLOSED" &&
        !(
          row.state === "MERGED" &&
          input.headRevision !== null &&
          row.headRefOid !== input.headRevision
        ),
    );
    if (candidates.some((row) => row.headRepository === null || row.headRepositoryOwner === null))
      return yield* new GitHubAcceptanceReadError({
        message: "A current pull request source repository could not be verified.",
      });
    return {
      items: candidates.filter(
        (row) =>
          `${row.headRepositoryOwner!.login}/${row.headRepository!.name}`.toLowerCase() ===
          input.sourceRepository.toLowerCase(),
      ),
      truncated: rows.length > 100,
    };
  },
);
