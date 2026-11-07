import * as AzureDevOpsDriver from "@lecturn/source-control-azure-devops/server/driver";
import * as BitbucketDriver from "@lecturn/source-control-bitbucket/server/driver";
import { builtInSourceControlDefinitions } from "@lecturn/source-control-definitions/registry";
import * as ForgejoDriver from "@lecturn/source-control-forgejo/server/driver";
import * as GitCafeDriver from "@lecturn/source-control-gitcafe/server/driver";
import * as GitHubDriver from "@lecturn/source-control-github/server/driver";
import * as GitLabDriver from "@lecturn/source-control-gitlab/server/driver";

/** In the shared registry's order, which is the order hosts are listed and probed in. */
export const BUILT_IN_SOURCE_CONTROL_DRIVER_LIST = [
  GitHubDriver.driver,
  GitLabDriver.driver,
  GitCafeDriver.driver,
  ForgejoDriver.driver,
  BitbucketDriver.driver,
  AzureDevOpsDriver.driver,
] as const;

export const sourceControlDefinitions = builtInSourceControlDefinitions;
