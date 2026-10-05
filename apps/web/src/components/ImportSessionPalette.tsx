import {
  type ExternalSessionFolder,
  groupExternalSessionsByFolder,
} from "@lecturn/client-runtime/external-session-import";
import type {
  EnvironmentId,
  ExternalSessionSummary,
  ProviderDriverKind,
  ScopedProjectRef,
} from "@lecturn/contracts";
import { FolderIcon, FolderSearchIcon, GitBranchIcon, MessageSquareIcon } from "lucide-react";
import { useMemo } from "react";

import { externalSessionListNotes, useExternalSessionList } from "../hooks/useExternalSessionList";
import { useImportThread } from "../hooks/useImportThread";
import type { ProviderInstanceEntry } from "../providerInstances";
import { readEnvironmentProviders, readEnvironmentSupportsForking } from "../state/entities";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { Project, ThreadShell } from "../types";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  ITEM_ICON_CLASS,
} from "./CommandPalette.logic";
import {
  collectImportedSessionIds,
  createImportTargetResolver,
  externalSessionMetadataParts,
  externalSessionSearchTerms,
  externalSessionTitle,
  IMPORT_FOLDERS_TRUNCATED_NOTE,
  IMPORT_SESSION_COST_NOTE,
  IMPORT_SESSION_OTHER_FOLDER_REASON,
  IMPORT_SESSION_TRUNCATED_NOTE,
  IMPORT_SESSION_UNMATCHED_FOLDER_REASON,
  listImportCapableProviders,
  sessionRanOutsideFolder,
} from "./ImportSessionPalette.logic";
import { COMMAND_PALETTE_META_ICON_CLASS, CommandPaletteMetaDot } from "./ThreadCommandSubtitle";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";

/** The project the picker imports into, and whether it lists every folder instead of that project's. */
export interface ImportSessionScope {
  readonly projectRef: ScopedProjectRef;
  readonly allFolders: boolean;
}

/**
 * Driver kinds of the instances whose sessions can be imported. Snapshot read,
 * like fork availability: entry points evaluate it when they render or open.
 */
export function readImportCapableDriverKinds(
  environmentId: EnvironmentId,
): ReadonlyArray<ProviderDriverKind> {
  return listImportCapableProviders({
    supportsForking: readEnvironmentSupportsForking(environmentId),
    providers: readEnvironmentProviders(environmentId),
  }).map((provider) => provider.driver);
}

export function readCanImportSessions(environmentId: EnvironmentId): boolean {
  return readImportCapableDriverKinds(environmentId).length > 0;
}

export function ExternalSessionSubtitle(props: {
  session: ExternalSessionSummary;
  provider: ProviderInstanceEntry | undefined;
  imported: boolean;
  blockedReason: string | null;
  showFolder: boolean;
}) {
  const { session } = props;
  const parts = externalSessionMetadataParts({
    origin: session.origin,
    updatedLabel: formatRelativeTimeLabel(session.updatedAt),
    sizeBytes: session.sizeBytes,
    imported: props.imported,
  });
  return (
    <span className="flex min-w-0 max-w-full items-center gap-1">
      {props.blockedReason ? (
        <>
          <span className="shrink-0">{props.blockedReason}</span>
          <CommandPaletteMetaDot />
        </>
      ) : null}
      <span className="inline-flex shrink-0 items-center gap-1">
        <ProviderInstanceIcon
          driverKind={session.driverKind}
          displayName={props.provider?.displayName ?? session.driverKind}
          iconClassName="size-3 shrink-0 opacity-70"
        />
        <span>{props.provider?.displayName ?? session.driverKind}</span>
      </span>
      {parts.map((part) => (
        <span className="inline-flex shrink-0 items-center gap-1" key={part}>
          <CommandPaletteMetaDot />
          <span>{part}</span>
        </span>
      ))}
      {session.gitBranch ? (
        <span className="inline-flex min-w-0 items-center gap-1">
          <CommandPaletteMetaDot />
          <GitBranchIcon className={COMMAND_PALETTE_META_ICON_CLASS} aria-hidden />
          <span className="min-w-0 truncate">{session.gitBranch}</span>
        </span>
      ) : null}
      {props.showFolder ? (
        <span className="inline-flex min-w-0 items-center gap-1">
          <CommandPaletteMetaDot />
          <FolderIcon className={COMMAND_PALETTE_META_ICON_CLASS} aria-hidden />
          <span className="min-w-0 truncate">{session.cwd}</span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * Live content of the palette's import-session view. Lists every
 * import-capable instance once per scope (no search term: the palette filters
 * `sessionGroups` client-side, so typing never reaches the server) and leaves
 * `trailingGroups` and `notes` outside that filter. Inactive while `scope` is
 * null.
 */
export function useImportSessionPalette(input: {
  readonly scope: ImportSessionScope | null;
  readonly projects: ReadonlyArray<Project>;
  readonly threads: ReadonlyArray<ThreadShell>;
  readonly onToggleAllFolders: () => void;
}): {
  readonly isLoading: boolean;
  readonly sessionGroups: ReadonlyArray<CommandPaletteGroup>;
  readonly trailingGroups: ReadonlyArray<CommandPaletteGroup>;
  readonly notes: ReadonlyArray<string>;
} {
  const { onToggleAllFolders, projects, scope, threads } = input;
  const importThread = useImportThread();
  const scopeProject =
    scope === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === scope.projectRef.environmentId &&
            project.id === scope.projectRef.projectId,
        ) ?? null);
  const listCwd = scope === null || scope.allFolders ? null : (scopeProject?.workspaceRoot ?? null);
  const { merged, providerEntries, isLoading } = useExternalSessionList({
    environmentId: scopeProject === null ? null : scopeProject.environmentId,
    cwd: listCwd,
  });

  const sessionGroups = useMemo((): ReadonlyArray<CommandPaletteGroup> => {
    if (merged === null || scope === null || merged.sessions.length === 0) return [];
    const environmentProjects = projects.filter(
      (project) => project.environmentId === scope.projectRef.environmentId,
    );
    const environmentThreads = threads.filter(
      (thread) => thread.environmentId === scope.projectRef.environmentId,
    );
    const importedSessionIds = collectImportedSessionIds(environmentThreads);
    const resolveTarget = createImportTargetResolver({
      projects: environmentProjects,
      threads: environmentThreads,
      unmatchedReason: scope.allFolders
        ? IMPORT_SESSION_UNMATCHED_FOLDER_REASON
        : IMPORT_SESSION_OTHER_FOLDER_REASON,
    });
    const items = merged.sessions.map((session): CommandPaletteActionItem => {
      const target = resolveTarget(session.cwd);
      return {
        kind: "action",
        value: `import-session:${session.providerInstanceId}:${session.sessionId}`,
        searchTerms: externalSessionSearchTerms(session),
        title: externalSessionTitle(session),
        description: (
          <ExternalSessionSubtitle
            session={session}
            provider={providerEntries.find(
              (entry) => entry.instanceId === session.providerInstanceId,
            )}
            imported={importedSessionIds.has(session.sessionId)}
            blockedReason={target.kind === "blocked" ? target.reason : null}
            showFolder={
              scopeProject === null ||
              sessionRanOutsideFolder(session.cwd, scopeProject.workspaceRoot)
            }
          />
        ),
        icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
        disabled: target.kind === "blocked",
        run: async () => {
          if (target.kind !== "importable") return;
          await importThread({
            session,
            project: target.project,
            worktreePath: target.worktreePath,
            branch: target.branch,
          });
        },
      };
    });
    return [{ value: "import-sessions", label: "Sessions", items }];
  }, [importThread, merged, projects, providerEntries, scope, scopeProject, threads]);

  const trailingGroups = useMemo((): ReadonlyArray<CommandPaletteGroup> => {
    if (merged === null || scope === null) return [];
    return [
      {
        value: "import-session-folders",
        label: "Folders",
        items: [
          {
            kind: "action",
            value: "import-session:toggle-all-folders",
            searchTerms: [],
            title: scope.allFolders
              ? `Show only sessions from ${scopeProject?.title ?? "this project"}`
              : "Show sessions from all folders",
            icon: <FolderSearchIcon className={ITEM_ICON_CLASS} />,
            keepOpen: true,
            run: async () => {
              onToggleAllFolders();
            },
          },
        ],
      },
    ];
  }, [merged, onToggleAllFolders, scope, scopeProject?.title]);

  const notes = useMemo(() => {
    if (merged === null || scope === null) return [];
    return [
      ...(merged.sessions.length === 0
        ? [scope.allFolders ? "No sessions found." : "No sessions found for this project's folder."]
        : [IMPORT_SESSION_COST_NOTE]),
      ...externalSessionListNotes({
        merged,
        providerEntries,
        truncatedNote: IMPORT_SESSION_TRUNCATED_NOTE,
      }),
    ];
  }, [merged, providerEntries, scope]);

  return { isLoading, sessionGroups, trailingGroups, notes };
}

function ExternalSessionFolderSubtitle(props: {
  folder: ExternalSessionFolder<Project>;
  providerEntries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const { folder } = props;
  const updatedLabel = formatRelativeTimeLabel(folder.latestUpdatedAt);
  return (
    <span className="flex min-w-0 max-w-full items-center gap-1">
      {folder.project ? (
        <>
          <span className="shrink-0">Already a project</span>
          <CommandPaletteMetaDot />
        </>
      ) : null}
      {folder.providerCounts.map((count, index) => {
        const displayName =
          props.providerEntries.find((entry) => entry.instanceId === count.providerInstanceId)
            ?.displayName ?? count.driverKind;
        return (
          <span className="inline-flex shrink-0 items-center gap-1" key={count.providerInstanceId}>
            {index > 0 ? <CommandPaletteMetaDot /> : null}
            <ProviderInstanceIcon
              driverKind={count.driverKind}
              displayName={displayName}
              iconClassName="size-3 shrink-0 opacity-70"
            />
            <span>{`${displayName} (${count.count})`}</span>
          </span>
        );
      })}
      {updatedLabel ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          <CommandPaletteMetaDot />
          <span>{updatedLabel}</span>
        </span>
      ) : null}
      <span className="inline-flex min-w-0 items-center gap-1">
        <CommandPaletteMetaDot />
        <FolderIcon className={COMMAND_PALETTE_META_ICON_CLASS} aria-hidden />
        <span className="min-w-0 truncate">{folder.cwd}</span>
      </span>
    </span>
  );
}

/**
 * Live content of the add-project "From Claude Code or Codex" view: every
 * folder the environment's import-capable instances have sessions in, newest
 * activity first. Lists once per environment while `environmentId` is set;
 * the palette filters `folderGroups` client-side.
 */
export function useImportFolderPalette(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projects: ReadonlyArray<Project>;
  readonly onPickFolder: (folder: ExternalSessionFolder<Project>) => Promise<void>;
}): {
  readonly isLoading: boolean;
  readonly folderGroups: ReadonlyArray<CommandPaletteGroup>;
  readonly notes: ReadonlyArray<string>;
} {
  const { environmentId, onPickFolder, projects } = input;
  const { merged, providerEntries, isLoading } = useExternalSessionList({
    environmentId,
    cwd: null,
  });

  const folderGroups = useMemo((): ReadonlyArray<CommandPaletteGroup> => {
    if (merged === null || environmentId === null || merged.sessions.length === 0) return [];
    const folders = groupExternalSessionsByFolder({
      sessions: merged.sessions,
      projects: projects.filter((project) => project.environmentId === environmentId),
    });
    const items = folders.map((folder): CommandPaletteActionItem => ({
      kind: "action",
      value: `import-folder:${folder.cwd}`,
      searchTerms: [folder.name, folder.cwd],
      title: folder.name,
      description: (
        <ExternalSessionFolderSubtitle folder={folder} providerEntries={providerEntries} />
      ),
      icon: <FolderIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: () => onPickFolder(folder),
    }));
    return [{ value: "import-folders", label: "Folders", items }];
  }, [environmentId, merged, onPickFolder, projects, providerEntries]);

  const notes = useMemo(() => {
    if (merged === null || environmentId === null) return [];
    return [
      ...(merged.sessions.length === 0 ? ["No sessions found."] : []),
      ...externalSessionListNotes({
        merged,
        providerEntries,
        truncatedNote: IMPORT_FOLDERS_TRUNCATED_NOTE,
      }),
    ];
  }, [environmentId, merged, providerEntries]);

  return { isLoading, folderGroups, notes };
}
