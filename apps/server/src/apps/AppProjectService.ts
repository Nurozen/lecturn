/**
 * App projects (spec R3): one project per `(appId, workspaceRoot)`, invisible
 * to every workspace-root lookup a normal project uses, plus the thread list an
 * app's rail reads. Thread app metadata writes are A13b's.
 */
import {
  type AppBinding,
  AppsError,
  CommandId,
  type ConnectedAppThreadState,
  ConnectedAppThreadSummary,
  type ConnectedAppThreadsStreamEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ThreadId,
} from "@lecturn/contracts";
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
import {
  coalesceShellApplicationEvents,
  toShellApplicationEvent,
  type ShellApplicationEvent,
} from "../orchestration-v2/ShellStream.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { AppProjectService, AppsNotImplemented } from "./services.ts";
import { readHistoryRevisions } from "./threadHistoryRevision.ts";

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "AppProjectService", method });

const unavailable = (message: string) => (cause: unknown) =>
  new AppsError({
    code: "unavailable",
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const RUNNING_STATUSES: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
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

const make = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
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

  return AppProjectService.of({
    ensureWorkspace,
    resolveAppForProject,
    listThreads,
    streamThreads,
    setThreadAppData: () => Effect.fail(notImplemented("setThreadAppData")),
    createEmbedThread: () => Effect.fail(notImplemented("createEmbedThread")),
    markThreadsCopied: () => Effect.fail(notImplemented("markThreadsCopied")),
  });
});

export const layer = Layer.effect(AppProjectService, make);
