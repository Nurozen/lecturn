import { useAtomValue } from "@effect/atom-react";
import { filterStaveRepoRows } from "@lecturn/client-runtime/stave-repo-filter";
import {
  describeOperationError,
  formatPhaseDuration,
  outputLineText,
  overallStatusLabel,
  phaseStatus,
  type StavePhaseStatus,
} from "@lecturn/client-runtime/state/stave-operation-progress";
import {
  buildCreateSagaOperation,
  buildCreateSpaceOperation,
  canCreateSpace,
  createInitialSagaWizardState,
  createInitialWizardState,
  EMPTY_WIZARD_CONTEXT,
  sagaIdOf,
  setRepoMode,
  setSaga,
  STAVE_SPACE_KIND_CHIPS,
  joinableSagas,
  syncRepoRows,
  updateWizardState,
  validateSagaWizard,
  validateSpaceId,
  type StaveSagaWizardState,
  type StaveSpaceWizardState,
  type StaveWizardContext,
  type StaveWizardRepoMode,
  type StaveWizardRepoRow,
} from "@lecturn/client-runtime/state/stave-space-wizard";
import {
  deleteStaveArchive,
  existingStaveSpaceDetail,
  existingStaveSpaces,
  restoreStaveArchive,
  type ExistingStaveSpace,
  type ExistingStaveSpaceKind,
  type StaveArchiveTaskState,
} from "@lecturn/client-runtime/state/stave-archive";
import type { EnvironmentId, ProjectId, StaveOperation } from "@lecturn/contracts";
import { CommonActions, useNavigation } from "@react-navigation/native";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { GlassCard } from "../../components/GlassCard";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import { uuidv4 } from "../../lib/uuid";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import {
  mobileStaveArchiveClient,
  staveOperations,
  staveRepos,
  staveSagas,
  staveSpaces,
  useStaveCreateSources,
  waitForStaveProjectVisible,
} from "../../state/stave";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AddProjectShell,
  EmptyEnvironmentState,
  errorMessage,
  ListRow,
  ListSection,
  PrimaryActionButton,
  SectionTitle,
  useDispatchProjectCreate,
  useEnvironmentFromParam,
} from "./AddProjectScreen";

/**
 * Mobile "New Stave space" / "New Stave saga": one scrolling form each over
 * the same pure wizard rules as web, then the streamed operation's progress.
 * Deliberately smaller than the web wizard: no memory, custom kinds, edit
 * bases, reference pins, land-after ordering, dry-run preview or inline repo
 * registration.
 */

/** No operation started yet: the placeholder atom stays `idle`. */
const IDLE_OPERATION_ID = "mobile-stave-create:idle";

const MOBILE_KIND_CHIPS = STAVE_SPACE_KIND_CHIPS.filter((chip) => chip !== "custom");

const EMPTY: ReadonlyArray<never> = [];

/** Registry, spaces (live + archived, for id validation) and sagas. */
function useStaveCreateContext(environmentId: EnvironmentId | null) {
  const repos = useEnvironmentQuery(
    environmentId === null ? null : staveRepos({ environmentId, input: {} }),
  );
  const spaces = useEnvironmentQuery(
    environmentId === null
      ? null
      : staveSpaces({ environmentId, input: { includeArchived: true } }),
  );
  const sagas = useEnvironmentQuery(
    environmentId === null ? null : staveSagas({ environmentId, input: {} }),
  );
  const repoRows = repos.data ?? EMPTY;
  const spaceRows = spaces.data ?? EMPTY;
  const sagaRows = useMemo(() => joinableSagas(sagas.data ?? EMPTY), [sagas.data]);
  const context = useMemo<StaveWizardContext>(
    () => ({ ...EMPTY_WIZARD_CONTEXT, repos: repoRows, spaces: spaceRows, sagas: sagaRows }),
    [repoRows, sagaRows, spaceRows],
  );
  return {
    context,
    isPending: repos.isPending || spaces.isPending || sagas.isPending,
    error: repos.error ?? spaces.error ?? sagas.error,
    refreshSpaces: spaces.refresh,
  };
}

/** Replaces the stack with a new task in the project. */
function useOpenNewTaskInProject() {
  const navigation = useNavigation();
  return useCallback(
    (environmentId: EnvironmentId, projectId: ProjectId, title: string) =>
      navigation.dispatch(
        CommonActions.reset({
          index: 0,
          routes: [{ name: "NewTaskDraft", params: { environmentId, projectId, title } }],
        }),
      ),
    [navigation],
  );
}

/**
 * Waits for this client's shell to reach the `sequence` a Stave operation
 * reported for its project, then opens a new task in it. Resolves to an error
 * message when the project never showed up.
 */
function useOpenStaveProject() {
  const openNewTask = useOpenNewTaskInProject();
  const waitForProject = useAtomCommand(waitForStaveProjectVisible, { reportFailure: false });
  return useCallback(
    async (
      environmentId: EnvironmentId,
      projectId: ProjectId,
      sequence: number,
    ): Promise<string | null> => {
      const visible = await waitForProject({ environmentId, projectId, sequence });
      if (AsyncResult.isFailure(visible)) return errorMessage(Cause.squash(visible.cause));
      openNewTask(environmentId, projectId, visible.value.title);
      return null;
    },
    [openNewTask, waitForProject],
  );
}

/**
 * Starts an operation, follows its state atom, and once the server reports
 * the created project waits for this client's shell to see it before
 * replacing the stack with a new task in it.
 */
function useStaveCreateOperation(environmentId: EnvironmentId | null) {
  const runOperation = useAtomCommand(staveOperations.run, { reportFailure: false });
  const openProject = useOpenStaveProject();
  const [started, setStarted] = useState<{
    readonly operationId: string;
    readonly operation: StaveOperation;
  } | null>(null);
  const state = useAtomValue(staveOperations.stateAtom(started?.operationId ?? IDLE_OPERATION_ID));
  const [openError, setOpenError] = useState<string | null>(null);
  const openedRef = useRef(false);

  const run = (operation: StaveOperation, operationId: string) => {
    if (environmentId === null) return;
    setStarted({ operationId, operation });
    void runOperation({ environmentId, operationId, operation });
  };

  const result = state.status === "finished" ? state.result : undefined;
  useEffect(() => {
    if (environmentId === null || openedRef.current) return;
    if (result?.kind !== "createSpace" && result?.kind !== "createSaga") return;
    openedRef.current = true;
    const { projectId, sequence } = result.result;
    void openProject(environmentId, projectId, sequence).then(setOpenError);
  }, [environmentId, openProject, result]);

  return {
    state: started === null ? null : state,
    openError,
    start: (operation: StaveOperation) => run(operation, uuidv4()),
    /** Resumes a `disconnected` stream; `run` picks up from the last sequence. */
    resume: () => {
      if (started !== null) run(started.operation, started.operationId);
    },
    /** Back to the form after a failure, keeping what the user typed. */
    reset: () => {
      openedRef.current = false;
      setStarted(null);
      setOpenError(null);
    },
  };
}

function Field(props: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly hintTone?: "muted" | "error";
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-1.5">
      <SectionTitle>{props.label}</SectionTitle>
      {props.children}
      {props.hint ? (
        <Text
          className={cn(
            "px-1 text-xs leading-snug",
            props.hintTone === "error" ? "text-adaptive-rose-700-300" : "text-foreground-muted",
          )}
        >
          {props.hint}
        </Text>
      ) : null}
    </View>
  );
}

const SINGLE_LINE_INPUT = "h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug";

function IdInput(props: {
  readonly value: string;
  readonly placeholder: string;
  readonly onChangeText: (value: string) => void;
}) {
  return (
    <TextInput
      className={SINGLE_LINE_INPUT}
      value={props.value}
      onChangeText={props.onChangeText}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      placeholder={props.placeholder}
      returnKeyType="next"
    />
  );
}

function SpecInput(props: {
  readonly value: string;
  readonly placeholder: string;
  readonly onChangeText: (value: string) => void;
}) {
  return (
    <TextInput
      multiline
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      textAlignVertical="top"
      className="min-h-[104px] rounded-[20px] px-4 py-3.5"
    />
  );
}

function Chip(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className={cn(
        "rounded-full px-3 py-1.5 active:opacity-70",
        props.selected ? "bg-primary" : "bg-subtle",
      )}
    >
      <Text
        className={cn(
          "text-sm font-lecturn-bold",
          props.selected ? "text-primary-foreground" : "text-foreground-muted",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function iconFor(name: "cube" | "square.grid.2x2", muted = false) {
  return (
    <SymbolView
      name={name}
      size={17}
      tintColorClassName={muted ? "accent-icon-muted" : "accent-icon"}
      type="monochrome"
    />
  );
}

/**
 * Searchable registry list. `modes` are the chips each row offers; tapping
 * the active chip clears the row back to `none`.
 */
function RepoPicker(props: {
  readonly rows: ReadonlyArray<StaveWizardRepoRow>;
  readonly context: StaveWizardContext;
  readonly isPending: boolean;
  readonly modes: ReadonlyArray<{ readonly mode: StaveWizardRepoMode; readonly label: string }>;
  readonly onModeChange: (repo: string, mode: StaveWizardRepoMode) => void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(
    () => filterStaveRepoRows(props.rows, query, props.context.repos),
    [props.context.repos, props.rows, query],
  );
  const branchByRepo = useMemo(
    () => new Map(props.context.repos.map((entry) => [entry.name, entry.defaultBranch] as const)),
    [props.context.repos],
  );
  const selectedCount = props.rows.filter((row) => row.mode !== "none").length;

  if (props.rows.length === 0) {
    return (
      <GlassCard radius={20} className="px-4 py-3.5">
        <Text className="text-sm leading-snug text-foreground-muted">
          {props.isPending
            ? "Loading registered repos…"
            : "No repos are registered with Stave yet. Register one on desktop or with `stave repos add`."}
        </Text>
      </GlassCard>
    );
  }

  return (
    <>
      <View className="flex-row items-center justify-between px-1">
        <SectionTitle>Repos</SectionTitle>
        <Text className="text-xs text-foreground-muted">{selectedCount} selected</Text>
      </View>
      {props.rows.length > 5 ? (
        <TextInput
          className={SINGLE_LINE_INPUT}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          placeholder="Search repos"
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      ) : null}
      <ListSection>
        {visible.length === 0 ? (
          <View className="px-4 py-3.5">
            <Text className="text-sm text-foreground-muted">No repos match “{query.trim()}”.</Text>
          </View>
        ) : (
          visible.map((row, index) => (
            <ListRow
              key={row.repo}
              title={row.repo}
              subtitle={branchByRepo.get(row.repo) ?? null}
              icon={iconFor("cube", row.mode === "none")}
              isFirst={index === 0}
              right={
                <View className="flex-row gap-1.5">
                  {props.modes.map((option) => (
                    <Chip
                      key={option.mode}
                      label={option.label}
                      selected={row.mode === option.mode}
                      onPress={() =>
                        props.onModeChange(
                          row.repo,
                          row.mode === option.mode ? "none" : option.mode,
                        )
                      }
                    />
                  ))}
                </View>
              }
            />
          ))
        )}
      </ListSection>
    </>
  );
}

const SPACE_REPO_MODES = [
  { mode: "edit", label: "Edit" },
  { mode: "reference", label: "Ref" },
] as const;
const SAGA_REPO_MODES = [{ mode: "reference", label: "Ref" }] as const;

function phaseSymbol(status: StavePhaseStatus) {
  switch (status) {
    case "running":
      return <ActivityIndicator size="small" colorClassName={"accent-icon-muted"} />;
    case "done":
      return (
        <SymbolView name="checkmark" size={14} tintColorClassName="accent-icon" type="monochrome" />
      );
    case "failed":
      return (
        <SymbolView
          name="xmark"
          size={14}
          tintColorClassName="accent-danger-foreground"
          type="monochrome"
        />
      );
    case "interrupted":
      return (
        <SymbolView
          name="exclamationmark.triangle"
          size={14}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      );
  }
}

/** Phases with their marker and duration, the tail of the latest phase's output, and the outcome. */
function OperationProgress(props: {
  readonly subject: string;
  readonly operation: ReturnType<typeof useStaveCreateOperation>;
  readonly onBack: () => void;
}) {
  const { operation } = props;
  const state = operation.state;
  if (state === null) return null;
  const lastPhase = state.phases[state.phases.length - 1];
  const tail = lastPhase?.lines.slice(-4) ?? [];
  const error = state.error === undefined ? null : describeOperationError(state.error);

  return (
    <>
      <GlassCard radius={24} className="gap-1 px-4 py-3">
        <Text className="text-base font-lecturn-bold">{props.subject}</Text>
        <Text className="text-sm text-foreground-muted">
          {state.status === "finished" && operation.openError === null
            ? "Created. Opening project…"
            : overallStatusLabel(state)}
        </Text>
      </GlassCard>
      {state.phases.length > 0 ? (
        <ListSection>
          {state.phases.map((phase, index) => (
            <ListRow
              key={`${phase.phase}:${phase.startedAt}`}
              title={phase.phase}
              subtitle={phase.commandLine ?? null}
              icon={phaseSymbol(phaseStatus(phase, index, state))}
              isFirst={index === 0}
              right={
                phase.durationMs === undefined ? null : (
                  <Text className="text-xs text-foreground-muted">
                    {formatPhaseDuration(phase.durationMs)}
                  </Text>
                )
              }
            />
          ))}
        </ListSection>
      ) : state.status === "running" || state.status === "idle" ? (
        <ActivityIndicator colorClassName={"accent-icon-muted"} />
      ) : null}
      {tail.length > 0 && state.status !== "finished" ? (
        <GlassCard radius={20} className="px-4 py-3">
          <Text className="font-mono text-xs leading-snug text-foreground-muted" numberOfLines={8}>
            {tail.map(outputLineText).join("\n")}
          </Text>
        </GlassCard>
      ) : null}
      {error !== null ? <ErrorBanner message={`${error.title}: ${error.detail}`} /> : null}
      {state.status === "disconnected" ? (
        <>
          <ErrorBanner
            message={
              state.disconnectReason ??
              "Lost the connection while the operation was running. It may still be running on the server."
            }
          />
          <PrimaryActionButton label="Resume" onPress={operation.resume} />
        </>
      ) : null}
      {operation.openError !== null ? (
        <ErrorBanner message={`Created, but opening it failed: ${operation.openError}`} />
      ) : null}
      {state.status === "failed" ? (
        <PrimaryActionButton label="Back to form" onPress={props.onBack} />
      ) : null}
    </>
  );
}

type StaveFormMode = "new" | "existing";

/** New/Existing segmented control at the top of the space and saga forms. */
function ModeSwitch(props: {
  readonly kind: ExistingStaveSpaceKind;
  readonly value: StaveFormMode;
  readonly onChange: (mode: StaveFormMode) => void;
}) {
  return (
    <View className="flex-row gap-1 rounded-full bg-subtle p-1">
      {(["new", "existing"] as const).map((mode) => {
        const selected = props.value === mode;
        return (
          <Pressable
            key={mode}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => props.onChange(mode)}
            className={cn(
              "h-9 flex-1 items-center justify-center rounded-full active:opacity-70",
              selected && "bg-primary",
            )}
          >
            <Text
              className={cn(
                "text-sm font-lecturn-bold",
                selected ? "text-primary-foreground" : "text-foreground-muted",
              )}
            >
              {mode === "new" ? `New ${props.kind}` : `Existing ${props.kind}`}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function RowButton(props: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="rounded-full bg-subtle px-3 py-1.5 active:opacity-70 disabled:opacity-45"
    >
      <Text
        className={cn(
          "text-sm font-lecturn-bold",
          props.destructive ? "text-danger-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function ExistingSpaceRow(props: {
  readonly entry: ExistingStaveSpace;
  readonly isFirst: boolean;
  readonly busy: boolean;
  readonly onAdd: () => void;
  readonly onRestore: () => void;
  readonly onDelete: () => void;
}) {
  const { entry } = props;
  return (
    <View className={cn("gap-2 px-4 py-3", !props.isFirst && "border-t border-border-subtle")}>
      <View className="flex-row items-center gap-2">
        <Text className="flex-shrink text-base leading-snug font-lecturn-bold" numberOfLines={1}>
          {entry.spaceId}
        </Text>
        <View className="rounded-full bg-subtle px-2 py-0.5">
          <Text className="text-2xs font-lecturn-bold uppercase text-foreground-muted">
            {entry.archived ? "Archived" : "Active"}
          </Text>
        </View>
      </View>
      <Text className="text-sm leading-snug text-foreground-muted" numberOfLines={2}>
        {existingStaveSpaceDetail(entry)}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {entry.archived ? (
          <>
            <RowButton label="Restore" disabled={props.busy} onPress={props.onRestore} />
            <RowButton
              label="Delete permanently"
              destructive
              disabled={props.busy}
              onPress={props.onDelete}
            />
          </>
        ) : (
          <RowButton label="Add" disabled={props.busy} onPress={props.onAdd} />
        )}
      </View>
    </View>
  );
}

function confirmDeleteArchive(entry: ExistingStaveSpace, onConfirm: () => void) {
  Alert.alert(
    `Delete ${entry.spaceId} permanently?`,
    [
      `Stave restores its worktrees briefly, then destroys the ${entry.isSaga ? "saga" : "space"}: its spec and notes are removed, committed branches survive, and owned memory is kept.`,
      "Its Lecturn project and threads are deleted.",
      ...(entry.isSaga ? ["A saga that still has live members is refused."] : []),
    ].join(" "),
    [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: onConfirm },
    ],
  );
}

type ExistingTask = {
  readonly key: string;
  readonly state: StaveArchiveTaskState | { readonly status: "adding" };
};

/**
 * Existing space/saga: the environment's spaces of `kind` that are not
 * visible projects. Active ones are added as projects; archives are restored
 * into their project (threads come back) or deleted permanently. The list is
 * only fetched while this mode is shown.
 */
function ExistingStaveSpaces(props: {
  readonly environmentId: EnvironmentId;
  readonly kind: ExistingStaveSpaceKind;
}) {
  const { environmentId, kind } = props;
  const spaces = useEnvironmentQuery(
    staveSpaces({ environmentId, input: { includeArchived: true } }),
  );
  const projects = useProjects();
  const [showArchived, setShowArchived] = useState(false);
  const [task, setTask] = useState<ExistingTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openProject = useOpenStaveProject();
  const openNewTask = useOpenNewTaskInProject();
  const dispatchProjectCreate = useDispatchProjectCreate();
  const rows = spaces.data ?? EMPTY;
  const { entries, archivedCount } = useMemo(
    () => existingStaveSpaces({ rows, projects, kind, showArchived }),
    [kind, projects, rows, showArchived],
  );
  const busy = task !== null;

  const track = (entry: ExistingStaveSpace) => (state: StaveArchiveTaskState) =>
    setTask({ key: entry.key, state });
  const fail = (message: string) => {
    setTask(null);
    setError(message);
    spaces.refresh();
  };

  const add = async (entry: ExistingStaveSpace) => {
    setError(null);
    setTask({ key: entry.key, state: { status: "adding" } });
    const { projectId, result } = await dispatchProjectCreate({
      environmentId,
      workspaceRoot: entry.path,
      title: entry.spaceId,
      createWorkspaceRootIfMissing: false,
    });
    if (AsyncResult.isFailure(result)) {
      fail(errorMessage(Cause.squash(result.cause)));
      return;
    }
    openNewTask(environmentId, projectId, entry.spaceId);
  };

  const restore = async (entry: ExistingStaveSpace) => {
    setError(null);
    const client = mobileStaveArchiveClient(environmentId);
    const final = await restoreStaveArchive(client, { row: entry.row, rows }, track(entry));
    if (final.status === "failed") return fail(final.message);
    if (final.status !== "finished" || final.projectId === null || final.sequence === null) {
      return fail("Restored, but the server did not report its project.");
    }
    const openError = await openProject(environmentId, final.projectId, final.sequence);
    if (openError !== null) fail(`Restored, but opening it failed: ${openError}`);
  };

  const remove = async (entry: ExistingStaveSpace) => {
    setError(null);
    const client = mobileStaveArchiveClient(environmentId);
    const final = await deleteStaveArchive(client, entry.row, track(entry));
    if (final.status === "failed") return fail(final.message);
    setTask(null);
    spaces.refresh();
  };

  const running = task?.state.status === "running" ? task.state : null;
  const progress =
    task === null
      ? null
      : task.state.status === "adding"
        ? "Adding project…"
        : running !== null
          ? `${running.label}${running.total > 1 ? ` (${running.step}/${running.total})` : ""}…`
          : task.state.status === "finished"
            ? "Opening project…"
            : null;

  return (
    <>
      {spaces.error !== null ? <ErrorBanner message={spaces.error} /> : null}
      {error !== null ? <ErrorBanner message={error} /> : null}
      {progress !== null ? (
        <GlassCard radius={20} className="flex-row items-center gap-3 px-4 py-3">
          <ActivityIndicator size="small" colorClassName={"accent-icon-muted"} />
          <Text className="flex-1 text-sm text-foreground-muted" numberOfLines={2}>
            {progress}
          </Text>
        </GlassCard>
      ) : null}
      <ListSection>
        <ListRow
          title={`Show archived (${archivedCount})`}
          icon={iconFor("square.grid.2x2", !showArchived)}
          isFirst
          right={
            <ThemedSwitch
              accessibilityLabel="Show archived"
              value={showArchived}
              onValueChange={setShowArchived}
            />
          }
        />
      </ListSection>
      {entries.length === 0 ? (
        <GlassCard radius={20} className="px-4 py-3.5">
          <Text className="text-sm leading-snug text-foreground-muted">
            {spaces.isPending
              ? `Loading ${kind}s…`
              : showArchived || archivedCount === 0
                ? `No ${kind}s to add. Every ${kind} here is already a project.`
                : `No active ${kind}s to add. Turn on Show archived to restore one.`}
          </Text>
        </GlassCard>
      ) : (
        <ListSection>
          {entries.map((entry, index) => (
            <ExistingSpaceRow
              key={entry.key}
              entry={entry}
              isFirst={index === 0}
              busy={busy}
              onAdd={() => void add(entry)}
              onRestore={() => void restore(entry)}
              onDelete={() => confirmDeleteArchive(entry, () => void remove(entry))}
            />
          ))}
        </ListSection>
      )}
    </>
  );
}

function StaveUnavailableState() {
  return (
    <GlassCard radius={20} className="items-center gap-2 px-5 py-8">
      <Text className="text-center text-lg font-lecturn-bold">Stave unavailable</Text>
      <Text className="text-center text-sm leading-normal text-foreground-muted">
        Enable Stave and pick a compatible binary in this environment's settings.
      </Text>
    </GlassCard>
  );
}

export function AddStaveSpaceScreen(props: { readonly environmentId?: string | string[] }) {
  const environment = useEnvironmentFromParam(props.environmentId);
  const environmentId = environment?.environmentId ?? null;
  const available = useStaveCreateSources(environmentId).includes("stave-space");
  const data = useStaveCreateContext(environmentId);
  const { context } = data;
  const [state, setState] = useState<StaveSpaceWizardState>(() =>
    createInitialWizardState(context),
  );
  const operation = useStaveCreateOperation(environmentId);
  const [mode, setMode] = useState<StaveFormMode>("new");

  // Repo rows follow the registry, adjusted in render when it changes.
  const [seenRepos, setSeenRepos] = useState(context.repos);
  if (seenRepos !== context.repos) {
    setSeenRepos(context.repos);
    setState((current) =>
      updateWizardState(current, { repos: syncRepoRows(current.repos, context.repos) }),
    );
  }

  const idCheck = validateSpaceId(state.spaceId, context.spaces);
  const gate = canCreateSpace(state, context);
  const patch = (next: Partial<StaveSpaceWizardState>) =>
    setState((current) => updateWizardState(current, next));

  if (environment === null) {
    return (
      <AddProjectShell>
        <EmptyEnvironmentState />
      </AddProjectShell>
    );
  }
  if (operation.state !== null) {
    return (
      <AddProjectShell>
        <OperationProgress
          subject={state.spaceId.trim()}
          operation={operation}
          onBack={() => {
            operation.reset();
            // A failed create may have left a partial space the id check must see.
            data.refreshSpaces();
          }}
        />
      </AddProjectShell>
    );
  }
  if (!available) {
    return (
      <AddProjectShell>
        <StaveUnavailableState />
      </AddProjectShell>
    );
  }

  if (mode === "existing") {
    return (
      <AddProjectShell>
        <ModeSwitch kind="space" value={mode} onChange={setMode} />
        <ExistingStaveSpaces environmentId={environment.environmentId} kind="space" />
      </AddProjectShell>
    );
  }

  return (
    <AddProjectShell>
      <ModeSwitch kind="space" value={mode} onChange={setMode} />
      {data.error !== null ? <ErrorBanner message={data.error} /> : null}
      <Field
        label="Space id"
        hint={state.spaceId.length > 0 ? (idCheck.message ?? idCheck.warning) : undefined}
        hintTone={idCheck.ok ? "muted" : "error"}
      >
        <IdInput
          value={state.spaceId}
          placeholder="fix-login-redirect"
          onChangeText={(spaceId) => patch({ spaceId })}
        />
      </Field>
      <Field label="Title">
        <TextInput
          className={SINGLE_LINE_INPUT}
          value={state.title}
          onChangeText={(title) => patch({ title })}
          placeholder={state.spaceId.trim() || "Defaults to the id"}
          returnKeyType="next"
        />
      </Field>
      <Field label="Kind">
        <View className="flex-row flex-wrap gap-2 px-1">
          {MOBILE_KIND_CHIPS.map((chip) => (
            <Chip
              key={chip}
              label={chip}
              selected={state.kindChip === chip}
              onPress={() => patch({ kindChip: chip })}
            />
          ))}
        </View>
      </Field>
      <Field label="Spec">
        <SpecInput
          value={state.specText}
          onChangeText={(specText) => patch({ specText })}
          placeholder="What this space is for (optional)"
        />
      </Field>
      <RepoPicker
        rows={state.repos}
        context={context}
        isPending={data.isPending}
        modes={SPACE_REPO_MODES}
        onModeChange={(repo, mode) => setState((current) => setRepoMode(current, repo, mode))}
      />
      {/* Same semantics as web: picking a repo clears it; while on, selections are ignored. */}
      <ListSection>
        <ListRow
          title="Empty space (no repos)"
          subtitle="Start without repos and add them later."
          icon={iconFor("square.grid.2x2", !state.emptySpace)}
          isFirst
          right={
            <ThemedSwitch
              accessibilityLabel="Empty space (no repos)"
              value={state.emptySpace}
              onValueChange={(emptySpace) => patch({ emptySpace })}
            />
          }
        />
      </ListSection>
      {context.sagas.length > 0 ? (
        <>
          <SectionTitle>Saga</SectionTitle>
          <ListSection>
            {[null, ...context.sagas.map(sagaIdOf)].map((sagaId, index) => (
              <ListRow
                key={sagaId ?? "none"}
                title={sagaId ?? "None"}
                subtitle={index === 0 ? "Not part of a saga" : null}
                icon={iconFor("square.grid.2x2", sagaId === null)}
                isFirst={index === 0}
                right={
                  state.sagaId === sagaId ? (
                    <SymbolView
                      name="checkmark"
                      size={14}
                      tintColorClassName="accent-icon"
                      type="monochrome"
                    />
                  ) : null
                }
                onPress={() => setState((current) => setSaga(current, sagaId))}
              />
            ))}
          </ListSection>
        </>
      ) : null}
      {!gate.ok && gate.message !== undefined && state.spaceId.length > 0 ? (
        <Text className="px-1 text-xs text-foreground-muted">{gate.message}</Text>
      ) : null}
      <PrimaryActionButton
        label="Create space"
        disabled={!gate.ok}
        onPress={() => {
          if (gate.ok) operation.start(buildCreateSpaceOperation(state));
        }}
      />
    </AddProjectShell>
  );
}

export function AddStaveSagaScreen(props: { readonly environmentId?: string | string[] }) {
  const environment = useEnvironmentFromParam(props.environmentId);
  const environmentId = environment?.environmentId ?? null;
  const available = useStaveCreateSources(environmentId).includes("stave-saga");
  const data = useStaveCreateContext(environmentId);
  const { context } = data;
  const [state, setState] = useState<StaveSagaWizardState>(() =>
    createInitialSagaWizardState(context.repos),
  );
  const operation = useStaveCreateOperation(environmentId);
  const [mode, setMode] = useState<StaveFormMode>("new");

  const [seenRepos, setSeenRepos] = useState(context.repos);
  if (seenRepos !== context.repos) {
    setSeenRepos(context.repos);
    setState((current) => ({
      ...current,
      references: syncRepoRows(current.references, context.repos),
    }));
  }

  const idCheck = validateSpaceId(state.sagaId, context.spaces);
  const gate = validateSagaWizard(state, context.spaces);
  const patch = (next: Partial<StaveSagaWizardState>) =>
    setState((current) => ({ ...current, ...next }));

  if (environment === null) {
    return (
      <AddProjectShell>
        <EmptyEnvironmentState />
      </AddProjectShell>
    );
  }
  if (operation.state !== null) {
    return (
      <AddProjectShell>
        <OperationProgress
          subject={state.sagaId.trim()}
          operation={operation}
          onBack={() => {
            operation.reset();
            // A failed create may have left a partial space the id check must see.
            data.refreshSpaces();
          }}
        />
      </AddProjectShell>
    );
  }
  if (!available) {
    return (
      <AddProjectShell>
        <StaveUnavailableState />
      </AddProjectShell>
    );
  }

  if (mode === "existing") {
    return (
      <AddProjectShell>
        <ModeSwitch kind="saga" value={mode} onChange={setMode} />
        <ExistingStaveSpaces environmentId={environment.environmentId} kind="saga" />
      </AddProjectShell>
    );
  }

  return (
    <AddProjectShell>
      <ModeSwitch kind="saga" value={mode} onChange={setMode} />
      {data.error !== null ? <ErrorBanner message={data.error} /> : null}
      <Field
        label="Saga id"
        hint={state.sagaId.length > 0 ? (idCheck.message ?? idCheck.warning) : undefined}
        hintTone={idCheck.ok ? "muted" : "error"}
      >
        <IdInput
          value={state.sagaId}
          placeholder="checkout-rewrite"
          onChangeText={(sagaId) => patch({ sagaId })}
        />
      </Field>
      <Field label="Title">
        <TextInput
          className={SINGLE_LINE_INPUT}
          value={state.title}
          onChangeText={(title) => patch({ title })}
          placeholder={state.sagaId.trim() || "Defaults to the id"}
          returnKeyType="next"
        />
      </Field>
      <Field
        label="Spec"
        hint="A saga groups spaces that land in order. Spaces join it when you create them."
      >
        <SpecInput
          value={state.specText}
          onChangeText={(specText) => patch({ specText })}
          placeholder="What the saga delivers as a whole (optional)"
        />
      </Field>
      <RepoPicker
        rows={state.references}
        context={context}
        isPending={data.isPending}
        modes={SAGA_REPO_MODES}
        onModeChange={(repo, mode) =>
          setState((current) => ({
            ...current,
            references: current.references.map((row) =>
              row.repo === repo ? { ...row, mode } : row,
            ),
          }))
        }
      />
      <PrimaryActionButton
        label="Create saga"
        disabled={!gate.ok}
        onPress={() => {
          if (gate.ok) operation.start(buildCreateSagaOperation(state));
        }}
      />
    </AddProjectShell>
  );
}
