import { useAtomValue } from "@effect/atom-react";
import type { AppId, EnvironmentId } from "@lecturn/contracts";
import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { View, type ScrollViewProps } from "react-native";

import { ArcaneBackdrop } from "../../components/ArcaneBackdrop";
import { AppText } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAppStatusesByEnvironment } from "../../state/apps";
import { useAppProjects, useAppThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { threadListEnvironmentsAtom } from "../../state/server";
import { HierarchyRow } from "../home/HierarchyRow";
import { useHomeThreadSelection } from "../home/home-thread-navigation";
import {
  DEFAULT_GROUP_DISPLAY_STATE,
  nextGroupDisplayState,
  type HomeGroupDisplayAction,
  type HomeGroupDisplayState,
} from "../home/homeListItems";
import { buildSidebarHierarchy } from "../threads/sidebar-hierarchy";
import { ThreadListGroupHeader } from "../threads/thread-list-items";
import { ThreadListV2SettledShelfHeader } from "../threads/thread-list-v2-items";
import { useThreadRowProviderInstanceResolver } from "../threads/thread-provider-instance";
import { openConnectedApp } from "./AppClosedBanner";
import { AppCardHeader } from "./AppCardHeader";
import { AppDetailSheet } from "./AppDetailSheet";
import { AppPairingRow } from "./AppPairingRow";
import { AppThreadRow } from "./AppThreadRow";
import {
  appCardCollapseKey,
  appCardFrames,
  appCardTargetWorkspace,
  appOpenUrl,
  appScreenTitle,
  buildAppCards,
  buildAppsTabItems,
  type AppCard,
  type AppSectionLabel,
  type AppsTabItem,
} from "./apps-tab-state";

// Whole points keep the connector, drawn at its middle, on the pixel grid.
const SECTION_LABEL_HEIGHT = 32;

function AppThreadSectionLabel(props: { readonly label: AppSectionLabel }) {
  return (
    <View className="justify-center px-[14px]" style={{ height: SECTION_LABEL_HEIGHT }}>
      <AppText
        accessibilityRole="header"
        className="text-sm text-foreground-secondary"
        numberOfLines={1}
      >
        {props.label}
      </AppText>
    </View>
  );
}

function useMinuteClock(): string {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date().toISOString()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Connected apps as boxed trees: each app's header, its pairing requests, and its workspaces
 * with Pinned and Active threads and a folded Settled shelf. `appId` narrows it to one app.
 */
export function AppsTree(props: {
  readonly appId?: AppId;
  readonly searchQuery: string;
  readonly contentBottomInset: number;
  readonly renderScrollComponent?: (props: ScrollViewProps) => ReactElement<ScrollViewProps>;
  readonly contentTopInset?: number;
  readonly onScrollOffset?: (offset: number) => void;
}) {
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const statuses = useAppStatusesByEnvironment(environments);
  const projects = useAppProjects();
  const threads = useAppThreadShells();
  const environmentLabels = useMemo(
    () =>
      new Map<EnvironmentId, string>(
        environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [environments],
  );
  const cards = useMemo(() => {
    const all = buildAppCards({ statuses, projects, threads, environmentLabels });
    return props.appId === undefined ? all : all.filter((card) => card.appId === props.appId);
  }, [statuses, projects, threads, environmentLabels, props.appId]);
  const [displayStates, setDisplayStates] = useState<ReadonlyMap<string, HomeGroupDisplayState>>(
    () => new Map(),
  );
  const now = useMinuteClock();
  const items = useMemo(
    () =>
      buildAppsTabItems({
        cards,
        displayStates,
        searchQuery: props.searchQuery,
        now,
        environmentLabels,
      }),
    [cards, displayStates, props.searchQuery, now, environmentLabels],
  );
  const guides = useMemo(() => buildSidebarHierarchy(items), [items]);
  const frames = useMemo(() => appCardFrames(items), [items]);
  const { providersByEnvironmentId } = useAtomValue(threadListEnvironmentsAtom);
  const resolveProviderInstance = useThreadRowProviderInstanceResolver(providersByEnvironmentId);
  const selectThread = useHomeThreadSelection();
  const [detailAppId, setDetailAppId] = useState<AppId | null>(null);
  const detailCard = cards.find((card) => card.appId === detailAppId) ?? null;

  const setCollapsed = useCallback((key: string, collapsed: boolean) => {
    setDisplayStates((previous) => {
      const next = new Map(previous);
      next.set(key, { collapsed, visibleCount: previous.get(key)?.visibleCount ?? 0 });
      return next;
    });
  }, []);
  const updateWorkspaceDisplay = useCallback((key: string, action: HomeGroupDisplayAction) => {
    setDisplayStates((previous) => {
      const next = new Map(previous);
      next.set(
        key,
        nextGroupDisplayState(previous.get(key) ?? DEFAULT_GROUP_DISPLAY_STATE, action),
      );
      return next;
    });
  }, []);

  const newThread = useCallback(
    (card: AppCard) => {
      const project = appCardTargetWorkspace(card);
      if (project === null) return null;
      return () =>
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: {
            environmentId: String(project.environmentId),
            projectId: String(project.id),
            title: project.title,
          },
        });
    },
    [navigation],
  );
  const openInApp = useCallback((card: AppCard) => {
    const project = appCardTargetWorkspace(card);
    const url = appOpenUrl({
      template: card.primary?.app.openUrlTemplate ?? null,
      binding: project?.appBinding,
      threadId: null,
    });
    if (url === null) return null;
    return () => void openConnectedApp({ url, appName: card.name });
  }, []);

  const renderRow = (item: AppsTabItem) => {
    switch (item.type) {
      case "app-card-header":
        return (
          <AppCardHeader
            item={item}
            onToggle={() => setCollapsed(appCardCollapseKey(item.card.appId), !item.collapsed)}
            onOpenDetails={() => setDetailAppId(item.card.appId)}
            onNewThread={newThread(item.card)}
            onOpenInApp={openInApp(item.card)}
          />
        );
      case "app-pairing":
        return <AppPairingRow item={item} />;
      case "app-workspace-header":
        return (
          <ThreadListGroupHeader
            variant="compact"
            project={item.project}
            title={
              item.machineLabel
                ? `${item.project.title} · ${item.machineLabel}`
                : item.project.title
            }
            threadCount={item.threadCount}
            collapsed={item.collapsed}
            isFirst={item.isFirst}
            groupKey={item.groupKey}
            onGroupAction={updateWorkspaceDisplay}
          />
        );
      case "app-thread":
        return (
          <>
            {item.sectionLabel !== null ? (
              <AppThreadSectionLabel label={item.sectionLabel} />
            ) : null}
            <AppThreadRow
              thread={item.thread}
              providerInstance={resolveProviderInstance(item.thread)}
              onSelectThread={selectThread}
            />
          </>
        );
      case "app-settled-shelf":
        return (
          <ThreadListV2SettledShelfHeader
            count={item.count}
            expanded={item.expanded}
            onToggle={() => setCollapsed(item.key, item.expanded)}
          />
        );
      case "app-empty":
        return (
          <AppText className="px-[14px] py-3 text-sm text-foreground-muted">{item.message}</AppText>
        );
    }
  };

  return (
    <>
      <LegendList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) =>
          item.type === "app-thread" && item.sectionLabel !== null
            ? "app-thread-labelled"
            : item.type
        }
        estimatedItemSize={64}
        drawDistance={1_000}
        recycleItems
        alwaysBounceVertical
        renderScrollComponent={props.renderScrollComponent}
        contentInsetAdjustmentBehavior={props.contentTopInset === undefined ? "automatic" : "never"}
        contentInset={
          props.contentTopInset === undefined ? undefined : { top: props.contentTopInset }
        }
        contentInsetStartAdjustment={props.contentTopInset ?? 0}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: props.contentBottomInset }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScroll={
          props.onScrollOffset === undefined
            ? undefined
            : (event) =>
                props.onScrollOffset?.(
                  Math.max(0, event.nativeEvent.contentOffset.y + (props.contentTopInset ?? 0)),
                )
        }
        renderItem={({ item }) => (
          <HierarchyRow
            depth={item.depth}
            settled={false}
            frame={frames.get(item.key)}
            guides={guides.get(item.key)}
            connector={
              item.type === "app-thread" ? item.sectionLabel !== null : item.type !== "app-empty"
            }
            connectorTop={
              item.type === "app-thread" && item.sectionLabel !== null
                ? SECTION_LABEL_HEIGHT / 2
                : undefined
            }
          >
            {renderRow(item)}
          </HierarchyRow>
        )}
        ListEmptyComponent={
          <View className="px-8 py-12">
            <EmptyState
              title={props.searchQuery.trim() ? "No results" : "No connected apps"}
              detail={
                props.searchQuery.trim()
                  ? "No app or app thread matches your search."
                  : "Apps you connect to this environment appear here with their threads."
              }
              variant="plain"
            />
          </View>
        }
      />
      {detailCard !== null ? (
        <AppDetailSheet
          card={detailCard}
          environmentLabels={environmentLabels}
          onClose={() => setDetailAppId(null)}
        />
      ) : null}
    </>
  );
}

/** One app's workspaces and threads, the target of `lecturn://apps/<appId>`. */
export function AppThreadsScreen(props: { readonly appId: AppId }) {
  const { environments } = useEnvironments();
  const statuses = useAppStatusesByEnvironment(environments);
  const title = appScreenTitle(statuses, props.appId) ?? "";
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title }} />
      <ArcaneBackdrop />
      <AppsTree appId={props.appId} searchQuery="" contentBottomInset={24} />
    </View>
  );
}
