import { resolveFilesystemReadAccess } from "@lecturn/client-runtime/state/filesystem";
import { staveForcedEnvMode } from "@lecturn/client-runtime/state/projectGit";
import { isScratchProject } from "@lecturn/client-runtime/state/projects";
import type { EnvironmentProject } from "@lecturn/client-runtime/state/shell";
import type { ProjectReadFileResult } from "@lecturn/contracts";
import { DEFAULT_SERVER_SETTINGS, LECTURN_PROJECT_FILE_NAME } from "@lecturn/contracts";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@lecturn/shared/projectSettings";
import { parseLecturnProjectFile } from "@lecturn/shared/lecturnProjectFile";

import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useProjectHasThreads } from "../../state/project-has-threads";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";

/**
 * A project's new-task defaults: server settings merged with its lecturn.json. The
 * new-task flow and the home pending-drafts list both read the default
 * workspace mode here, so a draft that never picked one shows what it sends.
 * Every read is a shared per-environment or per-project atom.
 */
export function useNewTaskProjectDefaults(project: EnvironmentProject | null) {
  const serverConfig = useEnvironmentServerConfig(project?.environmentId ?? null);
  const isScratch =
    project !== null && isScratchProject(project, serverConfig?.scratchWorkspaceRoot);
  const hasWorkspace = project !== null && project.workspaceRoot !== "";
  // A Stave space always runs locally in its root; that outranks every settings tier and the file.
  const forcedWorkspaceMode = staveForcedEnvMode(project);
  const fileAccessSession = useEnvironmentQuery(
    hasWorkspace ? environmentSession.sessionStateAtom(project.environmentId) : null,
  );
  const fileEnvironment = useEnvironmentPresentation(project?.environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const fileAccessPending = hasWorkspace && fileAccess.isPending;
  const lecturnProjectFileQuery = useEnvironmentQuery(
    fileAccess.canReadFiles && hasWorkspace && forcedWorkspaceMode === undefined
      ? projectEnvironment.readFile({
          environmentId: project.environmentId,
          input: {
            cwd: project.workspaceRoot,
            relativePath: LECTURN_PROJECT_FILE_NAME,
            allowMissing: true,
          },
        })
      : null,
  );
  const lecturnProjectFileData = lecturnProjectFileQuery.data as ProjectReadFileResult | null;
  const lecturnProjectFile =
    lecturnProjectFileData === null ||
    lecturnProjectFileData.exists === false ||
    lecturnProjectFileData.truncated
      ? null
      : parseLecturnProjectFile(lecturnProjectFileData.contents);
  const projectSettings = resolveProjectSettings(
    serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    project?.id ?? null,
    project,
    lecturnProjectFile,
  );
  const projectHasThreads = useProjectHasThreads(project);
  const defaultWorkspaceMode =
    forcedWorkspaceMode ??
    (isScratch
      ? "local"
      : resolveNewThreadEnvMode({
          projectSettings,
          workspaceRoot: project?.workspaceRoot ?? null,
          newProjectsRoot: serverConfig?.newProjectsRoot,
          projectHasThreads,
        }));
  // While lecturn.json loads, the environment default is provisional; lecturn.json may replace it.
  const defaultWorkspaceModeSettled =
    forcedWorkspaceMode !== undefined ||
    projectSettings.sources.defaultThreadEnvMode !== "environment" ||
    (!lecturnProjectFileQuery.isPending && !fileAccessPending);
  return {
    serverConfig,
    isScratch,
    projectSettings,
    defaultWorkspaceMode,
    defaultWorkspaceModeSettled,
    forcedWorkspaceMode,
  };
}
