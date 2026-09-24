import type { ExternalSessionSummary, ScopedProjectRef } from "@lecturn/contracts";
import { FolderIcon, FolderSearchIcon, GitBranchIcon, MessageSquareIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useImportThread } from "../hooks/useImportThread";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import { readEnvironmentProviders, readEnvironmentSupportsForking } from "../state/entities";
import { externalSessionsEnvironment } from "../state/externalSessions";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
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
  type ExternalSessionsInstanceResult,
  externalSessionMetadataParts,
  externalSessionSearchTerms,
  externalSessionTitle,
  IMPORT_SESSION_COST_NOTE,
  IMPORT_SESSION_LIST_LIMIT,
  IMPORT_SESSION_OTHER_FOLDER_REASON,
  IMPORT_SESSION_TRUNCATED_NOTE,
  IMPORT_SESSION_UNMATCHED_FOLDER_REASON,
  listImportCapableProviders,
  mergeExternalSessionResults,
  sessionRanOutsideFolder,
} from "./ImportSessionPalette.logic";
import { COMMAND_PALETTE_META_ICON_CLASS, CommandPaletteMetaDot } from "./ThreadCommandSubtitle";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";

/** The project the picker imports into, and whether it lists every folder instead of that project's. */
export interface ImportSessionScope {
  readonly projectRef: ScopedProjectRef;
  readonly allFolders: boolean;
}

/** Snapshot read, like fork availability: entry points evaluate it when they render or open. */
export function readCanImportSessions(environmentId: ScopedProjectRef["environmentId"]): boolean {
  return (
    listImportCapableProviders({
      supportsForking: readEnvironmentSupportsForking(environmentId),
      providers: readEnvironmentProviders(environmentId),
    }).length > 0
  );
}

function ExternalSessionSubtitle(props: {
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
  const listSessions = useAtomQueryRunner(externalSessionsEnvironment.list, {
    reportFailure: false,
    reportDefect: false,
  });
  const environmentId = scope?.projectRef.environmentId ?? null;
  const scopeProject =
    scope === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === scope.projectRef.environmentId &&
            project.id === scope.projectRef.projectId,
        ) ?? null);
  const listCwd = scope === null || scope.allFolders ? null : (scopeProject?.workspaceRoot ?? null);
  const providerEntries = useMemo(
    () =>
      environmentId === null
        ? []
        : deriveProviderInstanceEntries(
            listImportCapableProviders({
              supportsForking: readEnvironmentSupportsForking(environmentId),
              providers: readEnvironmentProviders(environmentId),
            }),
          ),
    [environmentId],
  );
  const requestKey =
    environmentId === null || scopeProject === null
      ? null
      : JSON.stringify([environmentId, listCwd, providerEntries.map((entry) => entry.instanceId)]);
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly merged: ReturnType<typeof mergeExternalSessionResults>;
  } | null>(null);

  useEffect(() => {
    if (requestKey === null || environmentId === null) return;
    let cancelled = false;
    void Promise.all(
      providerEntries.map(async (entry): Promise<ExternalSessionsInstanceResult> => {
        const providerInstanceId = entry.instanceId;
        try {
          const result = await listSessions({
            environmentId,
            input: {
              providerInstanceId,
              ...(listCwd === null ? {} : { cwd: listCwd }),
              limit: IMPORT_SESSION_LIST_LIMIT,
            },
          });
          return result._tag === "Success"
            ? { providerInstanceId, ok: true, ...result.value }
            : { providerInstanceId, ok: false };
        } catch {
          return { providerInstanceId, ok: false };
        }
      }),
    ).then((results) => {
      if (!cancelled) {
        setLoaded({ key: requestKey, merged: mergeExternalSessionResults(results) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, listCwd, listSessions, providerEntries, requestKey]);

  const merged = loaded !== null && loaded.key === requestKey ? loaded.merged : null;

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
    const failedNames = merged.failedInstanceIds.map(
      (instanceId) =>
        providerEntries.find((entry) => entry.instanceId === instanceId)?.displayName ?? instanceId,
    );
    return [
      ...(merged.sessions.length === 0
        ? [scope.allFolders ? "No sessions found." : "No sessions found for this project's folder."]
        : [IMPORT_SESSION_COST_NOTE]),
      ...failedNames.map((name) => `Could not load sessions from ${name}.`),
      ...(merged.truncated ? [IMPORT_SESSION_TRUNCATED_NOTE] : []),
    ];
  }, [merged, providerEntries, scope]);

  return {
    isLoading: requestKey !== null && merged === null,
    sessionGroups,
    trailingGroups,
    notes,
  };
}
