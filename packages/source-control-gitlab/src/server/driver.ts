import { SourceControlProviderKind } from "@lecturn/contracts";
/**
 * The GitLab driver: repository operations, discovery, and merge requests through `glab`.
 *
 * @module source-control-gitlab/server/driver
 */
import { defineSourceControlDriver } from "@lecturn/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as GitLabPullRequestProvider from "./GitLabPullRequestProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("gitlab"),
  make: Effect.all({
    sourceControl: GitLabSourceControlProvider.make,
    discovery: Effect.succeed(GitLabSourceControlProvider.discovery),
    pullRequests: GitLabPullRequestProvider.make,
  }),
});
