import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import {
  bulkImportProgressLabel,
  bulkImportSummary,
  defaultImportSelection,
  externalSessionKey,
  groupExternalSessionsByFolder,
  importSessionsActionLabel,
  importSessionsSequentially,
  latestImported,
  sessionsInFolder,
  type ExternalSessionFolder,
} from "@lecturn/client-runtime/external-session-import";
import { resolveProviderInstanceDisplayName } from "@lecturn/client-runtime/state/provider-instance-display";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProjectId,
  type EnvironmentId,
  type ExternalSessionSummary,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProviderInstanceId,
} from "@lecturn/contracts";
import { LegendList } from "@legendapp/list/react-native";
import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProject } from "../../state/entities";
import { externalSessionsEnvironment } from "../../state/externalSessions";
import { environmentProjects } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  collectImportedSessionIds,
  externalSessionMetadataParts,
  externalSessionTitle,
  IMPORT_SESSION_COST_NOTE,
  IMPORT_SESSION_LIST_LIMIT,
  IMPORT_SESSION_TRUNCATED_NOTE,
  mergeExternalSessionResults,
  THREAD_IMPORT_UNAVAILABLE_MESSAGES,
  type ExternalSessionsInstanceResult,
} from "../threads/thread-import";
import { useImportThreadAttempt, useThreadImportAvailability } from "../threads/use-import-thread";
import {
  bulkImportFailureDetails,
  folderProviderCountsLabel,
} from "./AddProjectImportScreen.logic";
import { errorMessage, PrimaryActionButton, useDispatchProjectCreate } from "./AddProjectScreen";

// Atom families are keyed by environment id, so a screen without one reads
// these rather than minting a junk entry under an empty key.
const EMPTY_PROJECT_SHELLS = Atom.make<ReadonlyArray<OrchestrationProjectShell>>([]).pipe(
  Atom.withLabel("mobile-add-project-import:empty-projects"),
);
const EMPTY_THREAD_SHELLS = Atom.make<ReadonlyArray<OrchestrationThreadShell>>([]).pipe(
  Atom.withLabel("mobile-add-project-import:empty-threads"),
);

function stringParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Lists every import-capable instance's sessions once per screen visit (a
 * Codex list spawns a process server-side), scoped to `cwd` or machine-wide.
 */
function useExternalSessionListing(environmentId: EnvironmentId | null, cwd: string | null) {
  const availability = useThreadImportAvailability(environmentId);
  const listSessions = useAtomQueryRunner(externalSessionsEnvironment.list, {
    reportFailure: false,
    reportDefect: false,
  });
  const instances = availability.available ? availability.providers : null;
  // Server config updates hand back fresh provider arrays; only a changed
  // instance set warrants listing again.
  const instanceIdsKey = instances?.map((instance) => instance.instanceId).join("\n") ?? "";
  const instanceIds = useMemo(
    () =>
      instanceIdsKey === ""
        ? []
        : instanceIdsKey.split("\n").map((instanceId) => ProviderInstanceId.make(instanceId)),
    [instanceIdsKey],
  );
  const providerLabelById = useMemo(
    () =>
      new Map<ProviderInstanceId, string>(
        instances?.map(
          (instance) =>
            [instance.instanceId, resolveProviderInstanceDisplayName(instance)] as const,
        ),
      ),
    [instances],
  );
  const requestKey =
    environmentId === null || instanceIds.length === 0
      ? null
      : JSON.stringify([environmentId, cwd, instanceIds]);
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly merged: ReturnType<typeof mergeExternalSessionResults>;
  } | null>(null);

  useEffect(() => {
    if (requestKey === null || environmentId === null) return;
    let cancelled = false;
    void Promise.all(
      instanceIds.map(async (providerInstanceId): Promise<ExternalSessionsInstanceResult> => {
        try {
          const result = await listSessions({
            environmentId,
            input: {
              providerInstanceId,
              ...(cwd === null ? {} : { cwd }),
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
  }, [cwd, environmentId, instanceIds, listSessions, requestKey]);

  const merged = loaded !== null && loaded.key === requestKey ? loaded.merged : null;
  const notes = useMemo(
    (): ReadonlyArray<string> =>
      merged === null
        ? []
        : [
            ...merged.failedInstanceIds.map(
              (instanceId) =>
                `Could not load sessions from ${providerLabelById.get(instanceId) ?? instanceId}.`,
            ),
            ...(merged.truncated ? [IMPORT_SESSION_TRUNCATED_NOTE] : []),
          ],
    [merged, providerLabelById],
  );
  return { availability, merged, notes, providerLabelById };
}

function Notes(props: { readonly notes: ReadonlyArray<string> }) {
  if (props.notes.length === 0) return null;
  return (
    <View className="gap-1.5 px-1 pt-3">
      {props.notes.map((note) => (
        <Text className="text-xs text-foreground-muted" key={note}>
          {note}
        </Text>
      ))}
    </View>
  );
}

function ListState(props: {
  readonly loading: boolean;
  readonly message: string;
  readonly notes: ReadonlyArray<string>;
}) {
  return (
    <View className="flex-1 bg-sheet px-4 pt-3">
      <View className="flex-1 items-center justify-center gap-3 px-4">
        {props.loading ? <ActivityIndicator /> : null}
        <Text className="text-center text-sm text-foreground-muted">{props.message}</Text>
      </View>
      <Notes notes={props.notes} />
    </View>
  );
}

function GroupedRow(props: {
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly disabled: boolean;
  readonly accessibilityLabel: string;
  readonly accessibilityState?: { readonly checked: boolean };
  readonly accessibilityRole: "button" | "checkbox";
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <View
      className={cn(
        props.isFirst && "overflow-hidden rounded-t-2xl",
        props.isLast && "overflow-hidden rounded-b-2xl",
      )}
    >
      <Pressable
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole={props.accessibilityRole}
        accessibilityState={props.accessibilityState}
        className={cn(
          "min-h-14 flex-row items-center gap-3 bg-card px-4 py-3 active:bg-subtle",
          !props.isLast && "border-b border-border-subtle",
        )}
        disabled={props.disabled}
        onPress={props.onPress}
        style={{ opacity: props.disabled ? 0.45 : 1 }}
      >
        {props.children}
      </Pressable>
    </View>
  );
}

interface FolderRowModel {
  readonly key: string;
  readonly folder: ExternalSessionFolder<OrchestrationProjectShell>;
  readonly metadata: string;
}

const FolderRow = memo(function FolderRow(props: {
  readonly row: FolderRowModel;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly busy: boolean;
  readonly adding: boolean;
  readonly onSelect: (folder: ExternalSessionFolder<OrchestrationProjectShell>) => void;
}) {
  const { onSelect } = props;
  const { folder } = props.row;
  const onPress = useCallback(() => onSelect(folder), [folder, onSelect]);
  return (
    <GroupedRow
      accessibilityLabel={[folder.name, folder.cwd, props.row.metadata].join(", ")}
      accessibilityRole="button"
      disabled={props.busy}
      isFirst={props.isFirst}
      isLast={props.isLast}
      onPress={onPress}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="shrink text-base font-lecturn-medium text-foreground" numberOfLines={1}>
            {folder.name}
          </Text>
          {folder.project !== null ? (
            <View className="rounded-full bg-subtle px-2 py-0.5">
              <Text className="text-2xs font-lecturn-medium text-foreground-muted">
                Already a project
              </Text>
            </View>
          ) : null}
        </View>
        <Text className="text-xs text-foreground-muted" numberOfLines={1} ellipsizeMode="middle">
          {folder.cwd}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {props.row.metadata}
        </Text>
      </View>
      {props.adding ? (
        <ActivityIndicator colorClassName={"accent-icon-muted"} />
      ) : (
        <SymbolView
          name="chevron.right"
          size={13}
          tintColorClassName={"accent-chevron"}
          type="monochrome"
        />
      )}
    </GroupedRow>
  );
});

/**
 * "From Claude Code or Codex": every folder the environment's agents have run
 * sessions in. Picking one adds it as a project (unless it already is one) and
 * moves on to choosing which of its sessions to import.
 */
export function AddProjectImportFoldersScreen(props: {
  readonly environmentId?: string | string[];
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = stringParam(props.environmentId) as EnvironmentId | null;
  const { availability, merged, notes, providerLabelById } = useExternalSessionListing(
    environmentId,
    null,
  );
  const projects = useAtomValue(
    environmentId === null
      ? EMPTY_PROJECT_SHELLS
      : environmentProjects.environmentProjectsAtom(environmentId),
  );
  const dispatchProjectCreate = useDispatchProjectCreate();
  const [addingCwd, setAddingCwd] = useState<string | null>(null);
  const addingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(
    (): ReadonlyArray<FolderRowModel> =>
      merged === null
        ? []
        : groupExternalSessionsByFolder({ sessions: merged.sessions, projects }).map((folder) => ({
            key: folder.cwd,
            folder,
            metadata: [
              folderProviderCountsLabel(folder.providerCounts, providerLabelById),
              relativeTime(folder.latestUpdatedAt),
            ].join(" · "),
          })),
    [merged, projects, providerLabelById],
  );

  const selectFolder = useCallback(
    async (folder: ExternalSessionFolder<OrchestrationProjectShell>) => {
      // The ref, not the state, rejects a second row tapped in the same frame.
      if (environmentId === null || addingRef.current) return;
      setError(null);
      const openSessions = (projectId: ProjectId) =>
        navigation.dispatch(
          StackActions.push("AddProjectImportSessions", {
            environmentId,
            projectId,
            cwd: folder.cwd,
          }),
        );
      if (folder.project !== null) {
        openSessions(folder.project.id);
        return;
      }
      addingRef.current = true;
      setAddingCwd(folder.cwd);
      try {
        const { projectId, result } = await dispatchProjectCreate({
          environmentId,
          workspaceRoot: folder.cwd,
        });
        if (AsyncResult.isFailure(result)) {
          setError(errorMessage(Cause.squash(result.cause)));
          return;
        }
        openSessions(projectId);
      } finally {
        addingRef.current = false;
        setAddingCwd(null);
      }
    },
    [dispatchProjectCreate, environmentId, navigation],
  );

  const renderRow = useCallback(
    ({ item, index }: { readonly item: FolderRowModel; readonly index: number }) => (
      <FolderRow
        adding={addingCwd === item.folder.cwd}
        busy={addingCwd !== null}
        isFirst={index === 0}
        isLast={index === rows.length - 1}
        onSelect={selectFolder}
        row={item}
      />
    ),
    [addingCwd, rows.length, selectFolder],
  );

  if (rows.length === 0) {
    return (
      <ListState
        loading={availability.available && merged === null}
        message={
          !availability.available
            ? THREAD_IMPORT_UNAVAILABLE_MESSAGES[availability.reason]
            : merged === null
              ? "Loading sessions…"
              : "No sessions found."
        }
        notes={notes}
      />
    );
  }

  return (
    <LegendList
      alwaysBounceVertical={false}
      automaticallyAdjustsScrollIndicatorInsets
      className="flex-1 bg-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        paddingBottom: Math.max(insets.bottom, 16) + 16,
        paddingHorizontal: 16,
        paddingTop: 12,
      }}
      data={rows}
      keyExtractor={(row: FolderRowModel) => row.key}
      ListHeaderComponent={
        error ? (
          <View className="mb-3">
            <ErrorBanner message={error} />
          </View>
        ) : null
      }
      ListFooterComponent={<Notes notes={notes} />}
      renderItem={renderRow}
      showsVerticalScrollIndicator={false}
    />
  );
}

interface SessionRowModel {
  readonly key: string;
  readonly session: ExternalSessionSummary;
  readonly title: string;
  readonly metadata: string;
}

const SessionCheckboxRow = memo(function SessionCheckboxRow(props: {
  readonly row: SessionRowModel;
  readonly checked: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly disabled: boolean;
  readonly onToggle: (key: string) => void;
}) {
  const { onToggle, row } = props;
  const onPress = useCallback(() => onToggle(row.key), [onToggle, row.key]);
  return (
    <GroupedRow
      accessibilityLabel={[row.title, row.metadata].join(", ")}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.checked }}
      disabled={props.disabled}
      isFirst={props.isFirst}
      isLast={props.isLast}
      onPress={onPress}
    >
      {props.checked ? (
        <View className="h-6 w-6 items-center justify-center rounded-full bg-primary">
          <SymbolView
            name="checkmark"
            size={12}
            tintColorClassName={"accent-primary-foreground"}
            type="monochrome"
          />
        </View>
      ) : (
        <View className="h-6 w-6 rounded-full border border-border" />
      )}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-lecturn-medium text-foreground" numberOfLines={1}>
          {row.title}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {row.metadata}
        </Text>
      </View>
    </GroupedRow>
  );
});

function SelectionControls(props: {
  readonly disabled: boolean;
  readonly onSelectAll: () => void;
  readonly onSelectNone: () => void;
}) {
  return (
    <View className="flex-row justify-end gap-4 px-1 pb-2">
      {[
        { label: "Select all", onPress: props.onSelectAll },
        { label: "Select none", onPress: props.onSelectNone },
      ].map((control) => (
        <Pressable
          accessibilityRole="button"
          className="py-1 active:opacity-70"
          disabled={props.disabled}
          key={control.label}
          onPress={control.onPress}
          style={{ opacity: props.disabled ? 0.45 : 1 }}
        >
          <Text className="text-sm font-lecturn-medium text-foreground">{control.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Chooses which of a folder's sessions to import into its project, then
 * imports them one at a time and opens the most recent one.
 */
export function AddProjectImportSessionsScreen(props: {
  readonly environmentId?: string | string[];
  readonly projectId?: string | string[];
  readonly cwd?: string | string[];
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const importThread = useImportThreadAttempt();
  const environmentId = stringParam(props.environmentId) as EnvironmentId | null;
  const projectIdParam = stringParam(props.projectId);
  const cwd = stringParam(props.cwd) ?? "";
  const projectRef = useMemo(
    () =>
      environmentId === null || projectIdParam === null
        ? null
        : scopeProjectRef(environmentId, ProjectId.make(projectIdParam)),
    [environmentId, projectIdParam],
  );
  // A just-created project's shell lands shortly after its command succeeds.
  const project = useProject(projectRef);
  const { availability, merged, notes, providerLabelById } = useExternalSessionListing(
    environmentId,
    cwd,
  );
  const threads = useAtomValue(
    environmentId === null
      ? EMPTY_THREAD_SHELLS
      : environmentThreadShells.environmentThreadsAtom(environmentId),
  );
  const importedSessionIds = useMemo(() => collectImportedSessionIds(threads), [threads]);
  const sessions = useMemo(
    () => (merged === null ? null : sessionsInFolder(merged.sessions, cwd)),
    [cwd, merged],
  );
  const rows = useMemo(
    (): ReadonlyArray<SessionRowModel> =>
      sessions?.map((session) => ({
        key: externalSessionKey(session),
        session,
        title: externalSessionTitle(session),
        metadata: externalSessionMetadataParts({
          providerLabel:
            providerLabelById.get(session.providerInstanceId) ?? String(session.driverKind),
          origin: session.origin,
          updatedLabel: relativeTime(session.updatedAt),
          sizeBytes: session.sizeBytes,
          imported: importedSessionIds.has(session.sessionId),
          gitBranch: session.gitBranch ?? null,
          folder: null,
        }).join(" · "),
      })) ?? [],
    [importedSessionIds, providerLabelById, sessions],
  );

  // Null until the user changes it, so the recent-and-not-imported default
  // applies as soon as the list arrives.
  const [chosenKeys, setChosenKeys] = useState<ReadonlySet<string> | null>(null);
  const [openedAt] = useState(Date.now);
  const defaultKeys = useMemo(
    () =>
      sessions === null
        ? new Set<string>()
        : defaultImportSelection({ sessions, importedSessionIds, now: openedAt }),
    [importedSessionIds, openedAt, sessions],
  );
  const selectedKeys = chosenKeys ?? defaultKeys;
  const [progress, setProgress] = useState<{
    readonly position: number;
    readonly total: number;
  } | null>(null);
  const importingRef = useRef(false);
  const importing = progress !== null;

  const toggle = useCallback(
    (key: string) => {
      setChosenKeys((current) => {
        const next = new Set(current ?? defaultKeys);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [defaultKeys],
  );
  const selectAll = useCallback(() => setChosenKeys(new Set(rows.map((row) => row.key))), [rows]);
  const selectNone = useCallback(() => setChosenKeys(new Set()), []);

  const selectedSessions = useMemo(
    () => rows.filter((row) => selectedKeys.has(row.key)).map((row) => row.session),
    [rows, selectedKeys],
  );

  const runImport = useCallback(async () => {
    if (project === null || selectedSessions.length === 0 || importingRef.current) return;
    importingRef.current = true;
    setProgress({ position: 1, total: selectedSessions.length });
    try {
      const result = await importSessionsSequentially({
        sessions: selectedSessions,
        importSession: async (session) => {
          const attempt = await importThread({
            session,
            project,
            worktreePath: null,
            branch: null,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          });
          return attempt.ok
            ? attempt
            : { ok: false, message: attempt.message ?? "The session could not be imported." };
        },
        onProgress: setProgress,
      });
      if (result.failed.length > 0) {
        const summary = bulkImportSummary(result);
        Alert.alert(
          summary.title,
          bulkImportFailureDetails(
            summary.description,
            result.failed.map((failure) => ({
              title: externalSessionTitle(failure.session),
              message: failure.message,
            })),
          ),
        );
      }
      const thread = latestImported(result.imported);
      if (thread !== null) {
        // The Thread route renders its loading state until the imported
        // thread's shell arrives, matching the single-session picker.
        (navigation.getParent() ?? navigation).dispatch(
          StackActions.replace("Thread", {
            environmentId: String(thread.environmentId),
            threadId: String(thread.threadId),
          }),
        );
      } else {
        navigation.dispatch(
          CommonActions.reset({
            index: 0,
            routes: [
              {
                name: "NewTaskDraft",
                params: {
                  environmentId: project.environmentId,
                  projectId: project.id,
                  title: project.title,
                },
              },
            ],
          }),
        );
      }
    } finally {
      importingRef.current = false;
      setProgress(null);
    }
  }, [importThread, navigation, project, selectedSessions]);

  const renderRow = useCallback(
    ({ item, index }: { readonly item: SessionRowModel; readonly index: number }) => (
      <SessionCheckboxRow
        checked={selectedKeys.has(item.key)}
        disabled={importing}
        isFirst={index === 0}
        isLast={index === rows.length - 1}
        onToggle={toggle}
        row={item}
      />
    ),
    [importing, rows.length, selectedKeys, toggle],
  );

  const screenOptions = (
    <NativeStackScreenOptions
      options={{ gestureEnabled: !importing, headerBackVisible: !importing }}
    />
  );

  if (rows.length === 0) {
    return (
      <>
        {screenOptions}
        <ListState
          loading={availability.available && merged === null}
          message={
            !availability.available
              ? THREAD_IMPORT_UNAVAILABLE_MESSAGES[availability.reason]
              : merged === null
                ? "Loading sessions…"
                : "No sessions found."
          }
          notes={notes}
        />
      </>
    );
  }

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      {screenOptions}
      <LegendList
        alwaysBounceVertical={false}
        automaticallyAdjustsScrollIndicatorInsets
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 16, paddingHorizontal: 16, paddingTop: 12 }}
        data={rows}
        extraData={selectedKeys}
        keyExtractor={(row: SessionRowModel) => row.key}
        ListHeaderComponent={
          <SelectionControls
            disabled={importing}
            onSelectAll={selectAll}
            onSelectNone={selectNone}
          />
        }
        ListFooterComponent={<Notes notes={[IMPORT_SESSION_COST_NOTE, ...notes]} />}
        renderItem={renderRow}
        showsVerticalScrollIndicator={false}
      />
      <View
        className="gap-2 border-t border-border-subtle px-4 pt-3"
        style={{ paddingBottom: Math.max(insets.bottom, 16) }}
      >
        {progress !== null ? (
          <Text className="text-center text-sm text-foreground-muted">
            {bulkImportProgressLabel(progress)}
          </Text>
        ) : project === null ? (
          <Text className="text-center text-sm text-foreground-muted">Adding project…</Text>
        ) : null}
        <PrimaryActionButton
          disabled={importing || project === null || selectedSessions.length === 0}
          label={importSessionsActionLabel(selectedSessions.length)}
          loading={importing}
          onPress={() => void runImport()}
        />
      </View>
    </View>
  );
}
