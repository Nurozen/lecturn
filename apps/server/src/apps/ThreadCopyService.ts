// @effect-diagnostics nodeBuiltinImport:off
/**
 * Lecturn-to-Lecturn thread copy (spec R8, plan A23 and D33): an app exports
 * its threads from one environment (usually its sidecar) and imports them into
 * another as history-only threads.
 *
 * A copy is `historyOrigin: "v1_import"` with run-less items and no provider
 * thread, so continuing it starts a fresh provider session that receives the
 * copied history as a full-thread handoff, and forking it cuts the copied
 * history like any imported thread. `importedFrom` is left alone (R8.3).
 *
 * Interrupted imports: assets are staged under the bundle's hash before any
 * thread is written, and each thread commits in one transaction. A rerun
 * reuses staged assets and skips threads already copied at the bundle's
 * revision. A staging area untouched for a day is swept, together with any
 * promoted file its threads never came to reference.
 */
import * as NodeCrypto from "node:crypto";

import {
  type AppId,
  AppsError,
  ConnectedAppThreadBundleV1,
  type ConnectedAppThreadBundleAsset,
  type ConnectedAppThreadBundleProject,
  type ConnectedAppThreadBundleThread,
  type ConnectedAppThreadCopyOrigin,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ProjectId,
  ProviderInstanceId,
  type ThreadId,
} from "@lecturn/contracts";
import { resolveProjectSettings } from "@lecturn/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import {
  parseAttachmentFileExtension,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { AppProjectService, AppRegistryService, ThreadCopyService } from "./services.ts";
import {
  collectThreadAssetRefs,
  copiedAssetRelativePath,
  copiedAttachmentId,
  copyThreadHistory,
  copyThreadId,
  recopyThreadId,
} from "./threadCopyHistory.ts";
import { threadAppMetadataOf, withoutThreadAppMetadata } from "./threadAppMetadata.ts";
import { readHistoryRevisions } from "./threadHistoryRevision.ts";

const STAGING_DIRECTORY = "thread-copy-staging";
const STAGING_MANIFESTS = "threads";
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EVENT_PREFIX = "thread-copy:v1";
const UNTITLED = "Untitled thread";

// Same fallback as embed threads: only when neither the project nor the server
// names a default model.
const FALLBACK_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
};

const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const encodeBundle = Schema.encodeEffect(ConnectedAppThreadBundleV1);
const isAppsError = Schema.is(AppsError);
const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ threadId: Schema.String, files: Schema.Array(Schema.String) }),
  ),
);

const unavailable = (message: string) => (cause: unknown) =>
  new AppsError({
    code: "unavailable",
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const invalid = (message: string) => new AppsError({ code: "invalid", message });

const DOCUMENT_MIME_TYPES: Record<string, string> = { html: "text/html" };

interface CopyRow {
  readonly threadId: ThreadId;
  readonly sourceThreadId: string;
  readonly revision: number;
  readonly title: string;
  readonly deleted: boolean;
}

type ThreadPlan =
  | { readonly type: "skip" }
  | { readonly type: "create"; readonly threadId: ThreadId; readonly title: string }
  | {
      readonly type: "replace";
      readonly current: OrchestrationV2AppThread;
      readonly title: string;
    }
  | {
      readonly type: "retitle";
      readonly current: OrchestrationV2AppThread;
      readonly title: string;
    };

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const appProjects = yield* AppProjectService;
  const registry = yield* AppRegistryService;
  const projectService = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  // Two imports of one bundle would otherwise both find no copy and both write it.
  const importLock = yield* Semaphore.make(1);

  const stagingRoot = path.join(config.stateDir, STAGING_DIRECTORY);

  // Projection rows hold full items; only a wire-shaped row needs the re-read.
  const readFull = (row: {
    readonly sourceThreadId: ThreadId;
    readonly item: OrchestrationV2TurnItem;
  }) =>
    "outputOmitted" in row.item && row.item.outputOmitted === true
      ? orchestrator
          .getTurnItem({ threadId: row.sourceThreadId, itemId: row.item.id })
          .pipe(Effect.map((full) => full ?? row.item))
      : Effect.succeed(row.item);

  /**
   * The history as the thread shows it: a fork's inherited items included,
   * its synthetic fork marker left out (its source is not copied).
   */
  const readHistory = Effect.fn("ThreadCopyService.readHistory")(function* (threadId: ThreadId) {
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const rows = projection.visibleTurnItems.filter((row) => row.visibility !== "synthetic");
    const items = yield* Effect.forEach(rows, readFull);
    const own = new Map(projection.messages.map((message) => [message.id as string, message]));
    const inheritedIds = new Map<ThreadId, Array<OrchestrationV2ConversationMessage["id"]>>();
    for (const row of rows) {
      if (row.sourceThreadId === threadId || !("messageId" in row.item)) continue;
      const messageId = row.item.messageId;
      if (typeof messageId !== "string") continue;
      inheritedIds.set(row.sourceThreadId, [
        ...(inheritedIds.get(row.sourceThreadId) ?? []),
        messageId,
      ]);
    }
    const inherited = new Map<string, OrchestrationV2ConversationMessage>();
    for (const [sourceThreadId, messageIds] of inheritedIds) {
      const records = yield* orchestrator.getThreadRecords(sourceThreadId, ["messages"], {
        messageIds,
      });
      for (const message of records.messages) inherited.set(message.id, message);
    }
    const seen = new Set<string>();
    const messages: Array<OrchestrationV2ConversationMessage> = [];
    for (const item of items) {
      if (!("messageId" in item) || typeof item.messageId !== "string") continue;
      if (seen.has(item.messageId)) continue;
      seen.add(item.messageId);
      const message = own.get(item.messageId) ?? inherited.get(item.messageId);
      if (message !== undefined) messages.push(message);
    }
    return { messages, items };
  });

  const readAsset = (sourceAttachmentId: string, filePath: string | null, mimeType: string) =>
    filePath === null
      ? Effect.succeed(Option.none<ConnectedAppThreadBundleAsset>())
      : fs.readFile(filePath).pipe(
          Effect.map((bytes) =>
            Option.some<ConnectedAppThreadBundleAsset>({
              sourceAttachmentId,
              mimeType,
              byteLength: bytes.byteLength,
              sha256: sha256(bytes),
              dataBase64: Buffer.from(bytes).toString("base64"),
            }),
          ),
          // A file the source already lost cannot be copied; its row still is.
          Effect.catch((cause) =>
            Effect.logWarning("Thread copy skipped a missing attachment", {
              sourceAttachmentId,
              cause,
            }).pipe(Effect.as(Option.none<ConnectedAppThreadBundleAsset>())),
          ),
        );

  const exportThread = Effect.fn("ThreadCopyService.exportThread")(function* (
    shell: OrchestrationV2ThreadShell,
    historyRevision: number,
    assets: Map<string, ConnectedAppThreadBundleAsset>,
  ) {
    const { messages, items } = yield* readHistory(shell.id);
    for (const [sourceAttachmentId, ref] of collectThreadAssetRefs(messages, items)) {
      if (assets.has(sourceAttachmentId)) continue;
      const filePath =
        ref.kind === "chat"
          ? resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment: ref.attachment,
            })
          : resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId: sourceAttachmentId,
            });
      const mimeType =
        ref.kind === "chat"
          ? ref.attachment.mimeType
          : (DOCUMENT_MIME_TYPES[parseAttachmentFileExtension(sourceAttachmentId) ?? ""] ??
            "application/octet-stream");
      const asset = yield* readAsset(sourceAttachmentId, filePath, mimeType);
      if (Option.isSome(asset)) assets.set(sourceAttachmentId, asset.value);
    }
    return {
      sourceThreadId: shell.id,
      title: shell.title,
      createdAt: DateTime.formatIso(shell.createdAt),
      updatedAt: DateTime.formatIso(shell.updatedAt),
      historyRevision,
      appData: shell.appData ?? null,
      subtitle: shell.appSubtitle ?? null,
      pinned: shell.pinnedAt != null,
      messages,
      turnItems: items,
    } satisfies ConnectedAppThreadBundleThread;
  });

  const exportThreads: ThreadCopyService["Service"]["export"] = Effect.fn(
    "ThreadCopyService.export",
  )(function* (appId, projectIds) {
    const rows = yield* projects
      .list(projectIds === undefined ? {} : { projectIds })
      .pipe(Effect.mapError(unavailable("Could not read projects")));
    for (const projectId of projectIds ?? []) {
      const row = rows.find((candidate) => candidate.projectId === projectId);
      if (row === undefined) {
        return yield* new AppsError({
          code: "not-found",
          message: `Project ${projectId} not found.`,
        });
      }
      if (row.appBinding?.appId !== appId) {
        return yield* new AppsError({
          code: "forbidden",
          message: `Project ${projectId} does not belong to ${appId}.`,
        });
      }
    }
    const sourceEnvironmentId = yield* environment.getEnvironmentId;
    const assets = new Map<string, ConnectedAppThreadBundleAsset>();
    const bundleProjects: Array<ConnectedAppThreadBundleProject> = [];
    for (const row of rows) {
      if (row.appBinding?.appId !== appId) continue;
      const snapshot = yield* projections
        .getShellSnapshot({ projectId: row.projectId, location: "active" })
        .pipe(Effect.mapError(unavailable("Could not read threads")));
      // The app's rail: subagent children belong to their parent's turn.
      const shells = snapshot.threads.filter(
        (shell) =>
          shell.projectId === row.projectId &&
          shell.deletedAt === null &&
          shell.lineage.relationshipToParent !== "subagent",
      );
      const revisions = yield* readHistoryRevisions(shells.map((shell) => shell.id)).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(unavailable("Could not read thread history")),
      );
      const threads = yield* Effect.forEach(shells, (shell) =>
        exportThread(shell, revisions.get(shell.id) ?? 0, assets).pipe(
          Effect.mapError(unavailable(`Could not read thread ${shell.id}`)),
        ),
      );
      bundleProjects.push({
        workspaceRoot: row.appBinding.workspaceRoot,
        title: row.title,
        threads,
      });
    }
    return {
      version: 1,
      appId,
      sourceEnvironmentId,
      exportedAt: DateTime.formatIso(yield* DateTime.now),
      projects: bundleProjects,
      assets: Array.from(assets.values()),
    } satisfies ConnectedAppThreadBundleV1;
  });

  /** The same content always stages in the same place; `exportedAt` alone does not count. */
  const bundleHash = (bundle: ConnectedAppThreadBundleV1) =>
    encodeBundle(bundle).pipe(
      Effect.map(({ exportedAt: _exportedAt, ...content }) => sha256(JSON.stringify(content))),
      Effect.mapError(() => invalid("The bundle could not be encoded.")),
    );

  const blobPath = (stagingDir: string, asset: ConnectedAppThreadBundleAsset) =>
    path.join(stagingDir, asset.sha256);

  const writeAtomically = (
    target: string,
    write: (temporary: string) => Effect.Effect<void, PlatformError.PlatformError>,
  ) => {
    const temporary = `${target}.${sha256(target).slice(0, 12)}.part`;
    return write(temporary).pipe(Effect.andThen(fs.rename(temporary, target)));
  };

  /** Every asset is checked before any is written, so a corrupt bundle stages nothing. */
  const stageAssets = Effect.fn("ThreadCopyService.stageAssets")(function* (
    stagingDir: string,
    assets: ReadonlyArray<ConnectedAppThreadBundleAsset>,
  ) {
    const decoded = assets.map((asset) => {
      const bytes = Buffer.from(asset.dataBase64, "base64");
      return {
        asset,
        bytes,
        valid: bytes.byteLength === asset.byteLength && sha256(bytes) === asset.sha256,
      };
    });
    const corrupt = decoded.find((entry) => !entry.valid);
    if (corrupt !== undefined) {
      return yield* invalid(
        `Asset ${corrupt.asset.sourceAttachmentId} does not match its length or sha256.`,
      );
    }
    yield* fs.makeDirectory(path.join(stagingDir, STAGING_MANIFESTS), { recursive: true });
    for (const { asset, bytes } of decoded) {
      const target = blobPath(stagingDir, asset);
      if (yield* fs.exists(target)) continue;
      yield* writeAtomically(target, (temporary) => fs.writeFile(temporary, bytes));
    }
    // The sweep ages a staging area by this time, so a rerun keeps it alive.
    // Set last: writing a blob into the directory would move it again.
    const now = DateTime.toDate(yield* DateTime.now);
    yield* fs.utimes(stagingDir, now, now);
  });

  const manifestPath = (stagingDir: string, threadId: ThreadId) =>
    path.join(stagingDir, STAGING_MANIFESTS, `${sha256(threadId)}.json`);

  /** Removes stale staging areas and the promoted files no committed thread references. */
  const sweepStaging = Effect.fn("ThreadCopyService.sweepStaging")(function* () {
    if (!(yield* fs.exists(stagingRoot))) return;
    const now = yield* Clock.currentTimeMillis;
    for (const entry of yield* fs.readDirectory(stagingRoot)) {
      const stagingDir = path.join(stagingRoot, entry);
      const info = yield* fs.stat(stagingDir);
      const touchedAt = Option.getOrUndefined(info.mtime)?.getTime() ?? 0;
      if (now - touchedAt <= STAGING_MAX_AGE_MS) continue;
      const manifestDir = path.join(stagingDir, STAGING_MANIFESTS);
      const manifests = (yield* fs.exists(manifestDir)) ? yield* fs.readDirectory(manifestDir) : [];
      for (const name of manifests) {
        const manifest = decodeManifest(yield* fs.readFileString(path.join(manifestDir, name)));
        if (Option.isNone(manifest)) continue;
        const referenced = new Set(
          yield* projections.getThreadAttachmentIds(manifest.value.threadId as ThreadId),
        );
        for (const file of manifest.value.files) {
          const attachmentId = path.basename(file).replace(/\.[^.]*$/, "");
          if (referenced.has(attachmentId)) continue;
          const target = resolveAttachmentRelativePath({
            attachmentsDir: config.attachmentsDir,
            relativePath: file,
          });
          if (target !== null) yield* fs.remove(target, { force: true });
        }
      }
      yield* fs.remove(stagingDir, { recursive: true, force: true });
    }
  });

  /** Existing copies from one source environment, keyed by source thread. */
  const readCopies = Effect.fn("ThreadCopyService.readCopies")(function* (
    appId: AppId,
    sourceEnvironmentId: string,
  ) {
    const rows = yield* sql<{
      readonly threadId: ThreadId;
      readonly sourceThreadId: string;
      readonly revision: number;
      readonly title: string;
      readonly deletedAt: string | null;
    }>`
      SELECT
        thread_id AS "threadId",
        json_extract(payload_json, '$.copiedFrom.sourceThreadId') AS "sourceThreadId",
        json_extract(payload_json, '$.copiedFrom.sourceHistoryRevision') AS "revision",
        json_extract(payload_json, '$.title') AS "title",
        deleted_at AS "deletedAt"
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.copiedFrom.sourceEnvironmentId') = ${sourceEnvironmentId}
        AND json_extract(payload_json, '$.copiedFrom.appId') = ${appId}
    `;
    const bySource = new Map<string, Array<CopyRow>>();
    for (const row of rows) {
      const copies = bySource.get(row.sourceThreadId) ?? [];
      copies.push({
        threadId: row.threadId,
        sourceThreadId: row.sourceThreadId,
        revision: row.revision,
        title: row.title,
        deleted: row.deletedAt !== null,
      });
      bySource.set(row.sourceThreadId, copies);
    }
    return bySource;
  });

  const hasRuns = (threadId: ThreadId) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS "found" FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} LIMIT 1
    `.pipe(Effect.map((rows) => rows.length > 0));

  /**
   * D33: an up-to-date copy is skipped. A newer source replaces a copy that
   * is still history only; a copy the user has continued is never touched,
   * and the newer history becomes a thread of its own.
   *
   * The title is metadata: a rename alone never re-copies history. An
   * up-to-date copy that is still history only takes the source's current
   * title instead, which matters because a source is often renamed (title
   * generation, the user) after its first copy.
   */
  const planThread = Effect.fn("ThreadCopyService.planThread")(function* (input: {
    readonly appName: Effect.Effect<string, AppsError>;
    readonly bundle: ConnectedAppThreadBundleV1;
    readonly thread: ConnectedAppThreadBundleThread;
    readonly copies: ReadonlyArray<CopyRow>;
  }) {
    const { bundle, thread } = input;
    const sourceTitle = thread.title.trim();
    const firstCopyId = copyThreadId(bundle.sourceEnvironmentId, thread.sourceThreadId);
    // A re-copy's suffix tells it apart from the continued copy beside it.
    const titleOf = (threadId: ThreadId) => {
      const title = sourceTitle === "" ? UNTITLED : sourceTitle;
      return threadId === firstCopyId
        ? Effect.succeed(title)
        : Effect.map(input.appName, (name) => `${title} (from ${name})`);
    };
    const latest = input.copies.reduce<CopyRow | undefined>(
      (best, copy) => (best === undefined || copy.revision > best.revision ? copy : best),
      undefined,
    );
    if (latest === undefined) {
      return {
        type: "create",
        threadId: firstCopyId,
        title: yield* titleOf(firstCopyId),
      } satisfies ThreadPlan;
    }
    if (latest.revision >= thread.historyRevision) {
      if (sourceTitle === "" || latest.deleted) return { type: "skip" } satisfies ThreadPlan;
      const title = yield* titleOf(latest.threadId);
      if (latest.title === title || (yield* hasRuns(latest.threadId))) {
        return { type: "skip" } satisfies ThreadPlan;
      }
      return {
        type: "retitle",
        current: yield* projections.getThread(latest.threadId),
        title,
      } satisfies ThreadPlan;
    }
    if (!latest.deleted && !(yield* hasRuns(latest.threadId))) {
      const current = yield* projections.getThread(latest.threadId);
      return {
        type: "replace",
        current,
        title: sourceTitle === "" ? current.title : yield* titleOf(latest.threadId),
      } satisfies ThreadPlan;
    }
    const threadId = recopyThreadId(
      bundle.sourceEnvironmentId,
      thread.sourceThreadId,
      thread.historyRevision,
    );
    return { type: "create", threadId, title: yield* titleOf(threadId) } satisfies ThreadPlan;
  });

  const threadDefaults = Effect.fn("ThreadCopyService.threadDefaults")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectService.getById(projectId);
    const settings = yield* serverSettings.getSettings;
    const defaults = resolveProjectSettings(
      settings,
      projectId,
      Option.getOrNull(project),
    ).settings;
    return {
      modelSelection: defaults.defaultModelSelection ?? FALLBACK_MODEL_SELECTION,
      runtimeMode: defaults.defaultRuntimeMode,
    };
  });

  /** Pinning a copy promotes it out of Settled, as `thread.pin` does. */
  const sectionFields = (thread: ConnectedAppThreadBundleThread, pinnedAt: DateTime.Utc | null) => {
    const updatedAt = DateTime.makeUnsafe(thread.updatedAt);
    return thread.pinned
      ? { pinnedAt: pinnedAt ?? updatedAt, settledOverride: "active" as const, settledAt: null }
      : { pinnedAt: null, settledOverride: "settled" as const, settledAt: updatedAt };
  };

  const appFields = (
    thread: ConnectedAppThreadBundleThread,
    copiedFrom: ConnectedAppThreadCopyOrigin,
  ) => ({
    copiedFrom,
    ...(thread.appData === null ? {} : { appData: thread.appData }),
    ...(thread.subtitle === null ? {} : { appSubtitle: thread.subtitle }),
  });

  const importThread = Effect.fn("ThreadCopyService.importThread")(function* (input: {
    readonly appId: AppId;
    readonly bundle: ConnectedAppThreadBundleV1;
    readonly projectId: ProjectId;
    readonly thread: ConnectedAppThreadBundleThread;
    readonly plan: Extract<ThreadPlan, { readonly type: "create" | "replace" }>;
    readonly stagingDir: string;
    readonly assets: ReadonlyMap<string, ConnectedAppThreadBundleAsset>;
  }) {
    const { thread, plan, bundle } = input;
    const threadId = plan.type === "replace" ? plan.current.id : plan.threadId;

    const attachmentIds = new Map<string, string>();
    const files: Array<{ readonly blob: string; readonly relativePath: string }> = [];
    for (const [sourceAttachmentId, ref] of collectThreadAssetRefs(
      thread.messages,
      thread.turnItems,
    )) {
      const asset = input.assets.get(sourceAttachmentId);
      const attachmentId = copiedAttachmentId(threadId, sourceAttachmentId);
      if (asset === undefined || attachmentId === null) continue;
      const relativePath = copiedAssetRelativePath(attachmentId, ref);
      if (relativePath === null) continue;
      attachmentIds.set(sourceAttachmentId, attachmentId);
      files.push({ blob: blobPath(input.stagingDir, asset), relativePath });
    }

    // Recorded before any file lands, so the sweep can find files of a thread
    // whose commit never happened.
    yield* writeAtomically(manifestPath(input.stagingDir, threadId), (temporary) =>
      fs.writeFileString(
        temporary,
        JSON.stringify({ threadId, files: files.map((file) => file.relativePath) }),
      ),
    );
    for (const file of files) {
      const target = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: file.relativePath,
      });
      if (target === null) continue;
      yield* writeAtomically(target, (temporary) => fs.copyFile(file.blob, temporary));
    }

    const history = copyThreadHistory({
      threadId,
      messages: thread.messages,
      items: thread.turnItems,
      attachmentIds,
    });
    const now = yield* DateTime.now;
    const copiedFrom: ConnectedAppThreadCopyOrigin = {
      appId: input.appId,
      sourceEnvironmentId: bundle.sourceEnvironmentId,
      sourceThreadId: thread.sourceThreadId,
      copiedAt: DateTime.formatIso(now),
      sourceHistoryRevision: thread.historyRevision,
    };
    const createdAt = DateTime.makeUnsafe(thread.createdAt);
    const updatedAt = DateTime.makeUnsafe(thread.updatedAt);
    const eventPrefix = `${EVENT_PREFIX}:${threadId}:r${thread.historyRevision}`;

    let threadEvent: OrchestrationV2DomainEvent;
    if (plan.type === "replace") {
      const { current } = plan;
      const metadata = threadAppMetadataOf(current);
      threadEvent = {
        id: EventId.make(`${eventPrefix}:thread`),
        type: "thread.metadata-updated",
        threadId,
        occurredAt: now,
        payload: {
          ...withoutThreadAppMetadata(current),
          ...(metadata.appOrigin === undefined ? {} : { appOrigin: metadata.appOrigin }),
          ...(metadata.continuedIn === undefined ? {} : { continuedIn: metadata.continuedIn }),
          ...appFields(thread, copiedFrom),
          title: plan.title,
          updatedAt,
          ...sectionFields(thread, current.pinnedAt ?? null),
        },
      };
    } else {
      const defaults = yield* threadDefaults(input.projectId);
      threadEvent = {
        id: EventId.make(`${eventPrefix}:thread`),
        type: "thread.created",
        threadId,
        providerInstanceId: defaults.modelSelection.instanceId,
        occurredAt: createdAt,
        payload: {
          createdBy: "system",
          creationSource: "server",
          ...appFields(thread, copiedFrom),
          id: threadId,
          projectId: input.projectId,
          title: plan.title,
          providerInstanceId: defaults.modelSelection.instanceId,
          modelSelection: defaults.modelSelection,
          runtimeMode: defaults.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          linkedPullRequest: null,
          branchPullRequest: null,
          // No provider thread: the first turn opens a fresh session and
          // hands it the copied history.
          activeProviderThreadId: null,
          historyOrigin: "v1_import",
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt,
          updatedAt,
          archivedAt: null,
          unsettledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          pinOrderKey: null,
          activeOrderKey: null,
          lastVisitedAt: null,
          deletedAt: null,
          ...sectionFields(thread, null),
        },
      };
    }

    yield* eventSink.write({
      events: [
        threadEvent,
        ...history.messages.map((message): OrchestrationV2DomainEvent => ({
          id: EventId.make(`${eventPrefix}:message:${message.id}`),
          type: "message.updated",
          threadId,
          occurredAt: message.updatedAt,
          payload: message,
        })),
        ...history.items.map((item): OrchestrationV2DomainEvent => ({
          id: EventId.make(`${eventPrefix}:item:${item.id}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: item.updatedAt,
          payload: item,
        })),
      ],
    });
  });

  const retitleThread = Effect.fn("ThreadCopyService.retitleThread")(function* (
    current: OrchestrationV2AppThread,
    title: string,
  ) {
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          // A title can come back to an earlier value, so the id cannot be derived from it.
          id: EventId.make(`${EVENT_PREFIX}:${current.id}:title:${NodeCrypto.randomUUID()}`),
          type: "thread.metadata-updated",
          threadId: current.id,
          occurredAt: now,
          payload: { ...current, title },
        },
      ],
    });
  });

  const runImport = Effect.fn("ThreadCopyService.runImport")(function* (
    appId: AppId,
    bundle: ConnectedAppThreadBundleV1,
  ) {
    yield* sweepStaging().pipe(
      Effect.catch((cause) => Effect.logWarning("Thread copy staging sweep failed", { cause })),
    );
    const stagingDir = path.join(stagingRoot, yield* bundleHash(bundle));
    yield* stageAssets(stagingDir, bundle.assets);
    const assets = new Map(
      bundle.assets.map((asset) => [asset.sourceAttachmentId as string, asset]),
    );
    const copies = yield* readCopies(appId, bundle.sourceEnvironmentId);
    const appName = registry
      .get(appId)
      .pipe(
        Effect.map(
          Option.match({ onNone: () => appId as string, onSome: (record) => record.status.name }),
        ),
        Effect.mapError(unavailable("Could not read the app")),
        Effect.cached,
      );
    const appNameOnce = yield* appName;

    let imported = 0;
    let skipped = 0;
    for (const project of bundle.projects) {
      const { projectId } = yield* appProjects.ensureWorkspace(appId, {
        workspaceRoot: project.workspaceRoot,
        title: project.title,
      });
      for (const thread of project.threads) {
        const plan = yield* planThread({
          appName: appNameOnce,
          bundle,
          thread,
          copies: copies.get(thread.sourceThreadId) ?? [],
        });
        if (plan.type === "skip") {
          skipped += 1;
          continue;
        }
        // No history is copied, so it counts as skipped.
        if (plan.type === "retitle") {
          yield* retitleThread(plan.current, plan.title);
          skipped += 1;
          continue;
        }
        yield* importThread({ appId, bundle, projectId, thread, plan, stagingDir, assets });
        imported += 1;
      }
    }
    // Every thread is committed, so nothing in the staging area is needed again.
    yield* fs.remove(stagingDir, { recursive: true, force: true });
    return { imported, skipped };
  });

  const importThreads: ThreadCopyService["Service"]["import"] = (appId, bundle) =>
    bundle.appId !== appId
      ? Effect.fail(
          new AppsError({
            code: "forbidden",
            message: `The bundle belongs to ${bundle.appId}, not ${appId}.`,
          }),
        )
      : importLock.withPermits(1)(
          runImport(appId, bundle).pipe(
            Effect.mapError((cause) =>
              isAppsError(cause) ? cause : unavailable("Could not import threads")(cause),
            ),
          ),
        );

  return ThreadCopyService.of({ export: exportThreads, import: importThreads });
});

// The runtime's event sink is not in the apps layer's context; this is the
// same memoized instance (see AppToolApprovalService).
export const layer = Layer.effect(ThreadCopyService, make).pipe(
  Layer.provide(RuntimeLayer.layerEventSink),
);
