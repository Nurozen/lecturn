import {
  type AppBinding,
  type CommandId,
  type EventId,
  MAX_SCRIPT_ID_LENGTH,
  type ModelSelection,
  type ProjectIconOverride,
  ProjectId,
  type ProjectScript,
  SCRIPT_RUN_COMMAND_PATTERN,
  type StaveSagaTeardownAuthorization,
  type ThreadEnvMode,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import type { ProjectRow } from "./ProjectStore.ts";

export interface ProjectCreateCommand {
  readonly type: "project.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly scripts?: ReadonlyArray<ProjectScript>;
  /** Lecturn connected apps: server-set only, never from a client payload. */
  readonly appBinding?: AppBinding;
}

export interface ProjectMetaUpdateCommand {
  readonly type: "project.meta.update";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null;
  readonly autoPull?: boolean;
  readonly faviconPath?: string | null;
  readonly projectIcon?: ProjectIconOverride | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

/**
 * Lecturn Stave teardown inputs for project.deleted. The client confirms the
 * saga removal; the server binds the space identity before committing.
 */
export interface ProjectDeleteStaveFields {
  readonly staveSagaRemoveConfirmed?: boolean;
  readonly staveSagaTeardown?: StaveSagaTeardownAuthorization;
  readonly staveSpaceId?: string;
  readonly staveCreatedAt?: string;
}

export interface ProjectDeleteCommand {
  readonly type: "project.delete";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly stave?: ProjectDeleteStaveFields;
}

/**
 * Lecturn: server-internal push of an active project's current shell when
 * derived state (Stave space info, notices) changed without a project write.
 * Emits `project.refreshed`, which carries no state.
 */
export interface ProjectRefreshCommand {
  readonly type: "project.refresh";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export type ProjectCommand =
  | ProjectCreateCommand
  | ProjectMetaUpdateCommand
  | ProjectDeleteCommand
  | ProjectRefreshCommand;

export class ProjectCommandInvariantError extends Schema.TaggedError<ProjectCommandInvariantError>()(
  "ProjectCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Project command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class ProjectCommandMissingProjectError extends Schema.TaggedError<ProjectCommandMissingProjectError>()(
  "ProjectCommandMissingProjectError",
  {
    commandType: Schema.String,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist for command '${this.commandType}'.`;
  }
}

export class ProjectWorkspaceConflictError extends Schema.TaggedError<ProjectWorkspaceConflictError>()(
  "ProjectWorkspaceConflictError",
  {
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Active project '${this.conflictingProjectId}' already exists for workspace root '${this.workspaceRoot}'.`;
  }
}

export const ProjectCommandRejection = Schema.Union([
  ProjectCommandInvariantError,
  ProjectCommandMissingProjectError,
  ProjectWorkspaceConflictError,
]);
export type ProjectCommandRejection = typeof ProjectCommandRejection.Type;

const ProjectCommandRejectionJson = Schema.fromJsonString(ProjectCommandRejection);
export const encodeProjectCommandRejection = Schema.encodeSync(ProjectCommandRejectionJson);
export const decodeProjectCommandRejection = Schema.decodeUnknownOption(
  ProjectCommandRejectionJson,
);

export interface ProjectCommandState {
  readonly project: ProjectRow | undefined;
  /** The active normal project on the root; app projects never own one. */
  readonly workspaceOwner: ProjectRow | undefined;
  /**
   * Lecturn connected apps: the active project already bound to the create's
   * `(appId, workspaceRoot)`. Read only for a create that carries an
   * `appBinding`, which conflicts with it instead of with `workspaceOwner`.
   */
  readonly appWorkspaceOwner?: ProjectRow | undefined;
}

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

/**
 * The caller reads `state` under the project's lock and commits the planned
 * event.
 */
export function planProjectCommand(input: {
  readonly command: ProjectCommand;
  readonly state: ProjectCommandState;
  readonly eventId: EventId;
  readonly now: DateTime.Utc;
}): Result.Result<UnsequencedProjectEvent, ProjectCommandRejection> {
  const { command, state } = input;
  const invariant = (detail: string) =>
    Result.fail(new ProjectCommandInvariantError({ commandType: command.type, detail }));
  const missingProject = () =>
    Result.fail(
      new ProjectCommandMissingProjectError({
        commandType: command.type,
        projectId: command.projectId,
      }),
    );
  const activeProject = state.project?.deletedAt === null ? state.project : undefined;
  const requireWorkspaceAvailable = (workspaceRoot: string) =>
    state.workspaceOwner === undefined || state.workspaceOwner.projectId === command.projectId
      ? undefined
      : new ProjectWorkspaceConflictError({
          workspaceRoot,
          conflictingProjectId: state.workspaceOwner.projectId,
        });
  const occurredAt = DateTime.formatIso(input.now);
  const base = {
    eventId: input.eventId,
    aggregateKind: "project" as const,
    aggregateId: command.projectId,
    occurredAt,
    commandId: command.commandId,
    causationEventId: null,
    correlationId: command.commandId,
    metadata: {},
  };

  switch (command.type) {
    case "project.create": {
      if (state.project !== undefined) {
        return invariant(
          `Project '${command.projectId}' already exists and cannot be created twice.`,
        );
      }
      const conflict =
        command.appBinding === undefined
          ? requireWorkspaceAvailable(command.workspaceRoot)
          : state.appWorkspaceOwner === undefined
            ? undefined
            : new ProjectWorkspaceConflictError({
                workspaceRoot: command.appBinding.workspaceRoot,
                conflictingProjectId: state.appWorkspaceOwner.projectId,
              });
      if (conflict !== undefined) return Result.fail(conflict);
      return Result.succeed({
        ...base,
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: command.scripts ?? [],
          createdAt: occurredAt,
          updatedAt: occurredAt,
          ...(command.appBinding === undefined ? {} : { appBinding: command.appBinding }),
        },
      });
    }

    case "project.meta.update": {
      const project = activeProject;
      if (project === undefined) return missingProject();
      if (
        command.projectIcon?.kind === "monogram" &&
        Array.from(monogramSegmenter.segment(command.projectIcon.text)).length > 2
      ) {
        return invariant("Project monograms must contain at most two characters.");
      }
      if (command.scripts !== undefined) {
        // Persisted IDs predate shortcut validation. Let users edit or remove them
        // without allowing another invalid ID to enter the project.
        const existingIds = new Set(project.scripts.map((script) => script.id));
        for (const script of command.scripts) {
          if (!existingIds.has(script.id) && !isScriptRunCommand(`script.${script.id}.run`)) {
            return invariant(
              `Script IDs must be 1-${MAX_SCRIPT_ID_LENGTH} lowercase letters, digits or hyphens, starting with a letter or digit (got ${script.id.length} characters).`,
            );
          }
        }
      }
      if (command.workspaceRoot !== undefined) {
        const conflict = requireWorkspaceAvailable(command.workspaceRoot);
        if (conflict !== undefined) return Result.fail(conflict);
      }
      return Result.succeed({
        ...base,
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.workspaceRoot === undefined ? {} : { workspaceRoot: command.workspaceRoot }),
          ...(command.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: command.defaultModelSelection }),
          ...(command.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: command.defaultThreadEnvMode }),
          ...(command.autoPull === undefined ? {} : { autoPull: command.autoPull }),
          ...(command.faviconPath === undefined ? {} : { faviconPath: command.faviconPath }),
          ...(command.projectIcon === undefined ? {} : { projectIcon: command.projectIcon }),
          ...(command.scripts === undefined ? {} : { scripts: command.scripts }),
          updatedAt: occurredAt,
        },
      });
    }

    case "project.refresh": {
      if (activeProject === undefined) return missingProject();
      return Result.succeed({
        ...base,
        type: "project.refreshed",
        payload: { projectId: command.projectId },
      });
    }

    case "project.delete": {
      if (activeProject === undefined) return missingProject();
      // Thread children are deleted by ProjectService before this event commits.
      // Lecturn: the workspace root and Stave inputs drive Stave lifecycle teardown.
      const stave = command.stave;
      return Result.succeed({
        ...base,
        type: "project.deleted",
        payload: {
          projectId: command.projectId,
          workspaceRoot: activeProject.workspaceRoot,
          ...(stave?.staveSagaRemoveConfirmed === undefined
            ? {}
            : { staveSagaRemoveConfirmed: stave.staveSagaRemoveConfirmed }),
          ...(stave?.staveSagaTeardown === undefined
            ? {}
            : { staveSagaTeardown: stave.staveSagaTeardown }),
          ...(stave?.staveSpaceId === undefined ? {} : { staveSpaceId: stave.staveSpaceId }),
          ...(stave?.staveCreatedAt === undefined ? {} : { staveCreatedAt: stave.staveCreatedAt }),
          deletedAt: occurredAt,
        },
      });
    }
  }
}
