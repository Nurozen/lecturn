import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GitHubCli } from "../sourceControl/GitHubCli.ts";
import {
  evaluateGitHubRequiredChecks,
  listGitHubAcceptanceCandidates,
  readGitHubAcceptanceEvidence,
} from "./gitHubAcceptanceEvidence.ts";

const head = "a".repeat(40);
const base = "b".repeat(40);
const input = { cwd: "/fixture", host: "github.example.com", repository: "acme/app", number: 7 };
const pull = {
  number: 7,
  head: { sha: head },
  base: { sha: base, ref: "release/next", repo: { full_name: "acme/app" } },
  merged: true,
};
const run = {
  id: 1,
  name: "build",
  head_sha: head,
  app: { id: 42 },
  status: "completed",
  conclusion: "success",
};
const protection = {
  url: "https://github.example.com/api/v3/repos/acme/app/branches/release%2Fnext/protection",
  required_status_checks: { contexts: ["build"], checks: [{ context: "build", app_id: 42 }] },
};
const responses = (
  overrides: {
    protection?: unknown;
    rules?: unknown;
    checks?: unknown;
    statuses?: unknown;
    after?: unknown;
  } = {},
) => [
  pull,
  overrides.protection ?? protection,
  overrides.rules ?? [[]],
  overrides.checks ?? [{ total_count: 1, check_runs: [run] }],
  overrides.statuses ?? [[]],
  overrides.after ?? pull,
];
const readFixture = Effect.fn("readFixture")(function* (
  values: ReadonlyArray<unknown>,
  truncated = false,
) {
  const calls: ReadonlyArray<string>[] = [];
  const program = Effect.gen(function* () {
    const cli = yield* GitHubCli;
    const evidence = yield* readGitHubAcceptanceEvidence(cli, input);
    return { evidence, calls };
  });
  return yield* program.pipe(
    Effect.provide(
      Layer.mock(GitHubCli)({
        execute: (request) => {
          const value = values[calls.length];
          calls.push(request.args);
          return Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: JSON.stringify(value),
            stderr: "",
            stdoutTruncated: truncated,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
          });
        },
      }),
    ),
  );
});

describe("GitHub revision-bound acceptance evidence", () => {
  it.effect(
    "enumerates protection and applicable rules, verifies source head before/after, and preserves merged source SHA",
    () =>
      Effect.gen(function* () {
        const result = yield* readFixture(responses());
        expect(result.evidence).toMatchObject({
          headRevision: head,
          checksRevision: head,
          requiredChecks: "passing",
          merged: true,
          mergedSourceRevision: head,
        });
        expect(result.calls).toHaveLength(6);
        expect(result.calls[1]).toContain("repos/acme/app/branches/release%2Fnext/protection");
        expect(result.calls[2]).toContain(
          "repos/acme/app/rules/branches/release%2Fnext?per_page=100",
        );
        expect(result.calls[3]).toContain(
          `repos/acme/app/commits/${head}/check-runs?filter=latest&per_page=100`,
        );
        expect(result.calls.every((args) => args.includes("github.example.com"))).toBe(true);
      }),
  );

  it.effect("explicitly proven zero requirements differs from empty check results", () =>
    Effect.gen(function* () {
      const none = yield* readFixture(
        responses({
          protection: { url: protection.url, required_status_checks: null },
          checks: [{ total_count: 0, check_runs: [] }],
        }),
      );
      expect(none.evidence.requiredChecks).toBe("none");
      expect(none.evidence.checksRevision).toBe(head);
      const missing = yield* readFixture(
        responses({ checks: [{ total_count: 0, check_runs: [] }] }),
      );
      expect(missing.evidence.requiredChecks).toBe("pending");
      const malformed = yield* readFixture(responses({ protection: {} }));
      expect(malformed.evidence.requiredChecks).toBe("unknown");
    }),
  );

  it.effect("ruleset-only required checks cannot disappear behind empty legacy requirements", () =>
    Effect.gen(function* () {
      const result = yield* readFixture(
        responses({
          protection: { url: protection.url, required_status_checks: null },
          rules: [
            [
              {
                type: "required_status_checks",
                parameters: { required_status_checks: [{ context: "deploy", integration_id: 77 }] },
              },
            ],
          ],
        }),
      );
      expect(result.evidence.requiredChecks).toBe("pending");
    }),
  );

  it.effect("required workflows and merge queues remain unknown capability limits", () =>
    Effect.gen(function* () {
      for (const type of ["workflows", "merge_queue", "code_scanning"]) {
        const result = yield* readFixture(responses({ rules: [[{ type }]] }));
        expect(result.evidence.requiredChecks).toBe("unknown");
        expect(result.evidence.checksRevision).toBeNull();
      }
    }),
  );

  it.effect(
    "wrong revision, missing contexts, truncated enumeration and moving PR heads cannot pass",
    () =>
      Effect.gen(function* () {
        const old = yield* readFixture(
          responses({ checks: [{ total_count: 1, check_runs: [{ ...run, head_sha: base }] }] }),
        );
        expect(old.evidence.requiredChecks).toBe("pending");
        const truncated = yield* readFixture(
          responses({ checks: [{ total_count: 2, check_runs: [run] }] }),
        );
        expect(truncated.evidence.requiredChecks).toBe("unknown");
        const moving = yield* readFixture(responses({ after: { ...pull, head: { sha: base } } }));
        expect(moving.evidence.requiredChecks).toBe("unknown");
        const malformed = yield* readFixture(responses(), true).pipe(Effect.result);
        expect(Result.isFailure(malformed)).toBe(true);
      }),
  );

  it("requires the expected app, latest run, source SHA, and legacy status contexts", () => {
    const required = [{ context: "build", app_id: 42 }];
    expect(evaluateGitHubRequiredChecks(required, [{ ...run, app: { id: 99 } }], [], head)).toBe(
      "pending",
    );
    expect(
      evaluateGitHubRequiredChecks(
        required,
        [run, { ...run, id: 2, conclusion: "failure" }],
        [],
        head,
      ),
    ).toBe("failing");
    expect(
      evaluateGitHubRequiredChecks(
        required,
        [
          { ...run, conclusion: "failure" },
          { ...run, id: 2 },
        ],
        [],
        head,
      ),
    ).toBe("passing");
    expect(
      evaluateGitHubRequiredChecks(
        [{ context: "lint", app_id: null }],
        [],
        [{ id: 1, context: "lint", state: "success" }],
        head,
      ),
    ).toBe("passing");
    expect(
      evaluateGitHubRequiredChecks(
        [{ context: "lint", app_id: null }],
        [],
        [
          { id: 1, context: "lint", state: "success" },
          { id: 2, context: "lint", state: "pending" },
        ],
        head,
      ),
    ).toBe("pending");
    expect(
      evaluateGitHubRequiredChecks(
        required,
        [{ ...run, status: "in_progress", conclusion: null }],
        [],
        head,
      ),
    ).toBe("pending");
  });

  it.effect(
    "keeps verified fork deliveries while rejecting other forks with the same branch and head",
    () =>
      Effect.gen(function* () {
        const cli = yield* GitHubCli;
        const result = yield* listGitHubAcceptanceCandidates(cli, {
          ...input,
          branch: "feature/fix",
          headRevision: head,
          sourceHost: input.host,
          sourceRepository: "alice/app",
        });
        expect(result.items.map((item) => item.number)).toEqual([21, 22]);
        expect(result.truncated).toBe(false);
        const crossHost = yield* listGitHubAcceptanceCandidates(cli, {
          ...input,
          branch: "feature/fix",
          headRevision: head,
          sourceHost: "different.example.com",
          sourceRepository: "alice/app",
        }).pipe(Effect.result);
        expect(Result.isFailure(crossHost)).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.mock(GitHubCli)({
            execute: () =>
              Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: JSON.stringify(
                  [
                    { number: 21, owner: "alice", state: "OPEN", revision: head },
                    { number: 22, owner: "alice", state: "MERGED", revision: head },
                    { number: 23, owner: "alice", state: "MERGED", revision: base },
                    { number: 24, owner: "bob", state: "OPEN", revision: head },
                    { number: 25, owner: "acme", state: "OPEN", revision: head },
                  ].map((row) => ({
                    number: row.number,
                    url: `https://${input.host}/acme/app/pull/${row.number}`,
                    headRefName: "feature/fix",
                    headRefOid: row.revision,
                    headRepository: { name: "app" },
                    headRepositoryOwner: { login: row.owner },
                    state: row.state,
                  })),
                ),
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
              }),
          }),
        ),
      ),
  );

  it.effect(
    "discovers exact source repo and branch, retaining current merged PRs and excluding old deliveries or fork namesakes",
    () =>
      Effect.gen(function* () {
        let args: ReadonlyArray<string> = [];
        const result = yield* Effect.gen(function* () {
          const cli = yield* GitHubCli;
          return yield* listGitHubAcceptanceCandidates(cli, {
            ...input,
            branch: "feature/fix",
            headRevision: head,
            sourceHost: input.host,
            sourceRepository: input.repository,
          });
        }).pipe(
          Effect.provide(
            Layer.mock(GitHubCli)({
              execute: (request) => {
                args = request.args;
                return Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: JSON.stringify([
                    {
                      number: 7,
                      url: "https://github.example.com/acme/app/pull/7",
                      headRefOid: head,
                      headRepository: { name: "app" },
                      headRepositoryOwner: { login: "acme" },
                      headRefName: "feature/fix",
                      state: "MERGED",
                    },
                    {
                      number: 8,
                      url: "https://github.example.com/acme/app/pull/8",
                      headRefOid: head,
                      headRepository: { name: "app" },
                      headRepositoryOwner: { login: "acme" },
                      headRefName: "other",
                      state: "OPEN",
                    },
                    {
                      number: 10,
                      url: "https://github.example.com/acme/app/pull/10",
                      headRefName: "feature/fix",
                      state: "MERGED",
                      headRefOid: "c".repeat(40),
                      headRepository: { name: "app" },
                      headRepositoryOwner: { login: "acme" },
                    },
                    {
                      number: 11,
                      url: "https://github.example.com/acme/app/pull/11",
                      headRefName: "feature/fix",
                      state: "OPEN",
                      headRefOid: head,
                      headRepository: { name: "app" },
                      headRepositoryOwner: { login: "other-fork" },
                    },
                    {
                      number: 9,
                      url: "https://github.example.com/acme/app/pull/9",
                      headRefOid: head,
                      headRepository: { name: "app" },
                      headRepositoryOwner: { login: "acme" },
                      headRefName: "feature/fix",
                      state: "CLOSED",
                    },
                  ]),
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                });
              },
            }),
          ),
        );
        expect(result.items.map((item) => item.number)).toEqual([7]);
        expect(result.truncated).toBe(false);
        expect(args).toContain("--head");
        expect(args).toContain("feature/fix");
        expect(args).toContain("github.example.com/acme/app");
      }),
  );
});
