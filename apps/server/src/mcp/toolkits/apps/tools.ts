import { AppStatus, OrchestratorMcpFailure, ProjectId } from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * What an agent needs to tell apps apart and find their projects. Icons,
 * launch commands and pairing secrets stay out: they cost context and grant
 * nothing an agent can act on.
 */
export const McpConnectedApp = Schema.Struct({
  appId: AppStatus.fields.appId,
  name: AppStatus.fields.name,
  toolPrefix: AppStatus.fields.toolPrefix,
  state: AppStatus.fields.state,
  live: Schema.Boolean,
  pairingPending: Schema.Boolean,
  runtimeCeiling: AppStatus.fields.runtimeCeiling,
  lastSeenAt: AppStatus.fields.lastSeenAt,
  projects: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      title: Schema.String,
      workspaceRoot: Schema.String,
    }),
  ),
});
export type McpConnectedApp = typeof McpConnectedApp.Type;

const AppsListTool = Tool.make("lecturn_apps_list", {
  description:
    "List the apps connected to this environment (such as a CAD or simulation app that embeds Lecturn), with their grant state, whether their live tools are reachable now, and the projects each app owns. Tools named with an app's toolPrefix belong to that app. A thread in an app's project sees only that app.",
  success: Schema.Struct({ apps: Schema.Array(McpConnectedApp) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, ProjectService.ProjectService],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AppsToolkit = Toolkit.make(AppsListTool);
