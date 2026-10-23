import { SourceControlProviderKind } from "@lecturn/contracts";
import { defineSourceControlDriver } from "@lecturn/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as GitCafePullRequestProvider from "./GitCafePullRequestProvider.ts";
import * as GitCafeSourceControlProvider from "./GitCafeSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("gitcafe"),
  make: Effect.all({
    sourceControl: GitCafeSourceControlProvider.make,
    discovery: GitCafeSourceControlProvider.makeDiscovery,
    pullRequests: GitCafePullRequestProvider.make,
  }),
});
