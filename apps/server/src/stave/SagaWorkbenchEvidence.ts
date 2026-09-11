// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  SagaWorkbenchError,
  type SagaWorkbenchEvidence as Evidence,
  type SagaWorkbenchIdentity,
  type SagaWorkbenchRequirement,
  type SourceControlProviderKind,
} from "@lecturn/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@lecturn/shared/git";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ProcessRunner } from "../processRunner.ts";
import { PullRequestProviderRegistry } from "../pullRequest/PullRequestProviderRegistry.ts";
import type { ProviderAcceptanceEvidence } from "../pullRequest/PullRequestProvider.ts";
import { readManifest } from "./StaveWorkspaceReader.ts";
import { sameManifestIncarnation } from "./staveIncarnation.ts";
import type { ManifestScalar } from "./staveManifest.ts";

export class SagaWorkbenchEvidence extends Context.Service<
  SagaWorkbenchEvidence,
  {
    readonly read: (input: {
      readonly identity: SagaWorkbenchIdentity;
      readonly acceptedRequirements?: ReadonlyArray<SagaWorkbenchRequirement>;
    }) => Effect.Effect<Evidence, SagaWorkbenchError>;
    /** Local-only publication fence. The caller holds the canonical Stave space lock. */
    readonly revalidate: (input: {
      readonly identity: SagaWorkbenchIdentity;
      readonly evidence: Evidence;
      /** Display-only comparison of prior approval; publication always uses the strict default. */
      readonly allowPullRequestBaseAdvance?: boolean;
    }) => Effect.Effect<void, SagaWorkbenchError>;
  }
>()("lecturn/stave/SagaWorkbenchEvidence") {
  static readonly layer = Layer.effect(
    SagaWorkbenchEvidence,
    Effect.suspend(() => make),
  );
}

const digest = (value: unknown): string =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scalar = (value: ManifestScalar | null | undefined): string | null =>
  value === undefined || value === null
    ? null
    : (value instanceof Date ? value.toISOString() : String(value)).trim() || null;
const error = (message: string, code: SagaWorkbenchError["code"] = "blocked") =>
  new SagaWorkbenchError({ code, message });

interface LocalRepo {
  readonly repoName: string;
  readonly checkoutPath: string;
  readonly provider: SourceControlProviderKind | null;
  readonly host: string | null;
  readonly repository: string | null;
  readonly head: string | null;
  readonly base: string | null;
  readonly branch: string | null;
  readonly sourceHost: string | null;
  readonly sourceRepository: string | null;
  readonly sourceBranch: string | null;
  readonly changes: SagaWorkbenchRequirement["localChanges"];
  readonly noChanges: boolean;
  readonly blockers: ReadonlyArray<string>;
}
const localKey = (repo: Pick<LocalRepo, "checkoutPath" | "repoName">) =>
  digest([repo.checkoutPath, repo.repoName]);
const emptyProvider: ProviderAcceptanceEvidence = {
  headRevision: null,
  baseRevision: null,
  requiredChecks: "unknown",
  checksRevision: null,
  merged: null,
  mergedSourceRevision: null,
  blockers: [],
};

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner;
  const registry = yield* PullRequestProviderRegistry;

  const git = Effect.fn("SagaWorkbenchEvidence.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* runner
      .run({
        command: "git",
        args: ["--no-optional-locks", "-C", cwd, ...args],
        timeout: "10 seconds",
        maxOutputBytes: 1024 * 1024,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (
      Option.isNone(result) ||
      result.value.code !== 0 ||
      result.value.timedOut ||
      result.value.stdoutTruncated ||
      result.value.stdoutInvalidUtf8
    )
      return null;
    return result.value.stdout.trim();
  });
  const canonical = (root: string) =>
    fs.realPath(root).pipe(Effect.orElseSucceed(() => path.resolve(root)));
  const local = Effect.fn("SagaWorkbenchEvidence.local")(function* (
    identity: SagaWorkbenchIdentity,
  ) {
    const root = yield* fs
      .realPath(identity.workspaceRoot)
      .pipe(Effect.mapError(() => error("The space root is unavailable.", "identity")));
    if (
      root !== path.normalize(identity.workspaceRoot) ||
      path.basename(path.dirname(root)) === ".archive"
    ) {
      return yield* error(
        "The space root is no longer the selected live physical workspace.",
        "identity",
      );
    }
    const manifest = yield* readManifest(root).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    if (
      Option.isNone(manifest) ||
      scalar(manifest.value.id) !== identity.spaceId ||
      !sameManifestIncarnation(scalar(manifest.value.createdAt) ?? "", identity.createdAt)
    ) {
      return yield* error(
        "The Stave manifest no longer matches the selected space incarnation.",
        "identity",
      );
    }
    const rawRepos = manifest.value.repos ?? [];
    const rows = yield* Effect.forEach(
      rawRepos,
      Effect.fn("SagaWorkbenchEvidence.checkout")(function* (repo, index) {
        const rawPath = scalar(repo.path);
        const resolved =
          rawPath === null || rawPath.includes("\0") ? root : path.resolve(root, rawPath);
        const relative = path.relative(root, resolved);
        const validPath =
          rawPath !== null &&
          !rawPath.includes("\0") &&
          (path.isAbsolute(rawPath) ||
            !(
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative)
            ));
        return {
          repo,
          index,
          validPath,
          checkoutPath: validPath ? yield* canonical(resolved) : resolved,
        };
      }),
      { concurrency: 4 },
    );
    const references = new Set(
      rows
        .filter((row) => scalar(row.repo.mode) === "reference" && row.validPath)
        .map((row) => row.checkoutPath),
    );
    const seen = new Set<string>();
    const editable = rows.filter((row) => {
      if (scalar(row.repo.mode) === "reference") return false;
      if (row.validPath && (references.has(row.checkoutPath) || seen.has(row.checkoutPath)))
        return false;
      if (row.validPath) seen.add(row.checkoutPath);
      return true;
    });
    const repos = yield* Effect.forEach(
      editable,
      Effect.fn("SagaWorkbenchEvidence.localRepo")(function* (row): Effect.fn.Return<LocalRepo> {
        const blockers: string[] = [];
        const repoName = scalar(row.repo.name) ?? `Unresolved repository ${row.index + 1}`;
        const mode = scalar(row.repo.mode);
        if (mode !== "edit") blockers.push("The manifest repository mode is unknown.");
        if (!row.validPath) blockers.push("The manifest checkout path is invalid or missing.");
        const top = row.validPath
          ? yield* git(row.checkoutPath, ["rev-parse", "--show-toplevel"])
          : null;
        const ownCheckout = top !== null && (yield* canonical(top)) === row.checkoutPath;
        if (!ownCheckout)
          blockers.push("The manifest path does not identify its own Git checkout.");
        const readGit = (args: ReadonlyArray<string>) =>
          ownCheckout ? git(row.checkoutPath, args) : Effect.succeed(null);
        const head = yield* readGit(["rev-parse", "--verify", "HEAD^{commit}"]);
        const baseRef = scalar(row.repo.base);
        const base =
          baseRef === null
            ? null
            : yield* readGit(["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
        const status = yield* readGit([
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ]);
        const changes = status === null ? "unknown" : status === "" ? "clean" : "dirty";
        const branch = yield* readGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
        const remoteNames = (yield* readGit(["remote"]))?.split("\n").filter(Boolean) ?? [];
        const remoteName =
          ["upstream", "origin"].find((name) => remoteNames.includes(name)) ??
          remoteNames.toSorted()[0];
        const remote =
          remoteName === undefined ? null : yield* readGit(["remote", "get-url", remoteName]);
        const identityKey = remote === null ? null : normalizeGitRemoteUrl(remote);
        const provider =
          remote === null
            ? null
            : (detectSourceControlProviderFromGitRemoteUrl(remote)?.kind ?? null);
        const host = identityKey?.split("/")[0] || null;
        const repository = identityKey?.split("/").slice(1).join("/") || null;
        if (provider === null || host === null || repository === null)
          blockers.push("The repository's provider and remote identity could not be resolved.");
        // A fork's delivery target and pushed source are different repositories.
        // Honor Git's explicit push/tracking selection before conventional origin.
        const branchRemote =
          branch === null ? null : yield* readGit(["config", "--get", `branch.${branch}.remote`]);
        const pushRemote =
          branch === null
            ? null
            : yield* readGit(["config", "--get", `branch.${branch}.pushRemote`]);
        const pushDefault = yield* readGit(["config", "--get", "remote.pushDefault"]);
        const sourceRemoteName =
          pushRemote ??
          pushDefault ??
          branchRemote ??
          (remoteNames.includes("origin")
            ? "origin"
            : remoteNames.length === 1
              ? remoteNames[0]!
              : null);
        const sourceUrls =
          sourceRemoteName !== null && remoteNames.includes(sourceRemoteName)
            ? yield* readGit(["remote", "get-url", "--push", "--all", sourceRemoteName])
            : null;
        const sourceUrlRows = sourceUrls?.split("\n").filter(Boolean) ?? [];
        const sourceUrl = sourceUrlRows.length === 1 ? sourceUrlRows[0]! : null;
        const sourceKey = sourceUrl === null ? null : normalizeGitRemoteUrl(sourceUrl);
        const sourceHost = sourceKey?.split("/")[0] || null;
        const sourceRepository = sourceKey?.split("/").slice(1).join("/") || null;
        const trackingRef =
          branch === null ? null : yield* readGit(["config", "--get", `branch.${branch}.merge`]);
        const pushMode = yield* readGit(["config", "--get", "push.default"]);
        const sourceBranch =
          pushMode === "upstream" &&
          sourceRemoteName === branchRemote &&
          trackingRef?.startsWith("refs/heads/")
            ? trackingRef.slice("refs/heads/".length)
            : branch;
        const pushRefspec =
          sourceRemoteName === null
            ? null
            : yield* readGit(["config", "--get-all", `remote.${sourceRemoteName}.push`]);
        if (
          sourceHost === null ||
          sourceRepository === null ||
          sourceHost !== host ||
          sourceUrl === null ||
          detectSourceControlProviderFromGitRemoteUrl(sourceUrl)?.kind !== provider ||
          pushRefspec !== null
        )
          blockers.push(
            "The pull request source remote or branch mapping is unknown or ambiguous.",
          );
        if (head === null) blockers.push("The local HEAD revision could not be read.");
        if (changes !== "clean")
          blockers.push(
            changes === "dirty"
              ? "The checkout has uncommitted or untracked changes."
              : "The checkout's cleanliness could not be verified.",
          );
        const diff =
          base !== null && head !== null
            ? yield* readGit(["diff", "--quiet", base, head, "--"])
            : null;
        return {
          repoName,
          checkoutPath: row.checkoutPath,
          provider,
          host,
          repository,
          head,
          base,
          branch,
          sourceHost,
          sourceRepository,
          sourceBranch,
          changes,
          noChanges: changes === "clean" && head !== null && base !== null && diff === "",
          blockers,
        };
      }),
      { concurrency: 4 },
    );
    return {
      manifestRevision: digest({
        manifest: manifest.value,
        roots: rows.map((row) => row.checkoutPath),
        sources: repos.map((repo) => [repo.checkoutPath, repo.sourceHost, repo.sourceRepository]),
      }),
      repos,
    };
  });

  const requirement = (
    repo: LocalRepo,
    details: Partial<SagaWorkbenchRequirement> = {},
  ): SagaWorkbenchRequirement => ({
    key: localKey(repo),
    kind: "unknown",
    provider: repo.provider,
    repoName: repo.repoName,
    checkoutPath: repo.checkoutPath,
    host: repo.host,
    repository: repo.repository,
    number: null,
    url: null,
    ...emptyProvider,
    localHeadRevision: repo.head,
    baseRevision: repo.base,
    localChanges: repo.changes,
    localHeadMatches: null,
    blockers: repo.blockers,
    ...details,
  });

  const read: SagaWorkbenchEvidence["Service"]["read"] = Effect.fn("SagaWorkbenchEvidence.read")(
    function* (input) {
      const snapshot = yield* local(input.identity);
      let complete = true;
      const requirements = (yield* Effect.forEach(
        snapshot.repos,
        Effect.fn("SagaWorkbenchEvidence.requirements")(function* (repo) {
          const provider = repo.provider === null ? null : registry.get(repo.provider);
          const pinned =
            input.acceptedRequirements?.filter(
              (row) => row.checkoutPath === repo.checkoutPath && row.kind === "pull-request",
            ) ?? [];
          if (
            provider === null ||
            repo.host === null ||
            repo.repository === null ||
            repo.sourceHost === null ||
            repo.sourceRepository === null ||
            repo.blockers.some(
              (message) =>
                message.includes("manifest") ||
                message.includes("own Git") ||
                message.includes("source remote"),
            )
          ) {
            complete = false;
            return [
              requirement(repo, {
                blockers: [
                  ...repo.blockers,
                  "Pull request requirements cannot be enumerated for this checkout.",
                ],
              }),
            ];
          }
          const ref = { cwd: repo.checkoutPath, host: repo.host, repository: repo.repository };
          const candidates: Array<{ number: number; url: string }> = [];
          if (pinned.length > 0) {
            for (const approved of pinned) {
              if (
                approved.provider !== repo.provider ||
                approved.host !== repo.host ||
                approved.repository !== repo.repository ||
                approved.number === null ||
                approved.url === null
              ) {
                complete = false;
                return [
                  requirement(repo, {
                    blockers: [
                      ...repo.blockers,
                      "The approved repository identity no longer matches this checkout.",
                    ],
                  }),
                ];
              }
              candidates.push({ number: approved.number, url: approved.url });
            }
          }
          // Approved identities remain pinned even after branch movement, but a live branch
          // can acquire additional delivery PRs. Reconcile discovery with the approved set.
          if (repo.branch === null) {
            complete = false;
            return [
              requirement(repo, {
                blockers: [
                  ...repo.blockers,
                  "A detached or unreadable branch cannot enumerate pull request requirements.",
                ],
              }),
            ];
          }
          const branch = repo.sourceBranch ?? repo.branch;
          const listing = yield* (
            provider.listAcceptanceCandidates !== undefined
              ? provider.listAcceptanceCandidates({
                  ...ref,
                  branch,
                  headRevision: repo.head,
                  sourceHost: repo.sourceHost,
                  sourceRepository: repo.sourceRepository,
                })
              : provider
                  .listChangeRequests({
                    ...ref,
                    state: "all",
                    involvement: "all",
                    viewer: "",
                    limit: 100,
                  })
                  .pipe(
                    Effect.map((page) => ({
                      ...page,
                      items: page.items.filter(
                        (pr) => pr.headBranch === branch && pr.state !== "closed",
                      ),
                    })),
                  )
          ).pipe(Effect.option);
          if (Option.isNone(listing) || listing.value.truncated) {
            complete = false;
            return [
              requirement(repo, {
                blockers: [
                  ...repo.blockers,
                  "Pull request enumeration failed or exceeded the bounded result limit.",
                ],
              }),
            ];
          }
          for (const pr of listing.value.items) {
            if (!candidates.some((candidate) => candidate.number === pr.number))
              candidates.push({ number: pr.number, url: pr.url });
          }
          if (candidates.length === 0) {
            if (repo.noChanges && repo.blockers.length === 0) {
              return [
                requirement(repo, {
                  kind: "no-changes",
                  headRevision: repo.head,
                  localHeadMatches: true,
                  requiredChecks: "none",
                  checksRevision: repo.head,
                  blockers: [],
                }),
              ];
            }
            return [
              requirement(repo, {
                blockers: [
                  ...repo.blockers,
                  repo.base === null
                    ? "No resolved base revision is available to prove no delivery changes."
                    : "No pull request was found for the local changes.",
                ],
              }),
            ];
          }
          return yield* Effect.forEach(
            candidates,
            Effect.fn("SagaWorkbenchEvidence.pullRequest")(function* (candidate) {
              const facts =
                provider.readAcceptanceEvidence === undefined
                  ? null
                  : yield* provider
                      .readAcceptanceEvidence({ ...ref, number: candidate.number })
                      .pipe(Effect.orElseSucceed(() => null));
              const evidence = facts ?? {
                ...emptyProvider,
                blockers: [
                  "This provider cannot supply fresh, revision-bound acceptance evidence.",
                ],
              };
              const localHeadMatches =
                evidence.headRevision === null || repo.head === null
                  ? null
                  : evidence.headRevision === repo.head;
              return requirement(repo, {
                ...evidence,
                key: digest([
                  localKey(repo),
                  repo.provider,
                  repo.host,
                  repo.repository,
                  candidate.number,
                ]),
                kind: "pull-request",
                number: candidate.number,
                url: candidate.url,
                // The local manifest base proof is rechecked under the space lock. Provider base changes
                // remain represented by the check/source evidence rather than replacing that local proof.
                baseRevision: repo.base,
                localHeadMatches,
                blockers: [
                  ...repo.blockers,
                  ...evidence.blockers,
                  ...(localHeadMatches === true
                    ? []
                    : ["The local HEAD does not match the pull request source revision."]),
                  ...(evidence.merged === true
                    ? []
                    : ["The pull request has not been verified merged."]),
                ],
              });
            }),
            { concurrency: 4 },
          );
        }),
        { concurrency: 4 },
      )).flat();
      // An approved requirement cannot disappear after a manifest edit or path retarget.
      for (const approved of input.acceptedRequirements ?? []) {
        if (!requirements.some((row) => row.key === approved.key)) {
          complete = false;
          requirements.push({
            ...approved,
            kind: "unknown",
            requiredChecks: "unknown",
            localHeadMatches: null,
            blockers: [
              "This previously approved requirement is no longer present in the current manifest evidence.",
            ],
          });
        }
      }
      const blockers = requirements.flatMap((row) =>
        row.blockers.map((message) => `${row.repoName}: ${message}`),
      );
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      return {
        sourceRevision: digest({
          manifestRevision: snapshot.manifestRevision,
          requirements,
          complete,
        }),
        manifestRevision: snapshot.manifestRevision,
        observedAt,
        requirements,
        complete,
        blockers,
      };
    },
  );
  const revalidate: SagaWorkbenchEvidence["Service"]["revalidate"] = Effect.fn(
    "SagaWorkbenchEvidence.revalidate",
  )(function* (input) {
    const current = yield* local(input.identity);
    if (current.manifestRevision !== input.evidence.manifestRevision)
      return yield* error(
        "The repository manifest changed during evidence collection.",
        "conflict",
      );
    for (const row of input.evidence.requirements) {
      const repo = current.repos.find((candidate) => candidate.checkoutPath === row.checkoutPath);
      if (
        repo === undefined ||
        repo.head !== row.localHeadRevision ||
        (repo.base !== row.baseRevision &&
          !(input.allowPullRequestBaseAdvance === true && row.kind === "pull-request")) ||
        repo.changes !== row.localChanges ||
        repo.provider !== row.provider ||
        repo.host !== row.host ||
        repo.repository !== row.repository ||
        (row.kind === "no-changes" && !repo.noChanges)
      ) {
        return yield* error(
          "Local repository evidence changed during the operation. Refresh and try again.",
          "conflict",
        );
      }
    }
  });
  return SagaWorkbenchEvidence.of({ read, revalidate });
});
export const layer = SagaWorkbenchEvidence.layer;
