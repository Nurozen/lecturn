import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { detectSourceControlProviderFromRemoteUrl } from "@lecturn/shared/sourceControl";
import { StaveWorkspaceReader } from "../stave/StaveWorkspaceReader.ts";
import { sameManifestIncarnation } from "../stave/staveIncarnation.ts";
import { SourceControlRateLimit } from "../sourceControl/SourceControlRateLimit.ts";
import { stableStringify } from "@lecturn/shared/relaySigning";
import {
  PullRequestWatchError,
  SourceControlProviderKind,
  pullRequestHostOf,
  type PullRequestRef,
  type PullRequestWatchObservation,
} from "@lecturn/contracts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import { Context, DateTime, Effect, Layer, Option, Path, Schema } from "effect";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PullRequestProviderRegistry } from "./PullRequestProviderRegistry.ts";
import {
  projectRepositories,
  resolveProjectRepositories,
  repositorySelector,
  pullRequestRepositoryBinding,
  withRateLimitBackoff,
  PullRequestService,
} from "./PullRequestService.ts";
import type { ProviderAcceptanceEvidence } from "./PullRequestProvider.ts";

const isWatchError = Schema.is(PullRequestWatchError);
const isProviderKind = Schema.is(SourceControlProviderKind);
const unavailable = (cause: unknown) =>
  isWatchError(cause)
    ? cause
    : new PullRequestWatchError({
        code: "unavailable",
        message: "Could not read current pull request state. Check repository access and retry.",
      });
export class PullRequestWatchProvider extends Context.Service<
  PullRequestWatchProvider,
  {
    readonly observe: (
      reference: PullRequestRef,
    ) => Effect.Effect<
      { reference: PullRequestRef; binding: string; observation: PullRequestWatchObservation },
      PullRequestWatchError
    >;
    readonly runAction: (
      input: Parameters<PullRequestService["Service"]["runAction"]>[0] & {
        expectedBinding?: string;
        expectedBaseBranch?: string;
      },
    ) => Effect.Effect<void, PullRequestWatchError>;
  }
>()("lecturn/pullRequest/PullRequestWatchProvider") {}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery;
  const registry = yield* PullRequestProviderRegistry;
  const path = yield* Path.Path;
  const vcs = yield* Effect.serviceOption(VcsDriverRegistry);
  const requests = yield* PullRequestService;
  const reader = yield* StaveWorkspaceReader;
  const limits = yield* SourceControlRateLimit;
  const sourceProviders = yield* Effect.serviceOption(SourceControlProviderRegistry);
  const kindOf = (identity: Parameters<typeof repositorySelector>[0]) =>
    identity && isProviderKind(identity.provider) && identity.provider !== "unknown"
      ? identity.provider
      : identity
        ? (detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl)?.kind ?? "unknown")
        : "unknown";
  const observe = Effect.fn("PullRequestWatchProvider.observe")(function* (
    reference: PullRequestRef,
  ) {
    const projectOption = yield* projections.getProjectShellById(reference.projectId);
    if (Option.isNone(projectOption))
      return yield* new PullRequestWatchError({
        code: "not-found",
        message: "The project is no longer available.",
      });
    let project = projectOption.value;
    if (project.stave) {
      yield* reader.invalidate(project.workspaceRoot);
      const current = yield* reader.load(project.workspaceRoot);
      if (
        Option.isNone(current) ||
        current.value.spaceId !== project.stave.spaceId ||
        !current.value.createdAt ||
        !project.stave.createdAt ||
        !sameManifestIncarnation(current.value.createdAt, project.stave.createdAt)
      ) {
        return yield* new PullRequestWatchError({
          code: "conflict",
          message:
            "The Stave space is unavailable or its incarnation changed. Re-import it before tracking pull requests.",
        });
      }
      const currentProject = { ...project, stave: current.value };
      const targetIdentity = (value: typeof project) =>
        projectRepositories(value, path)
          .map(({ cwd, identity }) => stableStringify([cwd, identity.canonicalKey]))
          .sort();
      if (
        stableStringify(targetIdentity(project)) !== stableStringify(targetIdentity(currentProject))
      ) {
        return yield* new PullRequestWatchError({
          code: "conflict",
          message:
            "The Stave repository list changed. Refresh the project before managing pull requests.",
        });
      }
      project = currentProject;
    }
    const matches = (yield* resolveProjectRepositories(project, path, vcs, true)).filter(
      ({ identity }) =>
        repositorySelector(identity)?.toLowerCase() === reference.repository.toLowerCase() &&
        (reference.host === undefined ||
          pullRequestHostOf(identity, kindOf(identity)).toLowerCase() ===
            reference.host.toLowerCase()),
    );
    const keys = new Set(
      matches.map(({ identity }) =>
        stableStringify([
          pullRequestHostOf(identity, kindOf(identity)),
          repositorySelector(identity)?.toLowerCase(),
        ]),
      ),
    );
    const target = matches[0];
    if (!target || keys.size !== 1)
      return yield* new PullRequestWatchError({
        code: "invalid",
        message: "Select an editable repository belonging to this project and host.",
      });
    let kind = kindOf(target.identity);
    if (kind === "unknown" && Option.isSome(sourceProviders)) {
      const detected = detectSourceControlProviderFromRemoteUrl(target.identity.locator.remoteUrl);
      const handle = yield* sourceProviders.value
        .resolveHandle({
          cwd: target.cwd,
          ...(detected
            ? {
                context: {
                  provider: detected,
                  remoteName: target.identity.locator.remoteName,
                  remoteUrl: target.identity.locator.remoteUrl,
                },
              }
            : {}),
        })
        .pipe(Effect.orElseSucceed(() => null));
      kind = handle?.context?.provider.kind ?? "unknown";
    }
    const rawApi = registry.get(kind);
    if (!rawApi)
      return yield* new PullRequestWatchError({
        code: "unavailable",
        message: "Pull request tracking is not supported for this repository provider.",
      });
    const host = pullRequestHostOf(target.identity, rawApi.kind);
    const api = withRateLimitBackoff(rawApi, host, limits);
    const repository = repositorySelector(target.identity)!;
    const ref = { cwd: target.cwd, host, repository, number: reference.number };
    const detail = yield* api.getChangeRequest(ref);
    const unknown: ProviderAcceptanceEvidence = {
      headRevision: null,
      baseRevision: null,
      requiredChecks: "unknown",
      checksRevision: null,
      merged: null,
      mergedSourceRevision: null,
      blockers: [],
    };
    const evidence = api.readAcceptanceEvidence
      ? yield* api.readAcceptanceEvidence(ref).pipe(Effect.orElseSucceed(() => unknown))
      : unknown;
    const checksState =
      detail.checksState ??
      (detail.checks.length === 0
        ? "none"
        : detail.checks.some((c) => ["failure", "cancelled", "action-required"].includes(c.status))
          ? "failing"
          : detail.checks.some((c) => c.status === "pending")
            ? "pending"
            : "passing");
    return {
      reference: { projectId: project.id, host, repository, number: reference.number },
      binding: pullRequestRepositoryBinding(project, target.cwd, target.identity.canonicalKey),
      observation: {
        provider: api.kind,
        title: detail.title,
        url: detail.url,
        state: detail.state,
        headRevision: evidence.headRevision,
        baseBranch: detail.baseBranch,
        reviewDecision: detail.reviewDecision ?? null,
        checks: [...detail.checks],
        checksState,
        requiredChecks: evidence.requiredChecks,
        checksRevision: evidence.checksRevision,
        mergeable:
          !detail.isDraft &&
          detail.mergeability === "mergeable" &&
          detail.viewerPermissions.actions.includes("merge"),
        autoMergeEnabled: detail.autoMergeEnabled ?? null,
        supportsAutoMerge:
          api.capabilities.actions.includes("enable-auto-merge") &&
          detail.viewerPermissions.actions.includes("enable-auto-merge"),
        supportsRevisionMerge: api.kind === "github" && api.readAcceptanceEvidence !== undefined,
        observedAt: DateTime.formatIso(yield* DateTime.now),
      } satisfies PullRequestWatchObservation,
    };
  }, Effect.mapError(unavailable));
  return PullRequestWatchProvider.of({
    observe,
    runAction: Effect.fn("PullRequestWatchProvider.runAction")(function* (input) {
      const fresh = yield* observe(input);
      if (
        (input.expectedBinding !== undefined && fresh.binding !== input.expectedBinding) ||
        (input.expectedBaseBranch !== undefined &&
          fresh.observation.baseBranch !== input.expectedBaseBranch)
      ) {
        return yield* new PullRequestWatchError({
          code: "conflict",
          message: "The repository or target branch changed before the action could run.",
        });
      }
      yield* requests.runAction(input, { expectedBinding: fresh.binding });
    }, Effect.mapError(unavailable)),
  });
});
export const layer = Layer.effect(PullRequestWatchProvider, make);
