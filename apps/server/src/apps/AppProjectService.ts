/**
 * App projects (spec R3): one project per `(appId, workspaceRoot)`, invisible
 * to every workspace-root lookup a normal project uses, plus the thread list an
 * app's rail reads, plus the writes of thread app metadata, which go through
 * orchestration like any other thread change (see threadAppMetadata.ts).
 */
import {
  type AppBinding,
  type AppId,
  AppsError,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ConnectedAppThreadState,
  ConnectedAppThreadSummary,
  type ConnectedAppThreadsStreamEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@lecturn/contracts";
import {
  clearProjectSettingsOverrides,
  resolveProjectSettings,
} from "@lecturn/shared/projectSettings";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  coalesceShellApplicationEvents,
  toShellApplicationEvent,
  type ShellApplicationEvent,
} from "../orchestration-v2/ShellStream.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { AppProjectService } from "./services.ts";
import { readHistoryRevisions } from "./threadHistoryRevision.ts";

const DEFAULT_EMBED_THREAD_TITLE = "New thread";

// Used only when neither the project nor the server names a default model;
// the embed composer can switch models before the first send.
const FALLBACK_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
};

const unavailable = (message: string) => (cause: unknown) =>
  new AppsError({
    code: "unavailable",
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

export const RUNNING_STATUSES: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const threadState = (shell: OrchestrationV2ThreadShell): ConnectedAppThreadState =>
  shell.pendingRuntimeRequest !== null
    ? "awaiting-approval"
    : RUNNING_STATUSES.has(shell.status)
      ? "running"
      : "idle";

/** Subagent children belong to their parent's turn, not to the app's rail. */
const isRailThread = (shell: OrchestrationV2ThreadShell, projectId: ProjectId) =>
  shell.projectId === projectId && shell.lineage.relationshipToParent !== "subagent";

const toSummary = (
  binding: AppBinding,
  shell: OrchestrationV2ThreadShell,
  historyRevision: number,
): ConnectedAppThreadSummary => ({
  threadId: shell.id,
  projectId: shell.projectId,
  workspaceRoot: binding.workspaceRoot,
  title: shell.title,
  createdAt: DateTime.formatIso(shell.createdAt),
  updatedAt: DateTime.formatIso(shell.updatedAt),
  historyRevision,
  state: threadState(shell),
  appData: shell.appData ?? null,
  subtitle: shell.appSubtitle ?? null,
  ...(shell.copiedFrom === undefined ? {} : { copiedFrom: shell.copiedFrom }),
  ...(shell.continuedIn === undefined ? {} : { continuedIn: shell.continuedIn }),
});

const sameSummary = Schema.toEquivalence(ConnectedAppThreadSummary);

const newestFirst = (left: ConnectedAppThreadSummary, right: ConnectedAppThreadSummary) =>
  right.updatedAt.localeCompare(left.updatedAt) || left.threadId.localeCompare(right.threadId);

const forbidden = (message: string) => new AppsError({ code: "forbidden", message });

const make = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const threadManagement = yield* ThreadManagement.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const revisionsFor = (threadIds: ReadonlyArray<ThreadId>) =>
    readHistoryRevisions(threadIds).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(unavailable("Could not read thread history")),
    );

  const summariesFor = (binding: AppBinding, shells: ReadonlyArray<OrchestrationV2ThreadShell>) =>
    revisionsFor(shells.map((shell) => shell.id)).pipe(
      Effect.map((revisions) =>
        shells.map((shell) => toSummary(binding, shell, revisions.get(shell.id) ?? 0)),
      ),
    );

  const requireBinding = (projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.mapError(unavailable("Could not read the project")),
      Effect.flatMap((row) =>
        Option.isSome(row) && row.value.appBinding !== undefined
          ? Effect.succeed(row.value.appBinding)
          : Effect.fail(
              new AppsError({
                code: "not-found",
                message: `Project ${projectId} is not a connected-app project.`,
              }),
            ),
      ),
    );

  const ensureWorkspace: AppProjectService["Service"]["ensureWorkspace"] = Effect.fn(
    "AppProjectService.ensureWorkspace",
  )(function* (appId, input) {
    const existing = yield* projects
      .findActiveByAppWorkspace(appId, input.workspaceRoot)
      .pipe(Effect.mapError(unavailable("Could not look up the app project")));
    if (Option.isSome(existing)) return { projectId: existing.value.projectId };
    const id = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable("No random id")));
    const projectId = ProjectId.make(id);
    return yield* projectService
      .create({
        commandId: CommandId.make(`apps:ensure-workspace:${id}`),
        projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        appBinding: { appId, workspaceRoot: input.workspaceRoot },
      })
      .pipe(
        Effect.as({ projectId }),
        Effect.catchTags({
          // A concurrent ensure won the workspace lock; its project is the answer.
          ProjectConflictError: (error) =>
            Effect.succeed({ projectId: error.conflictingProjectId }),
          ProjectOperationError: (error) =>
            Effect.fail(
              error.operation === "normalize-workspace"
                ? new AppsError({
                    code: "invalid",
                    message: `Workspace root ${input.workspaceRoot} is not a usable folder.`,
                  })
                : unavailable("Could not create the app project")(error),
            ),
          ProjectNotFoundError: unavailable("Could not create the app project"),
          ProjectNotEmptyError: unavailable("Could not create the app project"),
        }),
      );
  });

  const resolveAppForProject: AppProjectService["Service"]["resolveAppForProject"] = (projectId) =>
    projects
      .get(projectId)
      .pipe(
        Effect.map(Option.flatMap((row) => Option.fromUndefinedOr(row.appBinding))),
        Effect.mapError(unavailable("Could not read the project")),
      );

  const readRail = (projectId: ProjectId, binding: AppBinding) =>
    threads.getShellSnapshot({ projectId, location: "active" }).pipe(
      Effect.mapError(unavailable("Could not read threads")),
      Effect.flatMap((snapshot) =>
        summariesFor(
          binding,
          snapshot.threads.filter((shell) => isRailThread(shell, projectId)),
        ),
      ),
      Effect.map((summaries) => summaries.toSorted(newestFirst)),
    );

  const listThreads: AppProjectService["Service"]["listThreads"] = Effect.fn(
    "AppProjectService.listThreads",
  )(function* (projectId) {
    return yield* readRail(projectId, yield* requireBinding(projectId));
  });

  const streamThreads: AppProjectService["Service"]["streamThreads"] = (projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const binding = yield* requireBinding(projectId);
        const afterSequence = yield* events.latestApplicationSequence.pipe(
          Effect.mapError(unavailable("Could not read the event log")),
        );
        const initial = yield* readRail(projectId, binding);

        // Per subscription. A thread never changes project, so membership is
        // cached: events of other projects' threads cost one read each, once.
        const member = new Map<ThreadId, boolean>();
        const sent = new Map<ThreadId, ConnectedAppThreadSummary>();
        for (const summary of initial) {
          member.set(summary.threadId, true);
          sent.set(summary.threadId, summary);
        }

        const changesFor = Effect.fn("AppProjectService.streamThreads.changes")(function* (
          batch: ReadonlyArray<ShellApplicationEvent>,
        ) {
          const out: Array<ConnectedAppThreadsStreamEvent> = [];
          const removeEverySent = () => {
            for (const threadId of sent.keys()) out.push({ type: "remove", threadId });
            sent.clear();
          };
          const live: Array<OrchestrationV2ThreadShell> = [];
          for (const stored of coalesceShellApplicationEvents(batch)) {
            if ("aggregateKind" in stored) {
              if (stored.aggregateId === projectId && stored.type === "project.deleted") {
                removeEverySent();
              }
              continue;
            }
            const threadId = stored.event.threadId;
            if (member.get(threadId) === false) continue;
            const shell = yield* threads
              .getThreadShell(threadId)
              .pipe(Effect.mapError(unavailable("Could not read a thread")));
            if (shell !== null) member.set(threadId, isRailThread(shell, projectId));
            if (shell !== null && !isRailThread(shell, projectId)) continue;
            if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) {
              if (sent.delete(threadId)) out.push({ type: "remove", threadId });
              continue;
            }
            live.push(shell);
          }
          for (const summary of yield* summariesFor(binding, live)) {
            const previous = sent.get(summary.threadId);
            if (previous !== undefined && sameSummary(previous, summary)) continue;
            sent.set(summary.threadId, summary);
            out.push({ type: "upsert", thread: summary });
          }
          return out;
        });

        const updates = events
          .streamProjectedApplicationEvents({ afterSequence, project: toShellApplicationEvent })
          .pipe(
            Stream.mapError(unavailable("The event stream failed")),
            Stream.groupedWithin(512, Duration.millis(50)),
            Stream.mapEffect((batch) => changesFor(Array.from(batch))),
            Stream.flatMap(Stream.fromIterable),
          );
        const snapshot: ConnectedAppThreadsStreamEvent = { type: "snapshot", threads: initial };
        return Stream.concat(Stream.make(snapshot), updates);
      }),
    );

  const newCommandId = (operation: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((id) => CommandId.make(`apps:${operation}:${id}`)),
      Effect.mapError(unavailable("No random id")),
    );

  const dispatch = (command: OrchestrationV2ServerCommand) =>
    threadManagement.dispatch(command).pipe(
      Effect.mapError(
        (cause) =>
          new AppsError({
            code: "unavailable",
            message: `Could not update the thread: ${cause.message}`,
          }),
      ),
    );

  /**
   * Only the app bound to a thread's project writes its app fields (R3.3).
   * Subagent children are not the app's threads, so they are refused too.
   */
  const requireOwnedThread = Effect.fn("AppProjectService.requireOwnedThread")(function* (
    appId: AppId,
    threadId: ThreadId,
  ) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(unavailable("Could not read the thread")));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new AppsError({ code: "not-found", message: `Thread ${threadId} not found.` });
    }
    const binding = yield* resolveAppForProject(shell.projectId);
    if (
      Option.isNone(binding) ||
      binding.value.appId !== appId ||
      !isRailThread(shell, shell.projectId)
    ) {
      return yield* forbidden(`Thread ${threadId} does not belong to ${appId}.`);
    }
  });

  const setThreadAppData: AppProjectService["Service"]["setThreadAppData"] = Effect.fn(
    "AppProjectService.setThreadAppData",
  )(function* (appId, input) {
    yield* requireOwnedThread(appId, input.threadId);
    yield* dispatch({
      type: "thread.app-data.set",
      commandId: yield* newCommandId("set-thread-app-data"),
      threadId: input.threadId,
      appData: input.appData,
      ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
    });
  });

  const markThreadsCopied: AppProjectService["Service"]["markThreadsCopied"] = Effect.fn(
    "AppProjectService.markThreadsCopied",
  )(function* (appId, input) {
    // Every entry is checked before any is written, so a bad entry changes nothing.
    yield* Effect.forEach(input.entries, ({ threadId }) => requireOwnedThread(appId, threadId), {
      discard: true,
    });
    yield* Effect.forEach(
      input.entries,
      (entry) =>
        newCommandId("mark-thread-copied").pipe(
          Effect.flatMap((commandId) =>
            dispatch({
              type: "thread.continued-in.set",
              commandId,
              threadId: entry.threadId,
              continuedIn: entry.continuedIn,
            }),
          ),
        ),
      { discard: true },
    );
  });

  /**
   * The embed view holds an embed token, never the app credential, so the
   * server creates the thread for the app that owns the token's project (D32)
   * and is the only writer of the thread's app fields.
   */
  const createEmbedThread: AppProjectService["Service"]["createEmbedThread"] = Effect.fn(
    "AppProjectService.createEmbedThread",
  )(function* (subject, input) {
    if (subject.kind !== "embed" || subject.projectId !== input.projectId) {
      return yield* forbidden("An embed token creates threads only in its own project.");
    }
    const binding = yield* requireBinding(input.projectId);
    if (binding.appId !== subject.appId) {
      return yield* forbidden(`Project ${input.projectId} does not belong to ${subject.appId}.`);
    }
    const project = yield* projectService
      .getById(input.projectId)
      .pipe(Effect.mapError(unavailable("Could not read the project")));
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(unavailable("Could not read settings")),
    );
    const defaults = resolveProjectSettings(
      settings,
      input.projectId,
      Option.getOrNull(project),
    ).settings;
    const id = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable("No random id")));
    const threadId = ThreadId.make(id);
    yield* dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`apps:create-embed-thread:${id}`),
      threadId,
      projectId: input.projectId,
      title: input.title ?? DEFAULT_EMBED_THREAD_TITLE,
      modelSelection: defaults.defaultModelSelection ?? FALLBACK_MODEL_SELECTION,
      runtimeMode: defaults.defaultRuntimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      appOrigin: "embed",
      ...(input.appData === undefined ? {} : { appData: input.appData }),
    });
    return { threadId };
  });

  /**
   * The embed holds no settings scope, so the server writes only this one key
   * of the token's own project entry; other projects and keys stay untouched.
   */
  const setEmbedDefaultModel: AppProjectService["Service"]["setEmbedDefaultModel"] = Effect.fn(
    "AppProjectService.setEmbedDefaultModel",
  )(function* (subject, input) {
    if (subject.kind !== "embed" || subject.projectId !== input.projectId) {
      return yield* forbidden("An embed token sets the default model only for its own project.");
    }
    const binding = yield* requireBinding(input.projectId);
    if (binding.appId !== subject.appId) {
      return yield* forbidden(`Project ${input.projectId} does not belong to ${subject.appId}.`);
    }
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(unavailable("Could not read settings")),
    );
    const entry =
      input.modelSelection === null
        ? clearProjectSettingsOverrides(settings, input.projectId, ["defaultModelSelection"])
        : {
            ...settings.projectSettingsOverrides[input.projectId],
            defaultModelSelection: input.modelSelection,
          };
    yield* serverSettings
      .updateSettings({ projectSettingsOverrides: { [input.projectId]: entry } })
      .pipe(Effect.mapError(unavailable("Could not save the default model")));
  });

  /**
   * One project at a time, each with a command id fixed by the project, so a
   * delete that failed part way is retried without deleting anything twice.
   */
  const deleteAppProjects: AppProjectService["Service"]["deleteAppProjects"] = Effect.fn(
    "AppProjectService.deleteAppProjects",
  )(function* (appId) {
    const rows = yield* projects
      .list()
      .pipe(Effect.mapError(unavailable("Could not list projects")));
    yield* Effect.forEach(
      rows.filter((row) => row.appBinding?.appId === appId),
      (row) =>
        projectService
          .delete({
            commandId: CommandId.make(`apps:delete-app-project:${row.projectId}`),
            projectId: row.projectId,
            force: true,
          })
          .pipe(Effect.mapError(unavailable(`Could not delete project ${row.projectId}`))),
      { discard: true },
    );
  });

  return AppProjectService.of({
    ensureWorkspace,
    resolveAppForProject,
    listThreads,
    streamThreads,
    setThreadAppData,
    createEmbedThread,
    setEmbedDefaultModel,
    markThreadsCopied,
    deleteAppProjects,
  });
});

export const layer = Layer.effect(AppProjectService, make);
