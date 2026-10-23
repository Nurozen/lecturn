import { useAtomValue } from "@effect/atom-react";
import { type SagaProjectIndexEntry } from "@lecturn/client-runtime/state/project-grouping";
import { buildPhysicalSagaProjectTree } from "@lecturn/client-runtime/state/sagaWorkbench";
import {
  environmentSupportsStave,
  staveFeatureAvailable,
} from "@lecturn/client-runtime/state/stave";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { useEffect } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  deriveSidebarEnvironmentMetadata,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  isDesktopLocalConnectionTarget,
  isWslConnectionTarget,
} from "../../connection/desktopLocal";
import { staveSagaStatus, staveStatus } from "../../state/stave";
import { serverEnvironment } from "../../state/server";
import { subscribeStaveMutation } from "../../staveMutation";

export function useSagaSidebarTree(projects: readonly SidebarProjectSnapshot[]) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const desktopLocalEnvironmentIds = new Set(
    environments
      .filter((environment) => isDesktopLocalConnectionTarget(environment.entry.target))
      .map((environment) => environment.environmentId),
  );
  const wslEnvironmentIds = new Set(
    environments
      .filter((environment) => isWslConnectionTarget(environment.entry.target))
      .map((environment) => environment.environmentId),
  );
  const nest = useClientSettings((settings) => settings.sidebarNestSagas);
  const targets = projects.flatMap((group) =>
    group.memberProjects.filter(
      (member) => member.stave?.isSaga && member.stave.state !== "archived",
    ),
  );
  const indexAtom = Atom.make((get) => {
    const index: SagaProjectIndexEntry[] = [];
    const enabledKeys = new Set<string>();
    const availableKeys = new Set<string>();
    if (!nest) return { index, enabledKeys, availableKeys };
    for (const target of targets) {
      const config = get(serverEnvironment.configValueAtom(target.environmentId));
      if (!environmentSupportsStave(config) || !config?.settings.stave.enabled) continue;
      enabledKeys.add(target.physicalProjectKey);
      const probe = Option.getOrNull(
        AsyncResult.value(get(staveStatus({ environmentId: target.environmentId, input: {} }))),
      );
      if (!staveFeatureAvailable({ config, settings: config.settings, status: probe })) continue;
      availableKeys.add(target.physicalProjectKey);
      const status = Option.getOrNull(
        AsyncResult.value(
          get(
            staveSagaStatus({
              environmentId: target.environmentId,
              input: { sagaRoot: target.workspaceRoot },
            }),
          ),
        ),
      );
      if (status)
        index.push({
          environmentId: target.environmentId,
          sagaRoot: target.workspaceRoot,
          status,
        });
    }
    return { index, enabledKeys, availableKeys };
  });
  const { index, enabledKeys, availableKeys } = useAtomValue(indexAtom);
  useEffect(
    () =>
      subscribeStaveMutation((environmentId) => {
        if (!nest) return;
        for (const target of targets)
          if (
            target.environmentId === environmentId &&
            enabledKeys.has(target.physicalProjectKey)
          ) {
            appAtomRegistry.refresh(
              staveSagaStatus({ environmentId, input: { sagaRoot: target.workspaceRoot } }),
            );
          }
      }),
    [nest, targets, enabledKeys],
  );
  useEffect(() => {
    if (!nest || enabledKeys.size === 0) return;
    const timer = setInterval(() => {
      for (const target of targets) {
        if (!enabledKeys.has(target.physicalProjectKey)) continue;
        appAtomRegistry.refresh(staveStatus({ environmentId: target.environmentId, input: {} }));
        if (availableKeys.has(target.physicalProjectKey))
          appAtomRegistry.refresh(
            staveSagaStatus({
              environmentId: target.environmentId,
              input: { sagaRoot: target.workspaceRoot },
            }),
          );
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [nest, targets, enabledKeys, availableKeys]);
  const tree = buildPhysicalSagaProjectTree(
    projects.map((project) => ({
      key: project.projectKey,
      label: project.displayName,
      representative:
        project.memberProjects.find(
          (member) => member.id === project.id && member.environmentId === project.environmentId,
        ) ?? project.memberProjects[0]!,
      members: project.memberProjects.map((member) => ({
        physicalProjectKey: member.physicalProjectKey,
        project: member,
      })),
      memberProjectRefs: project.memberProjectRefs,
    })),
    nest ? index : [],
  );
  const navigationProjects = tree
    .flatMap((node) => [node, ...node.children])
    .map((node): SidebarProjectSnapshot => {
      const original = projects.find((project) =>
        project.memberProjects.some((member) =>
          node.group.members.some((item) => item.physicalProjectKey === member.physicalProjectKey),
        ),
      )!;
      const members = node.group.members.map((member) => member.project);
      return {
        ...original,
        ...node.group.representative,
        projectKey: node.group.key,
        settingsProjectKey: original.projectKey,
        displayName: node.group.label,
        groupedProjectCount: members.length,
        ...deriveSidebarEnvironmentMetadata({
          members,
          primaryEnvironmentId,
          isDesktopLocalEnvironment: (environmentId) =>
            desktopLocalEnvironmentIds.has(environmentId),
          isWslEnvironment: (environmentId) => wslEnvironmentIds.has(environmentId),
        }),
        memberProjects: members,
        memberProjectRefs: node.group.memberProjectRefs,
      };
    });
  return { tree, navigationProjects, enabledKeys, availableKeys, nest };
}
