import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import {
  buildProjectGroups,
  buildSagaProjectTree,
  type SagaProjectIndexEntry,
} from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { SidebarProjectGroupingMode } from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";

/** Project navigation alongside the tablet's flat thread list. */
export function SagaSidebarRoster(props: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly index: ReadonlyArray<SagaProjectIndexEntry>;
  readonly groupingMode: SidebarProjectGroupingMode;
  readonly onNewThread: (project: EnvironmentProject) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const tree = useMemo(
    () =>
      buildSagaProjectTree(
        buildProjectGroups({
          projects: props.projects,
          settings: {
            sidebarProjectGroupingMode: props.groupingMode,
            sidebarProjectGroupingOverrides: {},
          },
        }),
        props.index,
      ).filter((node) =>
        node.group.members.some(
          ({ project }) =>
            project.stave?.isSaga &&
            props.index.some(
              (entry) =>
                entry.environmentId === project.environmentId &&
                entry.sagaRoot === project.workspaceRoot,
            ),
        ),
      ),
    [props.projects, props.groupingMode, props.index],
  );
  if (tree.length === 0) return null;
  const open = (project: EnvironmentProject) => {
    const thread = props.threads.find(
      (thread) =>
        thread.environmentId === project.environmentId &&
        thread.projectId === project.id &&
        thread.archivedAt === null,
    );
    if (thread) props.onSelectThread(thread);
    else if (project.stave?.state !== "archived") props.onNewThread(project);
  };
  return (
    <View className="gap-1 px-3 pb-3">
      <Text className="py-2 text-xs font-t3-bold text-foreground-muted">Sagas</Text>
      {tree.map((node) => (
        <View key={node.group.key}>
          <View className="flex-row items-center">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${node.group.label} members`}
              accessibilityState={{ expanded: !collapsed.has(node.group.key) }}
              className="p-2"
              onPress={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(node.group.key)) next.delete(node.group.key);
                  else next.add(node.group.key);
                  return next;
                })
              }
            >
              <Text className="text-foreground-muted">
                {collapsed.has(node.group.key) ? "▸" : "▾"}
              </Text>
            </Pressable>
            <Pressable
              className="flex-1 py-2"
              accessibilityRole="button"
              onPress={() => open(node.group.representative)}
            >
              <Text className="text-sm font-t3-bold text-foreground">{node.group.label}</Text>
            </Pressable>
          </View>
          {!collapsed.has(node.group.key)
            ? node.children.map((child) => (
                <Pressable
                  key={child.group.key}
                  className="gap-1 py-2 pl-8"
                  accessibilityRole="button"
                  onPress={() => open(child.group.representative)}
                >
                  <Text className="text-sm text-foreground">{child.group.label}</Text>
                  <Text className="text-xs text-foreground-muted">
                    {child.memberStatus?.state}
                    {child.memberStatus?.dirty ? " · dirty" : ""}
                    {child.memberStatus?.state === "live" &&
                    child.memberStatus.repos.length > 0 &&
                    child.memberStatus.repos.every((repo) => repo.baseHealth === "merged")
                      ? " · merged"
                      : ""}
                  </Text>
                </Pressable>
              ))
            : null}
        </View>
      ))}
    </View>
  );
}
