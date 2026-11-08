import {
  foldSearchQuery,
  PALETTE_SECONDARY_LIMIT,
  PALETTE_THREAD_LIMIT,
  rankSearchGroups,
  scoreSearchTerms,
  scoreThreadSearch,
  type SearchMatchHint,
  type SearchRange,
  type ThreadSearchSubject,
} from "@lecturn/shared/paletteSearch";
import { threadSearchSubject } from "@lecturn/client-runtime/state/thread-search";
import type { CommandPaletteLinkedThreads } from "../commandPaletteBus";
import {
  addProjectRemoteSourceLabel,
  addProjectRemoteSourcePathHint,
  buildAddProjectRemoteSourceReadiness,
  type AddProjectRemoteSource,
  type AddProjectRemoteSourceReadiness,
} from "@lecturn/client-runtime/operations/projects";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type FilesystemBrowseEntry,
  type KeybindingCommand,
  type ScopedProjectRef,
  type Squire,
  type SquireId,
  type SquireRoomId,
  type SquireRoomRow,
  type SourceControlDiscoveryResult,
  type SourceControlRepositoryInfo,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@lecturn/contracts";
import {
  ADD_PROJECT_STAVE_SOURCES,
  addProjectStaveSourceDescription,
  addProjectStaveSourceLabel,
  type AddProjectStaveSource,
} from "@lecturn/client-runtime/operations/projects";
import { filterFilesystemBrowseEntries } from "@lecturn/client-runtime/state/filesystem";
import { type ReactNode } from "react";
import { squireRoomPaletteEntries } from "./squire/rooms/squireRooms.logic";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { type Project, type SidebarThreadSummary, type Thread } from "../types";
import { isSidebarSubagentThread } from "./Sidebar.logic";

export const RECENT_THREAD_LIMIT = 12;
export const ITEM_ICON_CLASS = "size-4 text-icon-muted";
export const ADDON_ICON_CLASS = "size-4";

export function buildLinkedThreadActionItems(
  input: CommandPaletteLinkedThreads & {
    query: string;
    icon: ReactNode;
    runThread: (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) => Promise<void>;
  },
): CommandPaletteActionItem[] {
  return input.threads.map((thread) => ({
    kind: "action",
    value: `thread:${input.environmentId}:${thread.id}`,
    title: thread.title || "Untitled thread",
    description: thread.archivedAt === null ? "Linked thread" : "Archived thread",
    searchTerms: [input.query, thread.title],
    icon: input.icon,
    run: () => input.runThread({ environmentId: input.environmentId, id: thread.id }),
  }));
}

export function browseInputEndPaddingClass(input: {
  readonly willCreateProjectPath: boolean;
  readonly hasHighlightedBrowseItem: boolean;
}): string {
  if (input.willCreateProjectPath) {
    return "*:data-[slot=autocomplete-input]:pe-38!";
  }
  if (input.hasHighlightedBrowseItem) {
    return "*:data-[slot=autocomplete-input]:pe-30!";
  }
  return "*:data-[slot=autocomplete-input]:pe-24!";
}

export type SearchOverlayMode = "command" | "files" | "content";

export type CommandPaletteOpenIntent =
  | { readonly kind: "add-project" | "new-thread-in" | "change-theme" | "open-app" }
  | { readonly kind: "import-session"; readonly projectRef: ScopedProjectRef }
  | {
      readonly kind: "search";
      readonly query: string;
      readonly linkedThreads?: CommandPaletteLinkedThreads;
    };

export interface CommandPaletteUiState {
  readonly open: boolean;
  readonly mode: SearchOverlayMode;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly parentSearch?: CommandPaletteReturnContext;
  readonly restoredSearch?: CommandPaletteReturnContext;
}

export type CommandPaletteUiAction =
  | { readonly _tag: "SetOpen"; readonly open: boolean }
  | { readonly _tag: "ToggleMode"; readonly mode: SearchOverlayMode }
  | {
      readonly _tag: "OpenSearch";
      readonly query: string;
      readonly linkedThreads?: CommandPaletteLinkedThreads;
    }
  | { readonly _tag: "OpenAddProject" }
  | { readonly _tag: "OpenNewThreadIn" }
  | { readonly _tag: "OpenApp" }
  | { readonly _tag: "OpenImportSession"; readonly projectRef: ScopedProjectRef }
  | { readonly _tag: "OpenChangeTheme" }
  | { readonly _tag: "ClearOpenIntent" }
  | {
      readonly _tag: "OpenChildSearch";
      readonly mode: "files" | "content";
      readonly context: CommandPaletteReturnContext;
    }
  | { readonly _tag: "BackToCommand" };

export function reduceCommandPaletteUiState(
  state: CommandPaletteUiState,
  action: CommandPaletteUiAction,
): CommandPaletteUiState {
  switch (action._tag) {
    case "SetOpen":
      return action.open
        ? { open: true, mode: "command", openIntent: state.openIntent }
        : { open: false, mode: state.mode, openIntent: null };
    case "ToggleMode":
      return state.open && state.mode === action.mode
        ? { open: false, mode: state.mode, openIntent: null }
        : { open: true, mode: action.mode, openIntent: null };
    case "OpenChildSearch":
      return { open: true, mode: action.mode, openIntent: null, parentSearch: action.context };
    case "BackToCommand":
      return state.open && state.mode !== "command"
        ? {
            open: true,
            mode: "command",
            openIntent: null,
            ...(state.parentSearch ? { restoredSearch: state.parentSearch } : {}),
          }
        : state;
    case "OpenSearch":
      return {
        open: true,
        mode: "command",
        openIntent: {
          kind: "search",
          query: action.query,
          ...(action.linkedThreads ? { linkedThreads: action.linkedThreads } : {}),
        },
      };
    case "OpenAddProject":
      return { open: true, mode: "command", openIntent: { kind: "add-project" } };
    case "OpenNewThreadIn":
      return { open: true, mode: "command", openIntent: { kind: "new-thread-in" } };
    case "OpenApp":
      return { open: true, mode: "command", openIntent: { kind: "open-app" } };
    case "OpenImportSession":
      return {
        open: true,
        mode: "command",
        openIntent: { kind: "import-session", projectRef: action.projectRef },
      };
    case "OpenChangeTheme":
      return { open: true, mode: "command", openIntent: { kind: "change-theme" } };
    case "ClearOpenIntent":
      return state.openIntent ? { ...state, openIntent: null } : state;
  }
}

export interface CommandPaletteApp {
  readonly appId: string;
  readonly name: string;
  readonly icon: ReactNode;
  /** The app's status, e.g. Running or Closed. */
  readonly status: string | null;
}

export interface AppsPaletteItems {
  /** The mode switch for the mode not showing, and "Open app…" once there is an app. */
  readonly actions: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  readonly openAppItems: ReadonlyArray<CommandPaletteActionItem>;
}

export function buildAppsPaletteItems(input: {
  readonly sidebarMode: "projects" | "apps";
  readonly apps: ReadonlyArray<CommandPaletteApp>;
  readonly icons: {
    readonly projects: ReactNode;
    readonly apps: ReactNode;
    readonly appsAddon: ReactNode;
  };
  readonly showSidebarMode: (target: {
    readonly mode: "projects" | "apps";
    readonly appId?: string;
  }) => void;
}): AppsPaletteItems {
  const target = input.sidebarMode === "apps" ? "projects" : "apps";
  const openAppItems = input.apps.map((app): CommandPaletteActionItem => ({
    kind: "action",
    value: `open-app:${app.appId}`,
    searchTerms: [app.name, app.appId],
    title: app.name,
    ...(app.status === null ? {} : { description: app.status }),
    icon: app.icon,
    run: async () => input.showSidebarMode({ mode: "apps", appId: app.appId }),
  }));
  const switchMode: CommandPaletteActionItem = {
    kind: "action",
    value: `action:sidebar-${target}`,
    searchTerms: [
      target === "apps" ? "Switch sidebar to Apps" : "Switch sidebar to Projects",
      "sidebar",
      "mode",
      target === "apps" ? "connected apps" : "projects",
    ],
    title: target === "apps" ? "Switch sidebar to Apps" : "Switch sidebar to Projects",
    icon: target === "apps" ? input.icons.apps : input.icons.projects,
    shortcutCommand: "sidebar.toggleApps",
    run: async () => input.showSidebarMode({ mode: target }),
  };
  if (openAppItems.length === 0) return { actions: [switchMode], openAppItems };
  return {
    actions: [
      switchMode,
      {
        kind: "submenu",
        value: "action:open-app",
        searchTerms: ["Open app", "apps", "connected apps", ...input.apps.map((app) => app.name)],
        title: "Open app…",
        icon: input.icons.apps,
        addonIcon: input.icons.appsAddon,
        groups: [{ value: "apps", label: "Apps", items: openAppItems }],
      },
    ],
    openAppItems,
  };
}

type CommandPaletteSquire = Pick<Squire, "id" | "name" | "role">;

export interface CommandPaletteSquireEnvironment<TSquire extends CommandPaletteSquire> {
  readonly environmentId: EnvironmentId;
  readonly state: {
    readonly lead: SquireId | null;
    readonly squires: ReadonlyArray<{ readonly squire: TSquire }>;
  };
}

/**
 * One "Open Squire: <name>" per Squire per Squire-capable environment, the Lead first in each.
 * The environment is named only when several have Squires, so a single machine reads cleanly.
 */
export function buildSquirePaletteItems<TSquire extends CommandPaletteSquire>(input: {
  readonly environments: ReadonlyArray<CommandPaletteSquireEnvironment<TSquire>>;
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly icon: (squire: TSquire, isLead: boolean) => ReactNode;
  readonly openSquire: (target: {
    readonly environmentId: EnvironmentId;
    readonly squireId: SquireId;
  }) => Promise<void>;
}): CommandPaletteActionItem[] {
  const withSquires = input.environments.filter(({ state }) => state.squires.length > 0);
  const nameEnvironment = withSquires.length > 1;
  return withSquires.flatMap(({ environmentId, state }) => {
    const isLead = (squire: CommandPaletteSquire) =>
      squire.id === state.lead || squire.role === "lead";
    const environmentLabel = nameEnvironment ? input.environmentLabel(environmentId) : null;
    return state.squires
      .map(({ squire }) => squire)
      .toSorted((a, b) => Number(isLead(b)) - Number(isLead(a)))
      .map((squire): CommandPaletteActionItem => {
        const lead = isLead(squire);
        return {
          kind: "action",
          value: `open-squire:${environmentId}:${squire.id}`,
          searchTerms: [
            `Open Squire: ${squire.name}`,
            "squire",
            ...(lead ? ["lead"] : []),
            ...(environmentLabel === null ? [] : [environmentLabel]),
          ],
          title: `Open Squire: ${squire.name}`,
          ...(environmentLabel === null ? {} : { description: environmentLabel }),
          icon: input.icon(squire, lead),
          run: () => input.openSquire({ environmentId, squireId: squire.id }),
        };
      });
  });
}

/**
 * "New Squire…" per environment that may create one, and "Edit Squire: <name>" per Squire,
 * the Lead included, both opening the one setup sheet.
 */
export function buildSquireSetupPaletteItems<TSquire extends CommandPaletteSquire>(input: {
  readonly environments: ReadonlyArray<CommandPaletteSquireEnvironment<TSquire>>;
  readonly access: (environmentId: EnvironmentId) => {
    readonly canCreate: boolean;
    readonly canEdit: boolean;
  };
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly icon: (squire: TSquire, isLead: boolean) => ReactNode;
  readonly newIcon: ReactNode;
  readonly openSetup: (
    target:
      | { readonly kind: "create"; readonly environmentId: EnvironmentId }
      | {
          readonly kind: "edit";
          readonly environmentId: EnvironmentId;
          readonly squireId: SquireId;
        },
  ) => void;
}): CommandPaletteActionItem[] {
  const creatable = input.environments.filter(
    ({ environmentId }) => input.access(environmentId).canCreate,
  );
  const withSquires = input.environments.filter(
    ({ environmentId, state }) => state.squires.length > 0 && input.access(environmentId).canEdit,
  );
  const createItems = creatable.map(({ environmentId }): CommandPaletteActionItem => {
    const label = creatable.length > 1 ? input.environmentLabel(environmentId) : null;
    return {
      kind: "action",
      value: `new-squire:${environmentId}`,
      // Named "Squire" for search, so a bare "squire" query ranks it as an exact match, above
      // every per-Squire item.
      searchTerms: ["Squire", "New Squire…", "create", ...(label === null ? [] : [label])],
      searchTitle: "Squire",
      title: "New Squire…",
      ...(label === null ? {} : { description: label }),
      icon: input.newIcon,
      run: async () => input.openSetup({ kind: "create", environmentId }),
    };
  });
  const editItems = withSquires.flatMap(({ environmentId, state }) => {
    const label = withSquires.length > 1 ? input.environmentLabel(environmentId) : null;
    return state.squires.map(({ squire }): CommandPaletteActionItem => {
      const lead = squire.id === state.lead || squire.role === "lead";
      return {
        kind: "action",
        value: `edit-squire:${environmentId}:${squire.id}`,
        searchTerms: [
          `Edit Squire: ${squire.name}`,
          "squire",
          "settings",
          ...(lead ? ["lead"] : []),
          ...(label === null ? [] : [label]),
        ],
        title: `Edit Squire: ${squire.name}`,
        ...(label === null ? {} : { description: label }),
        icon: input.icon(squire, lead),
        run: async () => input.openSetup({ kind: "edit", environmentId, squireId: squire.id }),
      };
    });
  });
  return [...createItems, ...editItems];
}

/**
 * "Open room: <topic>" per open room and "New Squire room" per environment that may
 * create one. Closed rooms stay reachable from the Lead view's Rooms menu.
 */
export function buildSquireRoomPaletteItems(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly rooms: ReadonlyArray<SquireRoomRow>;
  }>;
  readonly canCreateRoom: (environmentId: EnvironmentId) => boolean;
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly icon: ReactNode;
  readonly openRoom: (target: {
    readonly environmentId: EnvironmentId;
    readonly roomId: SquireRoomId;
  }) => Promise<void>;
  readonly newRoom: (environmentId: EnvironmentId) => void;
}): CommandPaletteActionItem[] {
  const named = input.environments.length > 1;
  const label = (environmentId: EnvironmentId) =>
    named ? input.environmentLabel(environmentId) : null;
  const openItems = squireRoomPaletteEntries(input.environments).map(
    ({ environmentId, roomId, title }): CommandPaletteActionItem => {
      const description = label(environmentId);
      return {
        kind: "action",
        value: `open-squire-room:${environmentId}:${roomId}`,
        searchTerms: [title, "room", "squire", ...(description === null ? [] : [description])],
        title,
        ...(description === null ? {} : { description }),
        icon: input.icon,
        run: () => input.openRoom({ environmentId, roomId }),
      };
    },
  );
  const creatable = input.environments.filter(({ environmentId }) =>
    input.canCreateRoom(environmentId),
  );
  const createItems = creatable.map(({ environmentId }): CommandPaletteActionItem => {
    const description = creatable.length > 1 ? input.environmentLabel(environmentId) : null;
    return {
      kind: "action",
      value: `new-squire-room:${environmentId}`,
      searchTerms: [
        "New Squire room",
        "room",
        "squire",
        ...(description === null ? [] : [description]),
      ],
      title: "New Squire room",
      ...(description === null ? {} : { description }),
      icon: input.icon,
      run: async () => input.newRoom(environmentId),
    };
  });
  return [...openItems, ...createItems];
}

/** Contextual "Track with <name>" and "Stop tracking (<name>)" for the current thread or project. */
export function buildSquireTrackPaletteItems(input: {
  readonly environmentId: EnvironmentId;
  readonly subject: string;
  readonly menu: {
    readonly squires: ReadonlyArray<{
      readonly id: SquireId;
      readonly name: string;
      readonly tracked: boolean;
    }>;
    readonly canTrack: boolean;
    readonly canUntrack: boolean;
  };
  readonly icons: { readonly track: ReactNode; readonly untrack: ReactNode };
  readonly run: (choice: {
    readonly action: "track" | "untrack";
    readonly squireId: SquireId;
  }) => Promise<void>;
}): CommandPaletteActionItem[] {
  return input.menu.squires.flatMap((squire): CommandPaletteActionItem[] => {
    if (squire.tracked ? !input.menu.canUntrack : !input.menu.canTrack) return [];
    const action = squire.tracked ? "untrack" : "track";
    const title = squire.tracked ? `Stop tracking (${squire.name})` : `Track with ${squire.name}`;
    return [
      {
        kind: "action",
        value: `squire-${action}:${input.environmentId}:${squire.id}`,
        searchTerms: [title, "squire", squire.tracked ? "untrack" : "track", "watch"],
        title,
        description: input.subject,
        icon: squire.tracked ? input.icons.untrack : input.icons.track,
        run: () => input.run({ action, squireId: squire.id }),
      },
    ];
  });
}

export interface CommandPaletteThreadContentMatch {
  readonly source: "user" | "assistant";
  readonly snippet: string;
  readonly query: string;
}

export interface CommandPaletteItem {
  readonly kind: "action" | "submenu";
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: ReactNode;
  /** The name search ranks by when it is not `title`: a styled title's plain text, or a shorter name. */
  readonly searchTitle?: string;
  readonly description?: ReactNode;
  readonly threadContentMatch?: CommandPaletteThreadContentMatch;
  readonly timestamp?: string;
  /** Thread rows rank by this, with use history, instead of by `searchTerms`. */
  readonly threadSearch?: ThreadSearchSubject;
  /** Shown in place of the description when the match is not in the title. */
  readonly matchHint?: SearchMatchHint;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly titleLeadingContent?: ReactNode;
  readonly titleTrailingContent?: ReactNode;
  readonly shortcutCommand?: KeybindingCommand;
  readonly secondary?: boolean;
}

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly kind: "action";
  readonly keepOpen?: boolean;
  readonly run: () => Promise<void>;
}

export interface CommandPaletteSubmenuItem extends CommandPaletteItem {
  readonly kind: "submenu";
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
}

export interface CommandPaletteView {
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

// Child search unmounts the palette; retain search data without its view closures.
export interface CommandPaletteReturnContext {
  readonly query: string;
  readonly linkedThreadSearch: Extract<CommandPaletteOpenIntent, { kind: "search" }> | null;
}

export interface CommandPaletteSearchState {
  readonly query: string;
  readonly views: ReadonlyArray<{
    readonly view: CommandPaletteView;
    readonly parentQuery: string;
  }>;
}

export function createCommandPaletteSearchState(query = ""): CommandPaletteSearchState {
  return { query, views: [] };
}

export function reduceCommandPaletteSearchState(
  state: CommandPaletteSearchState,
  action:
    | { readonly type: "query"; readonly query: string }
    | { readonly type: "push"; readonly view: CommandPaletteView }
    | { readonly type: "back" }
    | { readonly type: "reset"; readonly query?: string },
): CommandPaletteSearchState {
  switch (action.type) {
    case "query":
      return { ...state, query: action.query };
    case "push":
      return {
        query: action.view.initialQuery ?? "",
        views: [...state.views, { view: action.view, parentQuery: state.query }],
      };
    case "back": {
      const parent = state.views.at(-1);
      return parent ? { query: parent.parentQuery, views: state.views.slice(0, -1) } : state;
    }
    case "reset":
      return createCommandPaletteSearchState(action.query);
  }
}

export type CommandPaletteRow =
  | {
      readonly kind: "label";
      readonly key: string;
      readonly label: string;
      readonly first: boolean;
    }
  | {
      readonly kind: "item";
      readonly key: string;
      readonly item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
      readonly itemIndex: number | null;
    };

export function buildCommandPaletteRows(groups: ReadonlyArray<CommandPaletteGroup>) {
  const rows: CommandPaletteRow[] = [];
  const itemValues: string[] = [];
  const rowIndexByItemIndex: number[] = [];
  for (const group of groups) {
    if (group.label) {
      rows.push({
        kind: "label",
        key: `group:${group.value}`,
        label: group.label,
        first: rows.length === 0,
      });
    }
    for (const item of group.items) {
      const itemIndex = item.disabled ? null : itemValues.length;
      if (itemIndex !== null) {
        itemValues.push(item.value);
        rowIndexByItemIndex.push(rows.length);
      }
      rows.push({ kind: "item", key: `${group.value}:${item.value}`, item, itemIndex });
    }
  }
  return { rows, itemValues, rowIndexByItemIndex };
}

export function findHighlightedCommandPaletteItem(
  groups: ReadonlyArray<CommandPaletteGroup>,
  highlightedItemValue: string | null,
): CommandPaletteActionItem | CommandPaletteSubmenuItem | null {
  if (highlightedItemValue === null) return null;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.value === highlightedItemValue && !item.disabled) return item;
    }
  }
  return null;
}

export function enumerateCommandPaletteItems(
  items: ReadonlyArray<CommandPaletteActionItem>,
): CommandPaletteActionItem[] {
  return items.map((item, index) => {
    const shortcutCommand = THREAD_JUMP_KEYBINDING_COMMANDS[index];
    if (shortcutCommand) return { ...item, shortcutCommand };

    const { shortcutCommand: _shortcutCommand, ...itemWithoutShortcut } = item;
    return itemWithoutShortcut;
  });
}

export type CommandPaletteMode = "root" | "root-browse" | "submenu" | "submenu-browse";

export type CommandPaletteProject = Project & { readonly displayName: string };

export function buildCommandPaletteProjectMetadata(input: {
  readonly projects: ReadonlyArray<Pick<Project, "environmentId" | "title" | "workspaceRoot">>;
  readonly locationByEnvironmentId: ReadonlyMap<EnvironmentId, { readonly label: string }>;
}) {
  const searchTerms: string[] = [];
  const environmentLabels = new Set<string>();

  for (const project of input.projects) {
    const label = input.locationByEnvironmentId.get(project.environmentId)?.label ?? "Remote";
    searchTerms.push(project.title, project.workspaceRoot, label);
    environmentLabels.add(label);
  }

  return { searchTerms, environmentLabels: [...environmentLabels] };
}

export function buildProjectActionItems(input: {
  projects: ReadonlyArray<CommandPaletteProject>;
  valuePrefix: string;
  icon: (project: CommandPaletteProject) => ReactNode;
  runProject: (project: CommandPaletteProject) => Promise<void>;
  searchTerms?: (project: CommandPaletteProject) => ReadonlyArray<string>;
  renderDescription?: (project: CommandPaletteProject) => ReactNode;
  shortcutCommand?: KeybindingCommand;
}): CommandPaletteActionItem[] {
  return input.projects.map((project) => ({
    kind: "action",
    value: `${input.valuePrefix}:${project.environmentId}:${project.id}`,
    searchTerms: [
      project.displayName,
      project.title,
      project.workspaceRoot,
      ...(input.searchTerms?.(project) ?? []),
    ],
    title: project.displayName,
    description: input.renderDescription?.(project) ?? project.workspaceRoot,
    icon: input.icon(project),
    ...(input.shortcutCommand !== undefined ? { shortcutCommand: input.shortcutCommand } : {}),
    run: async () => {
      await input.runProject(project);
    },
  }));
}

/**
 * "New Stave space" / "New Stave saga" entries for the add-project source
 * list. Present only while the feature gate passes (capability, enabled,
 * runnable); the wizard owns everything after the click.
 */
export function buildStaveAddProjectItems(input: {
  readonly environmentId: string;
  readonly available: boolean;
  readonly unsupportedOperations?: readonly string[];
  readonly icons: Record<AddProjectStaveSource, ReactNode>;
  readonly launch: (source: AddProjectStaveSource) => void;
}): CommandPaletteActionItem[] {
  if (!input.available) return [];
  return ADD_PROJECT_STAVE_SOURCES.filter(
    (source) =>
      !input.unsupportedOperations?.includes(
        source === "stave-space" ? "createSpace" : "createSaga",
      ),
  ).map((source) => ({
    kind: "action",
    value: `action:add-project:${input.environmentId}:${source}`,
    searchTerms: ["stave", "new", source === "stave-space" ? "space" : "saga", "workspace"],
    title: addProjectStaveSourceLabel(source),
    description: addProjectStaveSourceDescription(source),
    icon: input.icons[source],
    run: async () => {
      input.launch(source);
    },
  }));
}

export type BuildThreadActionItemsThread = Pick<
  SidebarThreadSummary,
  | "archivedAt"
  | "branch"
  | "createdAt"
  | "environmentId"
  | "id"
  | "lineage"
  | "modelSelection"
  | "projectId"
  | "runtime"
  | "title"
  | "worktreePath"
> &
  Partial<
    Pick<
      SidebarThreadSummary,
      "pullRequests" | "linkedPullRequest" | "branchPullRequest" | "opens" | "latestUserMessageAt"
    >
  > & {
    updatedAt: string;
  };

export function buildThreadActionItems<TThread extends BuildThreadActionItemsThread>(input: {
  threads: ReadonlyArray<TThread>;
  activeThread?: Pick<Thread, "environmentId" | "id">;
  projectByKey: ReadonlyMap<string, Pick<Project, "title">>;
  icon: ReactNode;
  renderLeadingContent?: (thread: TThread) => ReactNode;
  renderTrailingContent?: (thread: TThread) => ReactNode;
  renderDescription?: (thread: TThread, meta: { projectTitle: string | undefined }) => ReactNode;
  runThread: (thread: TThread) => Promise<void>;
  /** Makes the environment searchable; pass it only with two or more environments. */
  environmentLabelOf?: (thread: TThread) => string | null;
}): CommandPaletteActionItem[] {
  // Callers order these: recents by last use, search results by rank.
  const visibleThreads = input.threads.filter(
    (thread) => thread.archivedAt === null && !isSidebarSubagentThread(thread),
  );

  return visibleThreads.map((thread) => {
    const projectTitle = input.projectByKey.get(
      `${thread.environmentId}:${thread.projectId}`,
    )?.title;
    const descriptionParts: string[] = [];

    if (projectTitle) {
      descriptionParts.push(projectTitle);
    }
    if (thread.branch) {
      descriptionParts.push(`#${thread.branch}`);
    }
    const isCurrent =
      thread.id === input.activeThread?.id &&
      thread.environmentId === input.activeThread.environmentId;
    if (isCurrent) {
      descriptionParts.push("Current thread");
    }

    const leadingContent = input.renderLeadingContent?.(thread);
    const trailingContent = input.renderTrailingContent?.(thread);
    const description = input.renderDescription
      ? input.renderDescription(thread, { projectTitle })
      : descriptionParts.join(` · `);

    return Object.assign(
      {
        kind: "action" as const,
        value: `thread:${thread.environmentId}:${thread.id}`,
        searchTerms: [thread.title],
        threadSearch: threadSearchSubject(
          {
            ...thread,
            latestUserMessageAt: thread.latestUserMessageAt ?? null,
            opens: thread.opens ?? null,
          },
          projectTitle,
          input.environmentLabelOf?.(thread),
        ),
        title: thread.title,
        description,
        timestamp: formatRelativeTimeLabel(
          thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
        ),
        icon: input.icon,
      },
      leadingContent ? { titleLeadingContent: leadingContent } : {},
      trailingContent ? { titleTrailingContent: trailingContent } : {},
      // Last in its group: picking the thread already open does nothing.
      isCurrent ? { secondary: true } : {},
      {
        run: async () => {
          await input.runThread(thread);
        },
      },
    );
  });
}

type PaletteItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

function rankPaletteItem(
  item: PaletteItem,
  normalizedQuery: string,
  now: number,
  options: { readonly typos: boolean },
): {
  readonly score: number;
  readonly quality: number;
  readonly groupQuality?: number;
  readonly strong: boolean;
  readonly ranges: ReadonlyArray<SearchRange>;
  readonly explain?: () => SearchMatchHint | undefined;
  readonly pickedAt?: number;
  readonly pickedExactly?: boolean;
} | null {
  const match = scorePaletteItem(item, normalizedQuery, now, options);
  // A row listed last in its group (a keybinding setting, the open thread)
  // does not decide where the group sits.
  return match && item.secondary ? { ...match, groupQuality: 0 } : match;
}

function scorePaletteItem(
  item: PaletteItem,
  normalizedQuery: string,
  now: number,
  options: { readonly typos: boolean },
) {
  if (item.threadSearch) return scoreThreadSearch(normalizedQuery, item.threadSearch, now, options);
  // The title names the item; search terms are keywords. Ranges index the
  // first term, so they only highlight a title that is that term.
  const name = item.searchTitle ?? (typeof item.title === "string" ? item.title : undefined);
  const terms =
    name !== undefined && name !== item.searchTerms[0]
      ? [name, ...item.searchTerms]
      : item.searchTerms;
  const match = scoreSearchTerms(normalizedQuery, terms, options);
  return match && (item.title === terms[0] ? match : { ...match, ranges: [] });
}

/**
 * Equal match classes put commands before threads, so "new" runs "New thread".
 * Server message matches stay in a final group so late results cannot move earlier rows.
 */
export function filterCommandPaletteGroups(input: {
  activeGroups: ReadonlyArray<CommandPaletteGroup>;
  query: string;
  isInSubmenu: boolean;
  /** Submenu options join the root search, and a submenu with no match falls back to it. */
  allOptions?: {
    readonly rootGroups: ReadonlyArray<CommandPaletteGroup>;
    readonly nestedItems: ReadonlyArray<CommandPaletteActionItem>;
  };
  projectSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  settingsSearchItems?: ReadonlyArray<CommandPaletteActionItem>;
  threadSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  /** Threads whose messages match, best first; threads already listed are skipped. */
  threadMessageItems?: ReadonlyArray<CommandPaletteActionItem>;
  now?: number;
}): CommandPaletteGroup[] {
  if (input.allOptions && input.isInSubmenu) {
    const { allOptions, ...submenuInput } = input;
    const scoped = filterCommandPaletteGroups(submenuInput);
    if (scoped.length > 0 || input.query.trim().length === 0) return scoped;
    return filterCommandPaletteGroups({
      ...input,
      activeGroups: allOptions.rootGroups,
      isInSubmenu: false,
    });
  }

  const isActionsFilter = input.query.startsWith(">");
  const searchQuery = isActionsFilter ? input.query.slice(1) : input.query;
  const normalizedQuery = foldSearchQuery(searchQuery);

  if (normalizedQuery.length === 0) {
    if (isActionsFilter) {
      return input.activeGroups.filter((group) => group.value === "actions");
    }
    return [...input.activeGroups];
  }

  let baseGroups = [...input.activeGroups];
  if (isActionsFilter) {
    baseGroups = baseGroups.filter((group) => group.value === "actions");
  } else if (!input.isInSubmenu) {
    baseGroups = baseGroups.filter((group) => group.value !== "recent-threads");
  }

  const searchableGroups = [...baseGroups];
  const searchesEverything = !input.isInSubmenu && !isActionsFilter;
  // On equal match classes, groups keep this order: threads, what people search
  // for most, right after commands.
  if (searchesEverything) {
    if (input.allOptions && input.allOptions.nestedItems.length > 0) {
      searchableGroups.push({
        value: "nested-search",
        label: "Suggestions",
        items: input.allOptions.nestedItems,
      });
    }
    if (input.threadSearchItems.length > 0) {
      searchableGroups.push({
        value: "threads-search",
        label: "Threads",
        items: input.threadSearchItems,
      });
    }
    if (input.projectSearchItems.length > 0) {
      searchableGroups.push({
        value: "projects-search",
        label: "Projects",
        items: input.projectSearchItems,
      });
    }
    if (input.settingsSearchItems && input.settingsSearchItems.length > 0) {
      searchableGroups.push({
        value: "settings-search",
        label: "Settings",
        items: input.settingsSearchItems,
      });
    }
  }

  const now = input.now ?? Date.now();
  const ranked = rankSearchGroups(
    searchableGroups.map((group) => ({ group, items: group.items })),
    (item, options) => rankPaletteItem(item, normalizedQuery, now, options),
  );
  const threadsMatch = ranked.some(({ group }) => group.value === "threads-search");
  const groups = ranked.map(({ group, ranked }): CommandPaletteGroup => {
    // Secondary items stay below the rest; the sort is stable, so score order holds.
    const limit =
      group.value === "threads-search"
        ? PALETTE_THREAD_LIMIT
        : group.value === "nested-search" || (searchesEverything && threadsMatch)
          ? PALETTE_SECONDARY_LIMIT
          : ranked.length;
    // Hints are built only for the rows shown.
    const items = ranked
      .toSorted(
        (left, right) =>
          Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false),
      )
      .slice(0, limit)
      .map(({ item, match }) => {
        if (match.ranges.length > 0) return item;
        // Built only for the rows shown.
        const matchHint = match.explain?.();
        return matchHint ? { ...item, matchHint } : item;
      });
    return { value: group.value, label: group.label, items };
  });

  if (!searchesEverything) return groups;
  const listed = new Set(groups.flatMap((group) => group.items.map((item) => item.value)));
  // The items arrive cut to what the palette shows; see `nextShownOrder`.
  const messageItems = (input.threadMessageItems ?? []).filter((item) => !listed.has(item.value));
  return messageItems.length === 0
    ? groups
    : [...groups, { value: "threads-messages", label: "In messages", items: messageItems }];
}

/** Every option inside a submenu as one row, e.g. "New thread in lecturn" or "Change theme: Dracula". */
export function buildNestedSearchItems(
  items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>,
  query: string,
): CommandPaletteActionItem[] {
  const nameOf = (item: CommandPaletteItem) =>
    typeof item.title === "string" ? item.title : item.searchTitle;
  const topLevelNames = new Set(items.map(nameOf));
  const foldedQuery = foldSearchQuery(query);
  return items.flatMap((parent) => {
    if (parent.kind !== "submenu" || typeof parent.title !== "string") return [];
    const stem = parent.title.replace(/(\.\.\.|…)$/u, "");
    // A query that only names the submenu ("new thread in") wants the submenu row itself.
    if (foldSearchQuery(stem).startsWith(foldedQuery)) return [];
    const prefix = stem === parent.title ? `${stem}: ` : `${stem.trimEnd()} `;
    return parent.groups.flatMap((group) =>
      group.items.flatMap((child) => {
        const name = nameOf(child);
        if (child.kind !== "action" || name === undefined) return [];
        const title = `${prefix}${name}`;
        if (topLevelNames.has(title)) return [];
        const { searchTitle: _searchTitle, ...rest } = child;
        // Only the combined title: child keywords like "theme" would list every theme.
        return [{ ...rest, title, searchTerms: [title] }];
      }),
    );
  });
}

export function buildBrowseGroups(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  browseQuery: string;
  canBrowseUp: boolean;
  upIcon: ReactNode;
  directoryIcon: ReactNode;
  browseUp: () => void | Promise<void>;
  browseTo: (name: string) => void | Promise<void>;
}): CommandPaletteGroup[] {
  const items: CommandPaletteActionItem[] = [];

  if (input.canBrowseUp) {
    items.push({
      kind: "action",
      value: "browse:up",
      searchTerms: [input.browseQuery, ".."],
      title: "..",
      icon: input.upIcon,
      keepOpen: true,
      run: async () => {
        await input.browseUp();
      },
    });
  }

  for (const entry of input.browseEntries) {
    items.push({
      kind: "action",
      value: `browse:${entry.fullPath}`,
      searchTerms: [input.browseQuery, entry.fullPath, entry.name],
      title: entry.name,
      icon: input.directoryIcon,
      keepOpen: true,
      run: async () => {
        await input.browseTo(entry.name);
      },
    });
  }

  return [{ value: "directories", label: "Directories", items }];
}

export function filterPinnedBrowseEntries(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  filterQuery: string;
  pinnedDirectoryName: string;
  caseSensitive: boolean;
}): ReturnType<typeof filterFilesystemBrowseEntries> {
  const namesMatch = (left: string, right: string) =>
    input.caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase();
  const visibleFilterQuery = namesMatch(input.filterQuery, input.pinnedDirectoryName)
    ? ""
    : input.filterQuery;
  const { visibleEntries } = filterFilesystemBrowseEntries(input.browseEntries, visibleFilterQuery);
  const exactEntry =
    input.filterQuery.length > 0
      ? (input.browseEntries.find((entry) => namesMatch(entry.name, input.filterQuery)) ?? null)
      : null;
  return { visibleEntries, exactEntry };
}

export function getCommandPaletteMode(input: {
  currentView: CommandPaletteView | null;
  isBrowsing: boolean;
}): CommandPaletteMode {
  if (input.currentView) {
    return input.isBrowsing ? "submenu-browse" : "submenu";
  }
  return input.isBrowsing ? "root-browse" : "root";
}

export function buildRootGroups(input: {
  actionItems: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  recentThreadItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const groups: CommandPaletteGroup[] = [];
  if (input.actionItems.length > 0) {
    groups.push({ value: "actions", label: "Actions", items: input.actionItems });
  }
  if (input.recentThreadItems.length > 0) {
    groups.push({
      value: "recent-threads",
      label: "Recent Threads",
      items: input.recentThreadItems,
    });
  }
  return groups;
}

export function getCommandPaletteInputPlaceholder(mode: CommandPaletteMode): string {
  switch (mode) {
    case "root":
      return "Search commands, projects, and threads...";
    case "root-browse":
      return "Enter project path (e.g. ~/projects/my-app)";
    case "submenu":
      return "Search...";
    case "submenu-browse":
      return "Enter path (e.g. ~/projects/my-app)";
  }
}

export function getEnvironmentBrowsePlatform(os: string | null | undefined): string {
  if (os === "windows") {
    return "Win32";
  }
  if (os === "darwin") {
    return "MacIntel";
  }
  if (os === "linux") {
    return "Linux";
  }
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

export interface AddProjectEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
  readonly isPrimary: boolean;
  readonly isConnected: boolean;
  readonly status: string;
}

export type AddProjectCloneFlow =
  | {
      readonly step: "repository";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
    }
  | {
      readonly step: "confirm";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: SourceControlRepositoryInfo | null;
      readonly remoteUrl: string;
    };

export function remoteProjectInputPlaceholder(flow: AddProjectCloneFlow | null): string | null {
  if (!flow) return null;
  if (flow.step === "confirm") return null;
  if (flow.source === "url") {
    return "Enter Git clone URL";
  }
  return `Enter ${addProjectRemoteSourceLabel(flow.source)} repository (${addProjectRemoteSourcePathHint(flow.source)})`;
}

export function buildPaletteRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const readiness = buildAddProjectRemoteSourceReadiness(discovery);
  return (source) => {
    const entry = readiness(source);
    return entry.hint === null
      ? entry
      : {
          ...entry,
          hint: entry.hint.replace(
            "Open Source Control settings",
            "Open Settings -> Source Control",
          ),
        };
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "An error occurred.";
}

const OVERLAY_MODE_BY_COMMAND = {
  "commandPalette.toggle": "command",
  "filePicker.toggle": "files",
  "projectSearch.toggle": "content",
} as const satisfies Partial<Record<string, SearchOverlayMode>>;

export function overlayModeForCommand(command: string | null): SearchOverlayMode | null {
  if (command === null) return null;
  return command in OVERLAY_MODE_BY_COMMAND
    ? OVERLAY_MODE_BY_COMMAND[command as keyof typeof OVERLAY_MODE_BY_COMMAND]
    : null;
}
