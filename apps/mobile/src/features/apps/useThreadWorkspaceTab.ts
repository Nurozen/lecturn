import { EnvironmentId, ThreadId } from "@lecturn/contracts";

import { useProject, useThreadShell } from "../../state/entities";
import type { WorkspaceTab } from "../workspace/workspace-tabs-state";

/** The list a thread belongs to, so Android's back returns to Apps for an app's thread. */
export function useThreadWorkspaceTab(params: {
  readonly environmentId?: string;
  readonly threadId?: string;
}): WorkspaceTab {
  const environmentId = params.environmentId ? EnvironmentId.make(params.environmentId) : null;
  const thread = useThreadShell(
    environmentId !== null && params.threadId
      ? { environmentId, threadId: ThreadId.make(params.threadId) }
      : null,
  );
  const project = useProject(
    thread === null ? null : { environmentId: thread.environmentId, projectId: thread.projectId },
  );
  return project?.appBinding === undefined ? "threads" : "apps";
}
