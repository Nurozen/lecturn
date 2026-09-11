import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, type SagaWorkbenchIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as GitHubProvider from "../pullRequest/GitHubPullRequestProvider.ts";
import { GitHubPullRequestCli } from "../pullRequest/GitHubPullRequestCli.ts";
import * as ProcessRunner from "../processRunner.ts";
import { PullRequestProviderRegistry } from "../pullRequest/PullRequestProviderRegistry.ts";
import {
  PullRequestProviderError,
  type ProviderAcceptanceEvidence,
  type PullRequestProviderApi,
} from "../pullRequest/PullRequestProvider.ts";
import * as Evidence from "./SagaWorkbenchEvidence.ts";

const projectId = Schema.decodeUnknownSync(ProjectId)("p1");
const createdAt = "2026-09-10T00:00:00.000Z";
const failure = new PullRequestProviderError({
  provider: "github",
  operation: "test",
  reason: "failed",
  detail: "offline",
});
const fixture = Effect.fn("fixture")(function* (
  options: {
    readonly candidates?: ReadonlyArray<{ number: number; url: string }>;
    readonly facts?: Partial<ProviderAcceptanceEvidence>;
    readonly truncated?: boolean;
    readonly offline?: boolean;
    readonly unsupported?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const cwd = path.join(root, "app");
  yield* fs.makeDirectory(cwd);
  const git = Effect.fn("fixture.git")(function* (...args: ReadonlyArray<string>) {
    const output = yield* runner.run({ command: "git", args: ["-C", cwd, ...args] });
    expect(output.code, output.stderr).toBe(0);
    return output.stdout.trim();
  });
  yield* git("init", "-b", "main");
  yield* git("config", "user.email", "test@example.invalid");
  yield* git("config", "user.name", "Fixture");
  yield* fs.writeFileString(path.join(cwd, "tracked.txt"), "base\n");
  yield* git("add", "tracked.txt");
  yield* git("commit", "-m", "base");
  yield* git("remote", "add", "origin", "https://github.com/acme/app.git");
  const head = yield* git("rev-parse", "HEAD");
  yield* git("checkout", "-b", "work");
  const identity: SagaWorkbenchIdentity = {
    projectId,
    workspaceRoot: root,
    spaceId: "space",
    createdAt,
  };
  const manifest = (repos: string) =>
    fs.writeFileString(
      path.join(root, ".stave.yaml"),
      `id: space\ncreatedAt: ${createdAt}\nrepos:\n${repos}`,
    );
  yield* manifest("  - { name: app, mode: edit, path: app, base: main }\n");
  let discoveries = 0;
  let candidates = options.candidates ?? [];
  const discoveryInputs: Array<
    Parameters<NonNullable<PullRequestProviderApi["listAcceptanceCandidates"]>>[0]
  > = [];
  const reads: Array<{ host: string; repository: string; number: number }> = [];
  const { readAcceptanceEvidence: _unusedAcceptance, ...providerBase } =
    yield* GitHubProvider.make.pipe(Effect.provide(Layer.mock(GitHubPullRequestCli)({})));
  const provider: PullRequestProviderApi = {
    ...providerBase,
    kind: "github",
    listAcceptanceCandidates: (input) => {
      discoveries += 1;
      discoveryInputs.push(input);
      return options.offline
        ? Effect.fail(failure)
        : Effect.succeed({
            items: candidates,
            truncated: options.truncated ?? false,
          });
    },
    ...(options.unsupported
      ? {}
      : {
          readAcceptanceEvidence: (input: { host: string; repository: string; number: number }) => {
            reads.push(input);
            return Effect.succeed({
              headRevision: head,
              baseRevision: head,
              requiredChecks: "passing",
              checksRevision: head,
              merged: true,
              mergedSourceRevision: head,
              blockers: [],
              ...options.facts,
            } satisfies ProviderAcceptanceEvidence);
          },
        }),
  };
  const service = yield* Evidence.make.pipe(
    Effect.provideService(PullRequestProviderRegistry, {
      get: (kind) => (kind === "github" ? provider : null),
      kinds: ["github"],
    }),
  );
  return {
    fs,
    path,
    root,
    cwd,
    head,
    identity,
    manifest,
    git,
    service,
    reads,
    discoveryInputs,
    setCandidates: (next: ReadonlyArray<{ number: number; url: string }>) => {
      candidates = next;
    },
    discoveries: () => discoveries,
  };
});
const testLayer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const test = it.layer(testLayer);
const pr = { number: 7, url: "https://github.com/acme/app/pull/7" };

test("Saga workbench fresh acceptance evidence", (it) => {
  it.effect("discovers a fork source independently from its upstream PR target", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ candidates: [pr] });
      yield* f.git("remote", "set-url", "origin", "https://github.com/alice/app.git");
      yield* f.git("remote", "add", "upstream", "https://github.com/acme/app.git");
      yield* f.git("config", "branch.work.remote", "origin");
      yield* f.git("config", "branch.work.merge", "refs/heads/published-work");
      yield* f.git("config", "push.default", "upstream");
      const result = yield* f.service.read({ identity: f.identity });
      expect(result.complete).toBe(true);
      expect(result.requirements[0]).toMatchObject({
        kind: "pull-request",
        repository: "acme/app",
        number: pr.number,
        localHeadMatches: true,
      });
      expect(f.discoveryInputs[0]).toMatchObject({
        repository: "acme/app",
        sourceHost: "github.com",
        sourceRepository: "alice/app",
        branch: "published-work",
      });
      expect(f.reads[0]).toMatchObject({ repository: "acme/app", number: pr.number });
      yield* f.service.revalidate({ identity: f.identity, evidence: result });
      yield* f.git("remote", "set-url", "origin", "https://github.com/bob/app.git");
      const moved = yield* f.service
        .revalidate({ identity: f.identity, evidence: result })
        .pipe(Effect.result);
      expect(Result.isFailure(moved)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("uses the local feature branch when its tracking branch is the base", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ candidates: [pr] });
      yield* f.git("config", "branch.work.remote", "origin");
      yield* f.git("config", "branch.work.merge", "refs/heads/main");
      for (const mode of ["simple", "current", "matching"]) {
        yield* f.git("config", "push.default", mode);
        const result = yield* f.service.read({ identity: f.identity });
        expect(result.requirements[0]?.number).toBe(pr.number);
        expect(f.discoveryInputs.at(-1)?.branch).toBe("work");
      }
      yield* f.git("config", "push.default", "upstream");
      yield* f.service.read({ identity: f.identity });
      expect(f.discoveryInputs.at(-1)?.branch).toBe("main");
    }).pipe(Effect.scoped),
  );

  it.effect("honors explicit push remotes before tracking and blocks ambiguous push targets", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.git("remote", "add", "upstream", "https://github.com/acme/app.git");
      yield* f.git("remote", "add", "fork", "https://github.com/alice/app.git");
      yield* f.git("config", "branch.work.remote", "upstream");
      yield* f.git("config", "branch.work.merge", "refs/heads/main");
      yield* f.git("config", "remote.pushDefault", "fork");
      yield* f.service.read({ identity: f.identity });
      expect(f.discoveryInputs[0]).toMatchObject({ sourceRepository: "alice/app", branch: "work" });
      yield* f.git("config", "branch.work.pushRemote", "origin");
      yield* f.service.read({ identity: f.identity });
      expect(f.discoveryInputs[1]).toMatchObject({ sourceRepository: "acme/app", branch: "work" });
      yield* f.git(
        "remote",
        "set-url",
        "--add",
        "--push",
        "origin",
        "https://github.com/acme/app.git",
      );
      yield* f.git(
        "remote",
        "set-url",
        "--add",
        "--push",
        "origin",
        "https://github.com/bob/app.git",
      );
      const ambiguous = yield* f.service.read({ identity: f.identity });
      expect(ambiguous.complete).toBe(false);
      expect(ambiguous.blockers.join(" ")).toContain("source remote");
      expect(f.discoveryInputs).toHaveLength(2);
      yield* f.git("config", "branch.work.pushRemote", "missing");
      const missing = yield* f.service.read({ identity: f.identity });
      expect(missing.complete).toBe(false);
      expect(f.discoveryInputs).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "proves clean unchanged checkout against resolved base and keeps observation-free revisions stable",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const first = yield* f.service.read({ identity: f.identity });
        const second = yield* f.service.read({ identity: f.identity });
        expect(first.complete).toBe(true);
        expect(first.requirements).toHaveLength(1);
        expect(first.requirements[0]).toMatchObject({
          kind: "no-changes",
          localHeadRevision: f.head,
          baseRevision: f.head,
          localChanges: "clean",
        });
        expect(first.sourceRevision).toBe(second.sourceRevision);
        yield* f.service.revalidate({ identity: f.identity, evidence: first });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "dirty files, unpushed commits, and missing base cannot claim no delivery changes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(f.path.join(f.cwd, "new.txt"), "untracked");
        const dirty = yield* f.service.read({ identity: f.identity });
        expect(dirty.requirements[0]).toMatchObject({ kind: "unknown", localChanges: "dirty" });
        yield* f.git("add", "new.txt");
        yield* f.git("commit", "-m", "local change");
        const ahead = yield* f.service.read({ identity: f.identity });
        expect(ahead.requirements[0]).toMatchObject({ kind: "unknown", localChanges: "clean" });
        yield* f.manifest("  - { name: app, mode: edit, path: app, base: missing }\n");
        const missing = yield* f.service.read({ identity: f.identity });
        expect(missing.requirements[0]?.baseRevision).toBeNull();
        expect(missing.blockers.join(" ")).toContain("resolved base");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "retains every unresolved editable repository and rejects ancestor-checkout inheritance",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.makeDirectory(f.path.join(f.cwd, "nested"));
        yield* f.manifest(
          "  - { name: app, mode: edit, path: app, base: main }\n  - { name: missing, mode: edit, path: missing }\n  - { name: nested, mode: edit, path: app/nested }\n  - { name: invalid, mode: edit }\n",
        );
        const result = yield* f.service.read({ identity: f.identity });
        expect(result.requirements.map((row) => row.repoName)).toEqual([
          "app",
          "missing",
          "nested",
          "invalid",
        ]);
        expect(result.requirements.filter((row) => row.kind === "unknown")).toHaveLength(3);
        expect(result.complete).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("reference ownership wins physical symlink aliases regardless of order", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.symlink(f.cwd, f.path.join(f.root, "alias"));
      yield* f.manifest(
        "  - { name: edit, mode: edit, path: app, base: main }\n  - { name: reference, mode: reference, path: alias }\n",
      );
      const result = yield* f.service.read({ identity: f.identity });
      expect(result.requirements).toEqual([]);
      expect(result.complete).toBe(true);
      expect(f.discoveries()).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a relevant PR always remains a requirement even for a checkout equal to its base",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ candidates: [pr] });
        const result = yield* f.service.read({ identity: f.identity });
        expect(result.requirements[0]).toMatchObject({
          kind: "pull-request",
          headRevision: f.head,
          localHeadMatches: true,
          requiredChecks: "passing",
          mergedSourceRevision: f.head,
        });
        expect(f.reads).toHaveLength(1);
        yield* f.service.read({ identity: f.identity });
        expect(f.reads).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "retains approved host/repository/PR after checkout branch movement while reconciling discovery",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ candidates: [pr] });
        const approved = yield* f.service.read({ identity: f.identity });
        yield* f.git("checkout", "main");
        f.setCandidates([]);
        const after = yield* f.service.read({
          identity: f.identity,
          acceptedRequirements: approved.requirements,
        });
        expect(after.requirements[0]?.number).toBe(7);
        expect(after.requirements[0]?.localHeadMatches).toBe(true);
        expect(f.discoveries()).toBe(2);
        expect(f.reads[1]).toMatchObject({ host: "github.com", repository: "acme/app", number: 7 });
      }).pipe(Effect.scoped),
  );

  it.effect("retains approved PRs and includes newly discovered delivery requirements", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ candidates: [pr] });
      const approved = yield* f.service.read({ identity: f.identity });
      f.setCandidates([pr, { number: 8, url: "https://github.com/acme/app/pull/8" }]);
      const current = yield* f.service.read({
        identity: f.identity,
        acceptedRequirements: approved.requirements,
      });
      expect(current.requirements.map((row) => row.number)).toEqual([7, 8]);
      expect(current.sourceRevision).not.toBe(approved.sourceRevision);
      expect(current.requirements[1]?.key).not.toBe(approved.requirements[0]?.key);
      expect(f.reads.slice(1).map((row) => row.number)).toEqual([7, 8]);
      yield* f.git("checkout", "--detach", f.head);
      const detached = yield* f.service.read({
        identity: f.identity,
        acceptedRequirements: approved.requirements,
      });
      expect(detached.complete).toBe(false);
      expect(detached.blockers.join(" ")).toContain("cannot enumerate");
    }).pipe(Effect.scoped),
  );

  it.effect("changed remote identity and removed approved requirements remain blocking", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ candidates: [pr] });
      const approved = yield* f.service.read({ identity: f.identity });
      yield* f.git("remote", "set-url", "origin", "https://github.com/other/app.git");
      const changed = yield* f.service.read({
        identity: f.identity,
        acceptedRequirements: approved.requirements,
      });
      expect(changed.complete).toBe(false);
      expect(changed.requirements.every((row) => row.kind === "unknown")).toBe(true);
      expect(f.reads).toHaveLength(1);
      yield* f.manifest("  []\n");
      const removed = yield* f.service.read({
        identity: f.identity,
        acceptedRequirements: approved.requirements,
      });
      expect(removed.requirements).toHaveLength(1);
      expect(removed.requirements[0]?.number).toBe(7);
      expect(removed.complete).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("unknown provider capability never fabricates zero required checks", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ candidates: [pr], unsupported: true });
      const result = yield* f.service.read({ identity: f.identity });
      expect(result.requirements[0]).toMatchObject({
        kind: "pull-request",
        requiredChecks: "unknown",
        headRevision: null,
        localHeadMatches: null,
        merged: null,
      });
      expect(result.blockers.join(" ")).toContain("cannot supply");
    }).pipe(Effect.scoped),
  );

  for (const options of [{ offline: true }, { truncated: true }]) {
    it.effect(`incomplete discovery never exempts a clean repo: ${JSON.stringify(options)}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(options);
        const result = yield* f.service.read({ identity: f.identity });
        expect(result.complete).toBe(false);
        expect(result.requirements[0]?.kind).toBe("unknown");
      }).pipe(Effect.scoped),
    );
  }

  it.effect(
    "display may tolerate PR base advance while publication and no-change proof remain strict",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ candidates: [pr] });
        const before = yield* f.service.read({ identity: f.identity });
        yield* f.git("checkout", "main");
        yield* f.git("commit", "--allow-empty", "-m", "advance base");
        yield* f.git("checkout", "work");
        yield* f.service.revalidate({
          identity: f.identity,
          evidence: before,
          allowPullRequestBaseAdvance: true,
        });
        const strict = yield* f.service
          .revalidate({ identity: f.identity, evidence: before })
          .pipe(Effect.result);
        expect(Result.isFailure(strict)).toBe(true);
        const noChange = yield* f.service
          .revalidate({
            identity: f.identity,
            evidence: {
              ...before,
              requirements: before.requirements.map((row) => ({
                ...row,
                kind: "no-changes" as const,
              })),
            },
            allowPullRequestBaseAdvance: true,
          })
          .pipe(Effect.result);
        expect(Result.isFailure(noChange)).toBe(true);
        expect(f.reads).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "local-only final fence rejects changes to HEAD, base, dirty state and manifest without provider reads",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ candidates: [pr] });
        const before = yield* f.service.read({ identity: f.identity });
        yield* f.fs.writeFileString(f.path.join(f.cwd, "untracked.txt"), "new");
        const dirty = yield* f.service
          .revalidate({ identity: f.identity, evidence: before })
          .pipe(Effect.result);
        expect(Result.isFailure(dirty)).toBe(true);
        yield* f.git("add", "untracked.txt");
        yield* f.git("commit", "-m", "new head");
        const head = yield* f.service
          .revalidate({ identity: f.identity, evidence: before })
          .pipe(Effect.result);
        expect(Result.isFailure(head)).toBe(true);
        yield* f.git("reset", "--hard", f.head);
        yield* f.git("commit", "--allow-empty", "-m", "advance base");
        const newBase = yield* f.git("rev-parse", "HEAD");
        yield* f.git("reset", "--hard", f.head);
        yield* f.git("branch", "-f", "main", newBase);
        const base = yield* f.service
          .revalidate({ identity: f.identity, evidence: before })
          .pipe(Effect.result);
        expect(Result.isFailure(base)).toBe(true);
        yield* f.manifest("  - { name: renamed, mode: edit, path: app, base: main }\n");
        const manifest = yield* f.service
          .revalidate({ identity: f.identity, evidence: before })
          .pipe(Effect.result);
        expect(Result.isFailure(manifest)).toBe(true);
        expect(f.reads).toHaveLength(1);
        expect(f.discoveries()).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect("rejects fresh physical incarnation changes", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const result = yield* f.service
        .read({ identity: { ...f.identity, createdAt: "2026-09-09T00:00:00.000Z" } })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.code).toBe("identity");
      expect(f.discoveries()).toBe(0);
    }).pipe(Effect.scoped),
  );
});
