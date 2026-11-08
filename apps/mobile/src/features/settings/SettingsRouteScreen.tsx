import {
  navigationCustomizationAvailable,
  overflowNavigationTabs,
} from "../workspace/navigation-tab-order";
import {
  NAVIGATION_TAB_ICONS,
  WORKSPACE_TAB_LABELS,
  useNavigationTabOrder,
  useHiddenNavigationTabs,
} from "../workspace/navigation-tabs";
import { currentWorkspaceSelections } from "../workspace/workspace-selection-store";
import { rememberedSettingsPage } from "../workspace/workspace-tab-navigation";
import { useSelectWorkspaceTab } from "../workspace/useSelectWorkspaceTab";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import {
  ScreenScrollView as ScrollView,
  ScreenScrollViewBottomInset,
} from "../../components/ui/ScreenScrollView";
import { ArcaneBackdrop } from "../../components/ArcaneBackdrop";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { useNavigation, useNavigationState, type NavigationProp } from "@react-navigation/native";
import { Fragment, use, useMemo, type ComponentProps, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { useWorkspaceSurface } from "../workspace/useWorkspaceSurface";
import { useDeviceType } from "../../native/native-layout-metrics";
import { useCompactWorkspaceTabs } from "../workspace/useSystemWorkspaceTabBar";
import { deriveProjectGroupLabel } from "@lecturn/client-runtime/state/project-grouping";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { TeamSelector } from "../cloud/TeamSelector";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { ContextualButton } from "../contextual/ContextualControls";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useEnvironments } from "../../state/environments";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { ConnectAccountsSettings } from "./ConnectAccountsSettings";
import { ConnectBillingStatus } from "./components/ConnectBillingStatus";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection, SettingsSidebarContext } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import type { SettingsPageTarget } from "./components/settings-page-targets";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { useSettingsConnectAccount } from "./useSettingsConnectAccount";
import { filterSettingsSections } from "./settings-search";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";

export function SettingsRouteScreen() {
  const surface = useWorkspaceSurface();
  const deviceType = useDeviceType();
  const compactTabs = useCompactWorkspaceTabs();
  const workspace = useWorkspaceTabs();
  const { layout } = useAdaptiveWorkspaceLayout();
  const inSidebar = use(NativePrimaryColumnContext) !== null && layout.usesSplitView;
  // The page open beside the list: the route right above the Settings tab's route. While
  // another tab is open this list stays mounted, hidden, and must keep showing the page Settings
  // reopens on; otherwise returning shows it unselected for a frame before the page arrives.
  const selected = useNavigationState((state) => {
    const list = state.routes.findIndex((route) => route.name === "Settings");
    return list < 0
      ? rememberedSettingsPage(currentWorkspaceSelections())
      : (state.routes[list + 1]?.name ?? null);
  });
  const sidebar = useMemo(() => (inSidebar ? { selected } : null), [inSidebar, selected]);
  const content = hasCloudPublicConfig() ? (
    <ConfiguredSettingsRouteScreen />
  ) : (
    <LocalSettingsRouteScreen />
  );

  return (
    <SettingsSidebarContext value={sidebar}>
      <View className={`flex-1 ${inSidebar ? surface.className : "bg-screen"}`}>
        <SettingsEnvironmentFilterHeader />
        <ScreenScrollViewBottomInset value={deviceType === "pad" || compactTabs ? 80 : 0}>
          {Platform.OS === "android" ? (
            <SettingsScreen
              title="Settings"
              trailing={<AndroidSettingsEnvironmentFilter />}
              search={
                workspace
                  ? {
                      value: workspace.state.tabs.settings.query,
                      onChangeText: (query) =>
                        workspace.dispatch({ type: "query", tab: "settings", query }),
                      placeholder: "Search settings",
                    }
                  : undefined
              }
            >
              {content}
            </SettingsScreen>
          ) : (
            content
          )}
        </ScreenScrollViewBottomInset>
      </View>
    </SettingsSidebarContext>
  );
}

type SettingsListRow = ComponentProps<typeof SettingsRow> & { readonly id: string };

interface SettingsListSection {
  readonly title?: string;
  readonly rows: readonly SettingsListRow[];
  /** Lecturn: draws the matching rows itself instead of as `SettingsRow`s. */
  readonly render?: (rows: readonly SettingsListRow[]) => ReactNode;
}

function ConfiguredSettingsRouteScreen() {
  const { selectedAccountId, setPickedAccountId } = useSettingsConnectAccount();
  const { savedConnectionsById } = useSavedRemoteConnections();

  return (
    <SettingsList
      accounts={
        <View className="gap-3">
          <ConnectAccountsSettings
            selectedAccountId={selectedAccountId}
            onSelect={setPickedAccountId}
          />
          <TeamSelector accountId={selectedAccountId} />
          <ConnectBillingStatus accountId={selectedAccountId} />
          <Text className="px-2 text-sm text-foreground-muted">
            Lecturn works locally without signing in. Cloud features are optional.
          </Text>
        </View>
      }
      connections={[
        environmentsRow(Object.keys(savedConnectionsById).length),
        {
          id: "SettingsNotifications",
          icon: "bell.badge",
          label: "Notifications",
          target: "SettingsNotifications",
        },
      ]}
    />
  );
}

function LocalSettingsRouteScreen() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  return <SettingsList connections={[environmentsRow(Object.keys(savedConnectionsById).length)]} />;
}

function environmentsRow(count: number): SettingsListRow {
  return {
    id: "SettingsEnvironments",
    icon: "desktopcomputer",
    label: "Environments",
    value: `${count}`,
    valuePosition: "trailing",
    target: "SettingsEnvironments",
  };
}

function SettingsList(props: {
  readonly accounts?: ReactNode;
  readonly connections: readonly SettingsListRow[];
}) {
  const insets = useSafeAreaInsets();
  const workspace = useWorkspaceTabs();
  const query = workspace?.state.tabs.settings.query ?? "";
  const overflowRows = useOverflowRows();
  const indexSections = useSettingsIndexSections();
  const sections = filterSettingsSections<SettingsListRow, SettingsListSection>(
    [{ rows: overflowRows }, { title: "Connections", rows: props.connections }, ...indexSections],
    query,
  );
  // Lecturn: the Connect account controls sit above Connections; a search for an account term
  // (sign in, connect) keeps them.
  const showAccounts =
    props.accounts !== undefined &&
    filterSettingsSections([{ rows: [{ id: "account", label: "Lecturn Account" }] }], query)
      .length > 0;
  const accountsIndex = showAccounts
    ? sections.findIndex((section) => section.title !== undefined)
    : -1;

  return (
    <View collapsable={false} className="flex-1">
      <ArcaneBackdrop emphasis="sidebar" />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        // Stay transparent: the screen draws ArcaneBackdrop once behind the list,
        // and an opaque scroll surface would hide it.
        className="flex-1 bg-transparent"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{
          // The workspace's clearance keeps the last row above its search field and keyboard.
          paddingBottom: Math.max(
            Math.max(insets.bottom, 18) + 18,
            workspace?.bottomClearance ?? 0,
          ),
        }}
      >
        {sections.length || showAccounts ? (
          <>
            {sections.map((section, index) => (
              <Fragment key={section.title ?? "tabs"}>
                {index === accountsIndex ? props.accounts : null}
                <SettingsSection title={section.title}>
                  {section.render
                    ? section.render(section.rows)
                    : section.rows.map(({ id, ...row }) => <SettingsRow key={id} {...row} />)}
                </SettingsSection>
              </Fragment>
            ))}
            {showAccounts && accountsIndex < 0 ? props.accounts : null}
          </>
        ) : (
          <EmptyState
            variant="plain"
            title="No results"
            detail={`No settings match “${query.trim()}”.`}
          />
        )}
      </ScrollView>
    </View>
  );
}

function useSettingsIndexSections(): SettingsListSection[] {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const noServerTargets = selectedTargets.length === 0;
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const scopedProjectMembers =
    selectedProject?.members
      .map((member) => member.project)
      .filter((project) =>
        selectedTargets.some((target) => target.environmentId === project.environmentId),
      ) ?? [];
  const projectLabel =
    scopedProjectMembers.length > 0
      ? deriveProjectGroupLabel({
          representative: scopedProjectMembers[0]!,
          members: scopedProjectMembers,
        })
      : (selectedProject?.label ?? "Unavailable project");
  const contextual = useContextualSection();
  const page = (
    target: SettingsPageTarget,
    icon: SettingsListRow["icon"],
    label: string,
    extra?: Pick<SettingsListRow, "disabled" | "value">,
  ): SettingsListRow => ({ id: target, icon, label, target, ...extra });
  const serverPage = (target: SettingsPageTarget, icon: SettingsListRow["icon"], label: string) =>
    page(target, icon, label, { disabled: noServerTargets });
  return [
    {
      title: "Interface",
      rows: [
        page("SettingsAppearance", "paintbrush", "Appearance"),
        ...(navigationCustomizationAvailable()
          ? [page("SettingsNavigation", "line.3.horizontal", "Navigation tabs")]
          : []),
        ...(Platform.OS === "ios"
          ? [
              page("SettingsKeyboard", "keyboard", "Keyboard"),
              page("SettingsMicrophone", "mic", "Microphone"),
            ]
          : []),
      ],
    },
    {
      title: "Automations",
      rows: [page("SettingsScheduledTasks", "clock", "Scheduled tasks")],
    },
    {
      title: "Projects & threads",
      rows: [
        ...(selectedProjectKey !== null
          ? [page("SettingsProjectOverview", "folder", "Overview", { value: projectLabel })]
          : []),
        page("SettingsOrganization", "folder", "Organization"),
        page("SettingsThreads", "text.bubble", "Thread behavior"),
        page("SettingsFollowUp", "arrow.turn.left.up", "Follow-ups"),
        page("SettingsArchive", "archivebox", "Archived Threads"),
      ],
    },
    contextual,
    {
      title: "Server settings",
      rows: [
        serverPage("SettingsProviderAccounts", "person.crop.circle", "Provider accounts"),
        serverPage("SettingsEnvironmentNewThreads", "text.bubble", "New threads"),
        serverPage("SettingsEnvironmentSourceControl", "arrow.triangle.branch", "Source control"),
        serverPage("SettingsEnvironmentAgentBehavior", "text.alignleft", "Agent behavior"),
        serverPage("SettingsEnvironmentMaintenance", "arrow.clockwise", "Maintenance"),
      ],
    },
    {
      title: "App",
      rows: [page("SettingsAbout", "info.circle", "About Lecturn")],
    },
  ];
}

function useContextualSection(): SettingsListSection {
  const { environments } = useEnvironments();
  const navigation = useNavigation<NavigationProp<{ Contextual: { environmentId: string } }>>();
  const supported = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.contextual === true,
  );
  return {
    title: "Contextual",
    rows: supported.map((environment) => ({
      id: `contextual:${environment.environmentId}`,
      icon: "text.bubble",
      label: `Sources and membership · ${environment.label}`,
      onPress: () =>
        navigation.navigate("Contextual", { environmentId: environment.environmentId }),
    })),
    render: (rows) =>
      rows.map((row) => <ContextualButton key={row.id} label={row.label} onPress={row.onPress!} />),
  };
}

function useOverflowRows(): SettingsListRow[] {
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const { layout } = useAdaptiveWorkspaceLayout();
  const tabs =
    Platform.OS === "android" && layout.usesSplitView ? [] : overflowNavigationTabs(order, hidden);
  const selectTab = useSelectWorkspaceTab();
  return tabs.map((tab) => ({
    id: tab,
    icon: NAVIGATION_TAB_ICONS[tab],
    label: WORKSPACE_TAB_LABELS[tab],
    onPress: () => selectTab(tab),
  }));
}
