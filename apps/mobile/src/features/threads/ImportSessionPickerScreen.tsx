import { useAtomValue } from "@effect/atom-react";
import { resolveProviderInstanceDisplayName } from "@lecturn/client-runtime/state/provider-instance-display";
import { scopeProject } from "@lecturn/client-runtime/state/shell";
import type {
  ExternalSessionSummary,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
} from "@lecturn/contracts";
import { LegendList } from "@legendapp/list/react-native";
import { StackActions, useNavigation } from "@react-navigation/native";
import { Atom } from "effect/unstable/reactivity";
import * as Haptics from "expo-haptics";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { environmentProjects } from "../../state/projects";
import { externalSessionsEnvironment } from "../../state/externalSessions";
import { environmentThreadShells } from "../../state/threads";
import { getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { useNewTaskFlow } from "./new-task-flow-provider";
import {
  collectImportedSessionIds,
  createImportTargetResolver,
  externalSessionMetadataParts,
  externalSessionTitle,
  filterSessionRows,
  IMPORT_SESSION_COST_NOTE,
  IMPORT_SESSION_LIST_LIMIT,
  IMPORT_SESSION_OTHER_FOLDER_REASON,
  IMPORT_SESSION_TRUNCATED_NOTE,
  IMPORT_SESSION_UNMATCHED_FOLDER_REASON,
  mergeExternalSessionResults,
  resolveImportThreadModes,
  sessionRanOutsideFolder,
  THREAD_IMPORT_UNAVAILABLE_MESSAGES,
  type ExternalSessionsInstanceResult,
  type ImportTarget,
} from "./thread-import";
import { useImportThread, useThreadImportAvailability } from "./use-import-thread";

const SCREEN_TITLE = "Import session";
const SEARCH_PLACEHOLDER = "Find a session";

// Atom families are keyed by environment id, so a screen without a project
// reads these rather than minting a junk entry under an empty key.
const EMPTY_PROJECT_SHELLS = Atom.make<ReadonlyArray<OrchestrationProjectShell>>([]).pipe(
  Atom.withLabel("mobile-import-session:empty-projects"),
);
const EMPTY_THREAD_SHELLS = Atom.make<ReadonlyArray<OrchestrationThreadShell>>([]).pipe(
  Atom.withLabel("mobile-import-session:empty-threads"),
);

type SessionRowTarget = ImportTarget<OrchestrationProjectShell>;

interface SessionRow {
  readonly key: string;
  readonly session: ExternalSessionSummary;
  readonly title: string;
  readonly metadata: string;
  readonly target: SessionRowTarget;
}

const ExternalSessionRow = memo(function ExternalSessionRow(props: {
  readonly row: SessionRow;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly busy: boolean;
  readonly onSelect: (row: SessionRow) => void;
}) {
  const { row } = props;
  const blocked = row.target.kind === "blocked";
  const onPress = useCallback(() => props.onSelect(row), [props.onSelect, row]);

  return (
    <View
      className={cn(
        props.isFirst && "overflow-hidden rounded-t-2xl",
        props.isLast && "overflow-hidden rounded-b-2xl",
      )}
    >
      <Pressable
        accessibilityHint={blocked ? row.target.reason : undefined}
        accessibilityRole="button"
        accessibilityLabel={[row.title, row.metadata].filter(Boolean).join(", ")}
        className={cn(
          "min-h-14 gap-0.5 bg-card px-4 py-3 active:bg-subtle",
          !props.isLast && "border-b border-border-subtle",
        )}
        disabled={blocked || props.busy}
        onPress={onPress}
        style={{ opacity: blocked || props.busy ? 0.45 : 1 }}
      >
        <Text className="text-base font-lecturn-medium text-foreground" numberOfLines={1}>
          {row.title}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {blocked ? `${row.target.reason} · ${row.metadata}` : row.metadata}
        </Text>
      </Pressable>
    </View>
  );
});

function AllFoldersToggle(props: {
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View className="mb-3 overflow-hidden rounded-2xl">
      <View className="min-h-14 flex-row items-center gap-3 bg-card px-4 py-3">
        <Text
          className="min-w-0 flex-1 text-base font-lecturn-medium text-foreground"
          numberOfLines={1}
        >
          Show sessions from all folders
        </Text>
        <ThemedSwitch
          accessibilityLabel="Show sessions from all folders"
          onValueChange={props.onValueChange}
          value={props.value}
        />
      </View>
    </View>
  );
}

function PickerNotes(props: { readonly notes: ReadonlyArray<string> }) {
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

/**
 * Picks an external provider session to import into the new task's project.
 * Each instance is listed once per scope — a Codex list spawns a process
 * server-side, so the search field filters what is already on the device
 * rather than re-querying per keystroke.
 */
export function ImportSessionPickerRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const importThread = useImportThread();
  const listSessions = useAtomQueryRunner(externalSessionsEnvironment.list, {
    reportFailure: false,
    reportDefect: false,
  });

  const project = flow.selectedProject;
  const { draftKey, interactionMode, planModeEnabled, runtimeMode } = flow;
  const environmentId = project?.environmentId ?? null;
  const availability = useThreadImportAvailability(environmentId);
  const instances = availability.available ? availability.providers : null;

  const [searchQuery, setSearchQuery] = useState("");
  const [allFolders, setAllFolders] = useState(false);
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const importingRef = useRef(false);

  const listCwd = allFolders ? null : (project?.workspaceRoot ?? null);
  const instanceIds = useMemo(
    () => instances?.map((instance) => instance.instanceId) ?? null,
    [instances],
  );
  const providerLabelById = useMemo(
    () =>
      new Map(
        instances?.map(
          (instance) =>
            [instance.instanceId, resolveProviderInstanceDisplayName(instance)] as const,
        ),
      ),
    [instances],
  );
  const requestKey =
    environmentId === null || instanceIds === null || instanceIds.length === 0
      ? null
      : JSON.stringify([environmentId, listCwd, instanceIds]);

  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly merged: ReturnType<typeof mergeExternalSessionResults>;
  } | null>(null);

  useEffect(() => {
    if (requestKey === null || environmentId === null || instanceIds === null) return;
    let cancelled = false;
    void Promise.all(
      instanceIds.map(async (providerInstanceId): Promise<ExternalSessionsInstanceResult> => {
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
  }, [environmentId, instanceIds, listCwd, listSessions, requestKey]);

  const merged = loaded !== null && loaded.key === requestKey ? loaded.merged : null;
  const environmentProjectShells = useAtomValue(
    environmentId === null
      ? EMPTY_PROJECT_SHELLS
      : environmentProjects.environmentProjectsAtom(environmentId),
  );
  const environmentThreads = useAtomValue(
    environmentId === null
      ? EMPTY_THREAD_SHELLS
      : environmentThreadShells.environmentThreadsAtom(environmentId),
  );

  // Built once per fetch, ahead of the search. Rebuilding them per keystroke
  // would re-index every project and thread, re-derive each row's metadata,
  // and hand the memoized row component new props for rows that never changed.
  const allRows = useMemo((): ReadonlyArray<SessionRow> => {
    if (merged === null || project === null) return [];
    const importedSessionIds = collectImportedSessionIds(environmentThreads);
    const resolveTarget = createImportTargetResolver({
      projects: environmentProjectShells,
      threads: environmentThreads,
      unmatchedReason: allFolders
        ? IMPORT_SESSION_UNMATCHED_FOLDER_REASON
        : IMPORT_SESSION_OTHER_FOLDER_REASON,
    });
    return merged.sessions.map((session) => ({
      key: `${session.providerInstanceId}:${session.sessionId}`,
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
        folder: sessionRanOutsideFolder(session.cwd, project.workspaceRoot) ? session.cwd : null,
      }).join(" · "),
      target: resolveTarget(session.cwd),
    }));
  }, [
    allFolders,
    environmentProjectShells,
    environmentThreads,
    merged,
    project,
    providerLabelById,
  ]);

  const rows = useMemo(() => filterSessionRows(allRows, searchQuery), [allRows, searchQuery]);

  const notes = useMemo((): ReadonlyArray<string> => {
    if (merged === null) return [];
    return [
      ...(merged.sessions.length === 0 ? [] : [IMPORT_SESSION_COST_NOTE]),
      ...merged.failedInstanceIds.map(
        (instanceId) =>
          `Could not load sessions from ${providerLabelById.get(instanceId) ?? instanceId}.`,
      ),
      ...(merged.truncated ? [IMPORT_SESSION_TRUNCATED_NOTE] : []),
    ];
  }, [merged, providerLabelById]);

  const selectSession = useCallback(
    async (row: SessionRow) => {
      // The ref, not the state, is what rejects a second row tapped in the
      // same frame: both taps read the render's `importingKey` as null.
      if (row.target.kind !== "importable" || environmentId === null || importingRef.current) {
        return;
      }
      void Haptics.selectionAsync();
      importingRef.current = true;
      setImportingKey(row.key);
      try {
        // Read at tap time so the toolbar's latest permission and Plan/Build
        // choices carry over, the same sources the draft's send path reads.
        const draft = draftKey === null ? null : getComposerDraftSnapshot(draftKey);
        const imported = await importThread({
          session: row.session,
          project: scopeProject(environmentId, row.target.project),
          worktreePath: row.target.worktreePath,
          branch: row.target.branch,
          ...resolveImportThreadModes({
            draftRuntimeMode: draft?.runtimeMode,
            flowRuntimeMode: runtimeMode,
            draftInteractionMode: draft?.interactionMode,
            flowInteractionMode: interactionMode,
            planModeEnabled,
          }),
        });
        if (imported === null) return;
        // The Thread route renders its loading state until the imported
        // thread's shell arrives, matching the fork flow.
        (navigation.getParent() ?? navigation).dispatch(
          StackActions.replace("Thread", {
            environmentId: String(imported.environmentId),
            threadId: String(imported.threadId),
          }),
        );
      } finally {
        importingRef.current = false;
        setImportingKey(null);
      }
    },
    [
      draftKey,
      environmentId,
      importThread,
      interactionMode,
      navigation,
      planModeEnabled,
      runtimeMode,
    ],
  );

  const renderRow = useCallback(
    ({ item, index }: { readonly item: SessionRow; readonly index: number }) => (
      <ExternalSessionRow
        busy={importingKey !== null}
        isFirst={index === 0}
        isLast={index === rows.length - 1}
        onSelect={selectSession}
        row={item}
      />
    ),
    [importingKey, rows.length, selectSession],
  );

  const usesNativeMailSearchToolbar = Platform.OS === "ios" && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;
  const listContentStyle = useMemo(
    () => ({
      paddingBottom: usesNativeMailSearchToolbar
        ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET + 16
        : Platform.OS === "ios"
          ? 16
          : Math.max(insets.bottom, 16) + 16,
      paddingHorizontal: 16,
      paddingTop: 12,
    }),
    [insets.bottom, usesNativeMailSearchToolbar],
  );

  const listHeader = <AllFoldersToggle onValueChange={setAllFolders} value={allFolders} />;
  const emptyMessage = !availability.available
    ? THREAD_IMPORT_UNAVAILABLE_MESSAGES[availability.reason]
    : requestKey === null || merged === null
      ? "Loading sessions…"
      : searchQuery.trim().length > 0
        ? "No matching sessions"
        : allFolders
          ? "No sessions found."
          : "No sessions found for this project's folder.";

  const content =
    rows.length === 0 ? (
      <ScrollView
        className="flex-1 bg-sheet"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16, paddingTop: 12 }}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
      >
        {availability.available ? listHeader : null}
        <View
          className="flex-1 items-center justify-center gap-3 px-4"
          style={{
            marginBottom: usesNativeMailSearchToolbar
              ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET
              : 0,
          }}
        >
          {requestKey !== null && merged === null ? <ActivityIndicator /> : null}
          <Text className="text-center text-sm text-foreground-muted">{emptyMessage}</Text>
        </View>
        <PickerNotes notes={notes} />
      </ScrollView>
    ) : (
      <LegendList
        alwaysBounceVertical={false}
        automaticallyAdjustsScrollIndicatorInsets
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        className="flex-1 bg-sheet"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={listContentStyle}
        data={rows}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(row: SessionRow) => row.key}
        ListHeaderComponent={listHeader}
        ListFooterComponent={<PickerNotes notes={notes} />}
        renderItem={renderRow}
        showsVerticalScrollIndicator={false}
      />
    );

  if (Platform.OS === "android") {
    return (
      <View className="flex-1 bg-sheet" collapsable={false}>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader title={SCREEN_TITLE} onBack={() => navigation.goBack()} />
        <View className="px-4 pb-2 pt-3">
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            className="h-11 rounded-xl bg-card px-4 font-sans text-base text-foreground"
            onChangeText={setSearchQuery}
            placeholder={SEARCH_PLACEHOLDER}
            placeholderTextColorClassName={"accent-placeholder"}
            value={searchQuery}
          />
        </View>
        {content}
      </View>
    );
  }

  return (
    <>
      <NativeStackScreenOptions
        options={{
          headerShown: true,
          title: SCREEN_TITLE,
          unstable_headerToolbarItems: usesNativeMailSearchToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  onSearchTextChange: setSearchQuery,
                  placeholder: SEARCH_PLACEHOLDER,
                  searchTextChangeId: "import-session-search-text",
                  showsSearchDismissButton: true,
                }),
              ]
            : undefined,
          headerSearchBarOptions: usesNativeMailSearchToolbar
            ? undefined
            : {
                allowToolbarIntegration: true,
                autoCapitalize: "none",
                hideNavigationBar: false,
                obscureBackground: false,
                placeholder: SEARCH_PLACEHOLDER,
                onChangeText: (event) => {
                  setSearchQuery(event.nativeEvent.text);
                },
                onCancelButtonPress: () => {
                  setSearchQuery("");
                },
              },
        }}
      />
      {usesNativeMailSearchToolbar ? null : (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.SearchBarSlot />
        </NativeHeaderToolbar>
      )}
      {content}
    </>
  );
}
