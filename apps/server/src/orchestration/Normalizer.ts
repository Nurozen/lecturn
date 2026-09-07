import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

import {
  createAttachmentId,
  planAttachmentClaim,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { StaveAdmission, type StaveAdmissionInput } from "../stave/StaveAdmission.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

interface WorktreeIntent extends Omit<StaveAdmissionInput, "projectRoot"> {
  /** Project carried by the command, when it has one. */
  readonly projectId?: ProjectId;
  /** Thread whose project owns the command, for thread-scoped shapes. */
  readonly threadId?: ThreadId;
  /** Root the command names directly, used when neither lookup resolves. */
  readonly fallbackProjectRoot?: string;
}

/**
 * Which client commands can bind a thread to a per-thread worktree, and how
 * to find the project each one targets. `null` means the command never
 * touches worktrees, so admission (and the projection read it needs) is
 * skipped entirely.
 */
export const describeWorktreeIntent = (
  command: ClientOrchestrationCommand,
): WorktreeIntent | null => {
  switch (command.type) {
    case "thread.create":
      return command.worktreePath === null
        ? null
        : {
            intent: "thread.create",
            worktreePath: command.worktreePath,
            projectId: command.projectId,
          };
    case "thread.meta.update":
      return command.worktreePath === undefined || command.worktreePath === null
        ? null
        : {
            intent: "thread.meta.update",
            worktreePath: command.worktreePath,
            threadId: command.threadId,
          };
    case "thread.turn.start": {
      const bootstrap = command.bootstrap;
      const worktreePath = bootstrap?.createThread?.worktreePath ?? null;
      const prepareWorktree = bootstrap?.prepareWorktree !== undefined;
      if (worktreePath === null && !prepareWorktree) {
        return null;
      }
      return {
        intent: "thread.turn.start",
        worktreePath,
        prepareWorktree,
        threadId: command.threadId,
        ...(bootstrap?.createThread ? { projectId: bootstrap.createThread.projectId } : {}),
        ...(bootstrap?.prepareWorktree
          ? { fallbackProjectRoot: bootstrap.prepareWorktree.projectCwd }
          : {}),
      };
    }
    default:
      return null;
  }
};

/**
 * Stave worktree rule on the normalization path (WebSocket, HTTP, mobile).
 * Resolves the project root from the command's project id, or through the
 * thread's project when the command carries only a thread id, then asks
 * `StaveAdmission`. A project or thread the projection does not know is left
 * to the decider, which rejects it with its own error.
 */
const enforceStaveWorktreeRule = Effect.fn("Normalizer.enforceStaveWorktreeRule")(function* (
  command: ClientOrchestrationCommand,
) {
  const request = describeWorktreeIntent(command);
  if (request === null) {
    return;
  }
  const admission = yield* StaveAdmission;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const readError = (cause: unknown) =>
    new OrchestrationDispatchCommandError({
      message: "Failed to resolve the command's project for Stave admission.",
      cause,
    });

  const projectId =
    request.projectId ??
    (request.threadId === undefined
      ? undefined
      : Option.getOrUndefined(
          yield* projectionSnapshotQuery
            .getThreadShellById(request.threadId)
            .pipe(Effect.mapError(readError)),
        )?.projectId);
  const project =
    projectId === undefined
      ? undefined
      : Option.getOrUndefined(
          yield* projectionSnapshotQuery
            .getProjectShellById(projectId)
            .pipe(Effect.mapError(readError)),
        );
  const projectRoot = project?.workspaceRoot ?? request.fallbackProjectRoot;
  if (projectRoot === undefined) {
    return;
  }

  const {
    projectId: _projectId,
    threadId: _threadId,
    fallbackProjectRoot: _root,
    ...input
  } = request;
  yield* admission
    .check({ ...input, projectRoot })
    .pipe(
      Effect.mapError(
        (error) => new OrchestrationDispatchCommandError({ message: error.message, cause: error }),
      ),
    );
});

const removeClaimedAttachmentPaths = Effect.fn("Normalizer.removeClaimedAttachmentPaths")(
  function* (attachmentPaths: ReadonlyArray<string>) {
    if (attachmentPaths.length === 0) {
      return;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      attachmentPaths,
      (attachmentPath) =>
        fileSystem.remove(attachmentPath, { force: true }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to remove an unclaimed attachment copy.", {
              attachmentPath,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 1 },
    );
  },
);

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (canonicalCommand.type === "project.create") {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    // A client-shaped fork carries no inherited history; only the WebSocket
    // dispatcher materializes it before dispatch. Rejecting here keeps the
    // HTTP and CLI paths, which feed normalizer output straight to the
    // engine, from ever handing the decider a raw fork.
    if (canonicalCommand.type === "thread.fork") {
      return yield* new OrchestrationDispatchCommandError({
        message: "thread.fork is materialized only by the WebSocket dispatcher.",
      });
    }

    // Before any attachment side effect: a refused command must leave no
    // claimed copies behind.
    yield* enforceStaveWorktreeRule(canonicalCommand);

    if (canonicalCommand.type !== "thread.turn.start") {
      return canonicalCommand as OrchestrationCommand;
    }

    const claimedAttachmentPaths: string[] = [];
    const normalizedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (!("dataUrl" in attachment)) {
            const claim = planAttachmentClaim({
              attachmentsDir: serverConfig.attachmentsDir,
              threadId: canonicalCommand.threadId,
              attachmentId: attachment.id,
            });
            if (!claim.ok) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
              });
            }

            const info = yield* fileSystem.stat(claim.currentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                    cause,
                  }),
              ),
            );
            if (Number(info.size) !== attachment.sizeBytes) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
              });
            }

            const normalizedAttachment = {
              ...attachment,
              id: claim.finalId,
              mimeType: attachment.mimeType.toLowerCase(),
            };
            const expectedPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment: normalizedAttachment,
            });
            if (expectedPath !== claim.finalPath) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
              });
            }

            // Keep the pending copy until the turn succeeds. A failed thread
            // bootstrap can then retry with a fresh thread id. A copy, not a
            // hard link: an agent editing the delivered file in place must not
            // mutate the retry source.
            yield* fileSystem.copyFile(claim.currentPath, claim.finalPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                    cause,
                  }),
              ),
            );
            claimedAttachmentPaths.push(claim.finalPath);

            return normalizedAttachment;
          }

          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(canonicalCommand.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    ).pipe(Effect.tapError(() => removeClaimedAttachmentPaths(claimedAttachmentPaths)));

    return {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

export const cleanupFailedUploadedAttachments = Effect.fn(
  "Normalizer.cleanupFailedUploadedAttachments",
)(function* (command: ClientOrchestrationCommand, normalizedCommand: OrchestrationCommand) {
  if (command.type !== "thread.turn.start" || normalizedCommand.type !== "thread.turn.start") {
    return;
  }

  const serverConfig = yield* ServerConfig;
  const claimedPaths: string[] = [];
  for (const [index, attachment] of normalizedCommand.message.attachments.entries()) {
    const original = command.message.attachments[index];
    if (
      !original ||
      "dataUrl" in original ||
      parseThreadSegmentFromAttachmentId(original.id) !== PENDING_ATTACHMENT_THREAD_SEGMENT
    ) {
      continue;
    }

    const claimedPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (claimedPath) {
      claimedPaths.push(claimedPath);
    }
  }
  yield* removeClaimedAttachmentPaths(claimedPaths);
});
