import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { GitHubApi } from "../sourceControl/GitHubApi.ts";
import type { ProviderAcceptanceEvidence, ProviderRepositoryRef } from "./PullRequestProvider.ts";

class GitHubAcceptanceReadError extends Schema.TaggedError<GitHubAcceptanceReadError>()(
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
const CheckPage = Schema.Struct({
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
});
const StatusPage = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    context: Schema.String,
    state: Schema.String,
  }),
);

const decodeRuleChecks = Schema.decodeUnknownEffect(RuleChecks);
const decodeCandidates = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.Struct({
          pullRequests: Schema.Struct({
            totalCount: Schema.Number,
            nodes: Schema.Array(
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
          }),
        }),
      }),
    }),
  ),
);

/** Every pull request with this head branch name, from any fork, as `gh pr list --head` lists them. */
const ACCEPTANCE_CANDIDATES_GRAPHQL_QUERY = `
query AcceptanceCandidates($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN, CLOSED, MERGED], first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
      totalCount
      nodes {
        number
        url
        headRefName
        headRefOid
        headRepository { name }
        headRepositoryOwner { login }
        state
      }
    }
  }
}`;

const MAX_ACCEPTANCE_PAGES = 100;

type Required = typeof RequiredCheck.Type;
type Run = (typeof CheckPage.Type)["check_runs"][number];
type Status = (typeof StatusPage.Type)[number];

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
  api: GitHubApi["Service"],
  input: ProviderRepositoryRef & { readonly number: number },
) {
  const fetch = Effect.fn("readGitHubAcceptanceEvidence.api")(function* <S extends Schema.Top>(
    endpoint: string,
    schema: S,
  ) {
    const response = yield* api.rest({
      host: input.host,
      operation: "readAcceptanceEvidence",
      path: endpoint,
    });
    if (response.truncated || response.invalidUtf8) {
      return yield* new GitHubAcceptanceReadError({
        message: "GitHub acceptance evidence was truncated or invalid.",
      });
    }
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.body);
    return { value, next: /rel="next"/.test(response.headers["link"] ?? "") };
  });
  const read = <S extends Schema.Top>(endpoint: string, schema: S) =>
    fetch(endpoint, schema).pipe(Effect.map((result) => result.value));
  // Every page, in order, the way `gh api --paginate --slurp` collected them.
  const readPages = Effect.fn("readGitHubAcceptanceEvidence.pages")(function* <
    S extends Schema.Top,
  >(endpoint: string, schema: S) {
    const pages: Array<S["Type"]> = [];
    for (let page = 1; page <= MAX_ACCEPTANCE_PAGES; page++) {
      const result = yield* fetch(
        `${endpoint}${endpoint.includes("?") ? "&" : "?"}page=${page}`,
        schema,
      );
      pages.push(result.value);
      if (!result.next) return pages;
    }
    return yield* new GitHubAcceptanceReadError({
      message: "GitHub acceptance evidence had too many pages to enumerate.",
    });
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
    const rulePages = yield* readPages(
      `repos/${input.repository}/rules/branches/${base}?per_page=100`,
      Schema.Array(Rule),
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
    const pages = yield* readPages(
      `repos/${input.repository}/commits/${pull.head.sha}/check-runs?filter=latest&per_page=100`,
      CheckPage,
    );
    const runs = pages.flatMap((page) => page.check_runs);
    if (pages.length === 0 || pages.some((page) => page.total_count !== runs.length)) {
      return yield* new GitHubAcceptanceReadError({
        message: "GitHub did not enumerate all check runs.",
      });
    }
    const statuses = (yield* readPages(
      `repos/${input.repository}/commits/${pull.head.sha}/statuses?per_page=100`,
      StatusPage,
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
    api: GitHubApi["Service"],
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
    const [owner = "", name = ""] = input.repository.split("/");
    const raw = yield* api.graphql({
      host: input.host,
      operation: "listAcceptanceCandidates",
      query: ACCEPTANCE_CANDIDATES_GRAPHQL_QUERY,
      variables: { owner, name, head: input.branch },
    });
    const listed = (yield* decodeCandidates(raw)).data.repository.pullRequests;
    const rows = listed.nodes;
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
      truncated: listed.totalCount > rows.length,
    };
  },
);
