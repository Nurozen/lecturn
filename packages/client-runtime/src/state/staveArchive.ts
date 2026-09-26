/**
 * Archived Stave spaces, shared by web and mobile.
 *
 * An archived space keeps its Lecturn project (rooted at the `.archive/`
 * entry) with every thread, but the project is hidden from project lists: it
 * is reached again through New project → Stave → Existing space, which lists
 * the environment's spaces that are not visible projects (active spaces never
 * added, and archives). Restoring reuses the hidden project when one survives;
 * the server creates one otherwise. The runners here sequence the Stave
 * operations (restore, a saga's members, delete) over an injected client so
 * each surface binds them to its own operation manager.
 */

import type {
  ProjectId,
  StaveDryRunPlan,
  StaveOperation,
  StaveOperationResult,
  StaveRestoreSpaceOperation,
  StaveSpaceListRow,
} from "@lecturn/contracts";

import type { StaveOperationState } from "./staveOperation.ts";

type StaveStateLike = {
  readonly stave?: { readonly state?: string | undefined } | null | undefined;
};

/** Archived spaces are reached from New project → Stave, not from project lists. */
export function isArchivedStaveProject(project: StaveStateLike): boolean {
  return project.stave?.state === "archived";
}

export function withoutArchivedStaveProjects<Project extends StaveStateLike>(
  projects: ReadonlyArray<Project>,
): Project[] {
  return projects.filter((project) => !isArchivedStaveProject(project));
}

/** Stamps from `.stave.yaml` and `space list` differ only in trailing fraction digits. */
export function sameStaveIncarnation(left: string, right: string): boolean {
  const key = (value: string) => {
    const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (match === null) return null;
    const seconds = Date.parse(`${match[1]}${match[3]}`);
    return Number.isFinite(seconds) ? `${seconds}.${(match[2] ?? "").padEnd(9, "0")}` : null;
  };
  const first = key(left);
  return first !== null && first === key(right);
}

export interface StaveProjectRef {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly stave?:
    | {
        readonly spaceId: string;
        readonly createdAt?: string | undefined;
        readonly state?: string | undefined;
      }
    | null
    | undefined;
}

export interface ExistingStaveSpace {
  /** The `space list` path; unique across live spaces and archive entries. */
  readonly key: string;
  readonly spaceId: string;
  readonly path: string;
  readonly isSaga: boolean;
  readonly archived: boolean;
  readonly archiveBasename: string | null;
  readonly archivedAt: string | null;
  readonly manifestCreatedAt: string | null;
  readonly repoNames: ReadonlyArray<string>;
  /** The hidden project a restore brings back, with its threads; null when none survives. */
  readonly project: { readonly id: ProjectId; readonly title: string } | null;
  readonly row: StaveSpaceListRow;
}

export type ExistingStaveSpaceKind = "space" | "saga";

function rowSpaceId(row: StaveSpaceListRow): string {
  return row.logicalId ?? row.id;
}

function ownsRow(project: StaveProjectRef, row: StaveSpaceListRow): boolean {
  if (project.workspaceRoot === row.path) return true;
  const stave = project.stave;
  return (
    stave != null &&
    stave.spaceId === rowSpaceId(row) &&
    stave.createdAt !== undefined &&
    row.manifestCreatedAt !== undefined &&
    sameStaveIncarnation(stave.createdAt, row.manifestCreatedAt) &&
    // A live space's project sits on the live root; an archive's is hidden on its entry.
    (stave.state === "archived") === row.archived
  );
}

/**
 * The rows the Existing space/saga picker offers: spaces of `kind` that are
 * not visible projects (active but never added, or archived), archives only
 * when `showArchived`. Active rows come first by id, archives newest first.
 * `archivedCount` counts archives whether shown or not, for the toggle label.
 */
export function existingStaveSpaces(input: {
  readonly rows: ReadonlyArray<StaveSpaceListRow>;
  readonly projects: ReadonlyArray<StaveProjectRef>;
  readonly kind: ExistingStaveSpaceKind;
  readonly showArchived: boolean;
}): { readonly entries: ReadonlyArray<ExistingStaveSpace>; readonly archivedCount: number } {
  const active: ExistingStaveSpace[] = [];
  const archived: ExistingStaveSpace[] = [];
  for (const row of input.rows) {
    if (row.error !== undefined || row.isSaga !== (input.kind === "saga")) continue;
    const owner = input.projects.find((project) => ownsRow(project, row)) ?? null;
    if (!row.archived && owner !== null && !isArchivedStaveProject(owner)) continue;
    const entry: ExistingStaveSpace = {
      key: row.path,
      spaceId: rowSpaceId(row),
      path: row.path,
      isSaga: row.isSaga,
      archived: row.archived,
      archiveBasename: row.archiveBasename ?? null,
      archivedAt: row.archivedAt ?? null,
      manifestCreatedAt: row.manifestCreatedAt ?? null,
      repoNames: row.repos.map((repo) => repo.name),
      project: owner === null ? null : { id: owner.id, title: owner.title },
      row,
    };
    (row.archived ? archived : active).push(entry);
  }
  active.sort((left, right) => left.spaceId.localeCompare(right.spaceId));
  archived.sort(
    (left, right) =>
      (right.archivedAt ?? "").localeCompare(left.archivedAt ?? "") ||
      left.key.localeCompare(right.key),
  );
  return {
    entries: input.showArchived ? [...active, ...archived] : active,
    archivedCount: archived.length,
  };
}

const ARCHIVE_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * The secondary line of a picker row. An archive shows when it was archived
 * and its `.archive/` entry, since one id can be archived many times.
 */
export function existingStaveSpaceDetail(
  entry: ExistingStaveSpace,
  formatDate: (iso: string) => string = (iso) => ARCHIVE_DATE_FORMAT.format(Date.parse(iso)),
): string {
  if (!entry.archived) {
    return entry.repoNames.length > 0 ? entry.repoNames.join(", ") : "No repos";
  }
  const parts = [
    entry.archivedAt === null ? "Archived" : `Archived ${formatDate(entry.archivedAt)}`,
  ];
  if (entry.archiveBasename !== null) parts.push(entry.archiveBasename);
  return parts.join(" · ");
}

// ── Restore, undo and delete ─────────────────────────────────

export interface StaveRestoreStep {
  readonly spaceId: string;
  readonly operation: StaveRestoreSpaceOperation;
}

function restoreStep(row: StaveSpaceListRow): StaveRestoreStep | null {
  if (!row.archived || row.archiveBasename === undefined) return null;
  return {
    spaceId: rowSpaceId(row),
    operation: {
      kind: "restoreSpace",
      workspaceRoot: row.path,
      from: row.archiveBasename,
      ...(row.manifestCreatedAt === undefined
        ? {}
        : { expectedManifestCreatedAt: row.manifestCreatedAt }),
    },
  };
}

/**
 * The restores that bring an archive back: the entry itself, then for a saga
 * each rostered member that is still archived (the newest matching archive),
 * in roster order.
 */
export function staveRestoreSteps(
  row: StaveSpaceListRow,
  rows: ReadonlyArray<StaveSpaceListRow>,
): ReadonlyArray<StaveRestoreStep> {
  const own = restoreStep(row);
  if (own === null) return [];
  const members = (row.isSaga ? (row.sagaMembers ?? []) : []).flatMap((member) => {
    const archives = rows
      .filter(
        (candidate) =>
          candidate.archived &&
          !candidate.isSaga &&
          candidate.error === undefined &&
          rowSpaceId(candidate) === member.id &&
          (member.createdAt === undefined ||
            (candidate.manifestCreatedAt !== undefined &&
              sameStaveIncarnation(candidate.manifestCreatedAt, member.createdAt))),
      )
      .sort((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""));
    const step = archives[0] === undefined ? null : restoreStep(archives[0]);
    return step === null ? [] : [step];
  });
  return [own, ...members];
}

export interface StaveArchiveUndo {
  readonly title: "Space archived" | "Saga archived";
  readonly description: string;
  /** Archive entries to restore, saga space first, members in dependency order. */
  readonly paths: ReadonlyArray<string>;
}

export const STAVE_ARCHIVE_RESTORE_HINT = "Restore it any time from New project → Stave.";

/** The undo toast an archive's result earns; null for anything else. */
export function staveArchiveUndo(result: StaveOperationResult): StaveArchiveUndo | null {
  if (result.kind === "archiveSpace") {
    return {
      title: "Space archived",
      description: STAVE_ARCHIVE_RESTORE_HINT,
      paths: [result.result.archivedPath],
    };
  }
  if (result.kind === "sagaArchive" && result.result.action === "archived") {
    const members = result.result.members
      .filter((member) => member.action === "archived" && member.archivedPath !== undefined)
      .map((member) => member.archivedPath!)
      // Teardown ran in reverse dependency order; restore runs forward.
      .toReversed();
    return {
      title: "Saga archived",
      description: STAVE_ARCHIVE_RESTORE_HINT,
      paths: [
        ...(result.result.sagaArchivedPath === undefined ? [] : [result.result.sagaArchivedPath]),
        ...members,
      ],
    };
  }
  return null;
}

export interface StaveArchiveClient {
  /** Runs one Stave operation to its settled state (the surface's operation manager). */
  readonly run: (operationId: string, operation: StaveOperation) => Promise<StaveOperationState>;
  /** A fresh `stave.listSpaces({ includeArchived: true })`. */
  readonly listSpaces: () => Promise<ReadonlyArray<StaveSpaceListRow>>;
  /** `stave.dryRun`, used to bind a saga teardown to its reviewed scope. */
  readonly dryRun: (operation: StaveOperation) => Promise<StaveDryRunPlan>;
  readonly newOperationId: () => string;
}

export type StaveArchiveTaskState =
  | {
      readonly status: "running";
      readonly label: string;
      readonly step: number;
      readonly total: number;
      /** The Stave operation in flight, for a progress view; null between operations. */
      readonly operationId: string | null;
    }
  | {
      readonly status: "finished";
      /** The restored space's project, opened once the shell reaches `sequence`. */
      readonly projectId: ProjectId | null;
      readonly sequence: number | null;
      /** The restored space's live root and manifest stamp (a saga adopting it needs both). */
      readonly restored: { readonly spacePath: string; readonly createdAt: string } | null;
    }
  | { readonly status: "failed"; readonly message: string };

type OnState = (state: StaveArchiveTaskState) => void;

class StaveArchiveTaskError extends Error {}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

async function runStep(
  client: StaveArchiveClient,
  operation: StaveOperation,
  progress: { readonly label: string; readonly step: number; readonly total: number },
  onState: OnState,
): Promise<StaveOperationResult> {
  const operationId = client.newOperationId();
  onState({ status: "running", ...progress, operationId });
  const state = await client.run(operationId, operation);
  if (state.status === "finished" && state.result !== undefined) return state.result;
  if (state.status === "failed") {
    throw new StaveArchiveTaskError(state.error?.message ?? `${progress.label} failed.`);
  }
  throw new StaveArchiveTaskError(
    `Lost the connection during "${progress.label}". It may still finish on the server; reopen the list to check.`,
  );
}

async function settle(
  onState: OnState,
  body: () => Promise<StaveArchiveTaskState>,
): Promise<StaveArchiveTaskState> {
  let final: StaveArchiveTaskState;
  try {
    final = await body();
  } catch (error) {
    final = { status: "failed", message: describe(error, "The Stave operation failed.") };
  }
  onState(final);
  return final;
}

async function runRestoreSteps(
  client: StaveArchiveClient,
  steps: ReadonlyArray<StaveRestoreStep>,
  onState: OnState,
): Promise<StaveArchiveTaskState> {
  if (steps.length === 0)
    throw new StaveArchiveTaskError("This archive can no longer be restored.");
  let opened: {
    projectId: ProjectId | null;
    sequence: number | null;
    spacePath: string;
    createdAt: string;
  } | null = null;
  for (const [index, step] of steps.entries()) {
    const result = await runStep(
      client,
      step.operation,
      { label: `Restore ${step.spaceId}`, step: index + 1, total: steps.length },
      onState,
    ).catch((error: unknown) => {
      if (index === 0) throw error;
      // Earlier entries stay restored; the failure must not read as "nothing changed".
      const done = steps.slice(0, index).map((earlier) => earlier.spaceId);
      throw new StaveArchiveTaskError(
        `Restored ${done.join(", ")}, but restoring ${step.spaceId} failed: ${describe(error, "the Stave operation failed.")}`,
      );
    });
    if (opened === null && result.kind === "restoreSpace") {
      opened = {
        // Servers before project reuse report neither.
        projectId: result.result.projectId ?? null,
        sequence: result.result.sequence ?? null,
        spacePath: result.result.spacePath,
        createdAt: result.result.manifest.createdAt,
      };
    }
  }
  return {
    status: "finished",
    projectId: opened?.projectId ?? null,
    sequence: opened?.sequence ?? null,
    restored: opened === null ? null : { spacePath: opened.spacePath, createdAt: opened.createdAt },
  };
}

/** Restores a picked archive (a saga with its archived members) into its project. */
export function restoreStaveArchive(
  client: StaveArchiveClient,
  target: { readonly row: StaveSpaceListRow; readonly rows: ReadonlyArray<StaveSpaceListRow> },
  onState: OnState = () => {},
): Promise<StaveArchiveTaskState> {
  return settle(onState, () =>
    runRestoreSteps(client, staveRestoreSteps(target.row, target.rows), onState),
  );
}

/** Undo for an archive toast: re-reads the archive list and restores the entries it produced. */
export function undoStaveArchive(
  client: StaveArchiveClient,
  undo: StaveArchiveUndo,
  onState: OnState = () => {},
): Promise<StaveArchiveTaskState> {
  return settle(onState, async () => {
    onState({ status: "running", label: "Reading archives", step: 0, total: 0, operationId: null });
    const rows = await client.listSpaces();
    const steps = undo.paths.map((path) => {
      const row = rows.find((candidate) => candidate.archived && candidate.path === path);
      const step = row === undefined ? null : restoreStep(row);
      if (step === null) throw new StaveArchiveTaskError(`The archive at ${path} is gone.`);
      return step;
    });
    return runRestoreSteps(client, steps, onState);
  });
}

/**
 * Permanently deletes an archive. Stave only destroys live spaces, so the
 * entry is restored first and then destroyed through the ordinary destroy
 * operation (owned memory kept, never forced); its project and threads go
 * with it. A saga's archived members stay archived; a saga that still has
 * live members is refused after the restore, before anything is destroyed.
 */
export function deleteStaveArchive(
  client: StaveArchiveClient,
  row: StaveSpaceListRow,
  onState: OnState = () => {},
): Promise<StaveArchiveTaskState> {
  return settle(onState, async () => {
    const step = restoreStep(row);
    if (step === null) throw new StaveArchiveTaskError("This archive can no longer be restored.");
    const restored = await runStep(
      client,
      step.operation,
      { label: `Restore ${step.spaceId}`, step: 1, total: 2 },
      onState,
    );
    if (restored.kind !== "restoreSpace")
      throw new StaveArchiveTaskError("Restore did not finish.");
    const { spacePath, manifest } = restored.result;
    const label = { label: `Delete ${step.spaceId}`, step: 2, total: 2 };
    // Past the restore the entry is live again, so a failure must say so.
    const destroyed = <A>(run: Promise<A>) =>
      run.catch((error: unknown) => {
        throw new StaveArchiveTaskError(
          `${step.spaceId} was restored and is active again, but deleting it failed: ${describe(error, "the Stave operation failed.")}`,
        );
      });
    if (row.isSaga) {
      const teardown = {
        kind: "sagaDestroy",
        sagaRoot: spacePath,
        expectedManifestCreatedAt: manifest.createdAt,
        force: false,
        memory: "keep",
      } as const;
      onState({ status: "running", ...label, operationId: null });
      const review = (await destroyed(client.dryRun(teardown))).sagaReview;
      if (review === undefined)
        throw new StaveArchiveTaskError(
          "The saga space was restored, but its teardown scope could not be reviewed.",
        );
      const live = review.participants.filter(
        (participant) => participant.state === "live" && participant.workspaceRoot !== spacePath,
      );
      if (live.length > 0)
        throw new StaveArchiveTaskError(
          `The saga space was restored, but members ${live.map((member) => member.spaceId).join(", ")} are still live. Archive or remove them, then delete the saga from its settings.`,
        );
      await destroyed(
        runStep(client, { ...teardown, expectedSagaReview: review.fingerprint }, label, onState),
      );
    } else {
      await destroyed(
        runStep(
          client,
          {
            kind: "destroySpace",
            workspaceRoot: spacePath,
            expectedManifestCreatedAt: manifest.createdAt,
            force: false,
            memory: "keep",
            sagaRemoveConfirmed: true,
          },
          label,
          onState,
        ),
      );
    }
    return { status: "finished", projectId: null, sequence: null, restored: null };
  });
}
