import type {
  ExistingStaveSpaceKind,
  StaveArchiveTaskState,
} from "@lecturn/client-runtime/state/stave-archive";
import type { StaveSpaceListRow } from "@lecturn/contracts";

/** "Restore <id> (i/n)"; a step without a count (reading archives, a review) shows its label alone. */
export function staveArchiveTaskLabel(
  state: Extract<StaveArchiveTaskState, { status: "running" }>,
): string {
  return state.total > 0 ? `${state.label} (${state.step}/${state.total})` : state.label;
}

export function showArchivedLabel(archivedCount: number): string {
  return `Show archived (${archivedCount})`;
}

/** The picker's empty state; hidden archives are counted so the switch is discoverable. */
export function existingStaveSpaceEmptyMessage(input: {
  readonly kind: ExistingStaveSpaceKind;
  readonly showArchived: boolean;
  readonly archivedCount: number;
}): string {
  const noun = input.kind === "saga" ? "sagas" : "spaces";
  const hidden =
    !input.showArchived && input.archivedCount > 0
      ? ` ${input.archivedCount} archived hidden.`
      : "";
  return `No ${noun} to add.${hidden}`;
}

export function deleteStaveArchiveCopy(entry: {
  readonly spaceId: string;
  readonly isSaga: boolean;
  readonly memberOf?: string | undefined;
}): { readonly title: string; readonly paragraphs: ReadonlyArray<string> } {
  const paragraphs = [
    "The archive's worktrees are restored briefly, then the space is destroyed: its spec and notes are removed, committed branches survive, and owned memory is kept.",
    "Its Lecturn project and threads are deleted. This cannot be undone.",
  ];
  if (entry.isSaga) {
    paragraphs.push(
      "Archived members stay archived. A saga that still has live members is restored but not deleted.",
    );
  } else if (entry.memberOf !== undefined) {
    paragraphs.push(
      `If saga ${entry.memberOf} still lists it, it leaves that saga first, dropping other members' ordering edges to it.`,
    );
  }
  return { title: `Delete ${entry.spaceId} permanently?`, paragraphs };
}

/** The `.archive/` row an archived saga project is rooted at. */
export function archivedSagaRow(
  rows: ReadonlyArray<StaveSpaceListRow>,
  sagaRoot: string,
): StaveSpaceListRow | null {
  return rows.find((row) => row.archived && row.isSaga && row.path === sagaRoot) ?? null;
}

/**
 * Spaces a saga can adopt: live non-saga spaces with a stamp that are free or
 * already its members, plus (when `showArchived`) archives of such spaces,
 * which are restored before the adopt. `archivedCount` counts archives either way.
 */
export function sagaAdoptCandidates(
  rows: ReadonlyArray<StaveSpaceListRow>,
  sagaId: string,
  showArchived: boolean,
): { readonly candidates: ReadonlyArray<StaveSpaceListRow>; readonly archivedCount: number } {
  const eligible = rows.filter(
    (row) =>
      !row.isSaga &&
      row.error === undefined &&
      row.manifestCreatedAt !== undefined &&
      (row.memberOf === undefined || row.memberOf === sagaId) &&
      (!row.archived || row.archiveBasename !== undefined),
  );
  const archivedCount = eligible.filter((row) => row.archived).length;
  return {
    candidates: showArchived ? eligible : eligible.filter((row) => !row.archived),
    archivedCount,
  };
}
