import * as DateTime from "effect/DateTime";
import type { StaveLifecycleSettings, StaveProjectInfo } from "@lecturn/contracts";
import type { StaveLifecycleRow } from "../persistence/Services/StaveLifecycleRepository.ts";
import type { ProjectionThreadLifecycleAnchor } from "./Services/ProjectionSnapshotQuery.ts";

/** Keep the full manifest timestamp: Stave can recreate a root within one millisecond. */
function instant(value: string): bigint | null {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return null;
  const seconds = Date.parse(`${match[1]}${match[3]}`);
  return Number.isFinite(seconds)
    ? BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"))
    : null;
}

function validIncarnation(value: string | null | undefined): bigint | null {
  if (value == null || value.startsWith("0001-01-01T")) return null;
  return instant(value);
}

export interface DeletedProjectDecision {
  readonly disposition:
    | "live"
    | "pending_destroy"
    | "pending_archive"
    | "kept"
    | "not_stave"
    | "destroyed"
    | "refused";
  readonly code?: string;
  readonly message?: string;
}

/** Evaluate persisted delete intent; filesystem read failures must be refused by the caller. */
export function evaluateDeletedProject(
  row: StaveLifecycleRow,
  manifest: StaveProjectInfo | null,
  policy: StaveLifecycleSettings,
): DeletedProjectDecision {
  switch (row.disposition) {
    case "destroyed":
    case "not_stave":
    case "kept":
      return { disposition: row.disposition };
    case "archived":
      return { disposition: "kept" };
  }
  if (policy.onProjectDelete === "keep" || manifest?.state === "archived") {
    return { disposition: "kept" };
  }
  const recorded = validIncarnation(row.manifestCreatedAt);
  if (manifest === null) {
    if (row.spaceId === null && row.manifestCreatedAt === null) {
      return { disposition: "not_stave" };
    }
    if (row.spaceId !== null && recorded !== null) return { disposition: "destroyed" };
  }
  const current = validIncarnation(manifest?.createdAt);
  if (recorded === null || current === null || row.spaceId === null) {
    return {
      disposition: "refused",
      code: "incarnation_mismatch",
      message: "The space has no verified creation timestamp. Review it manually before cleanup.",
    };
  }
  if (row.spaceId !== manifest?.spaceId || recorded !== current) {
    return {
      disposition: "refused",
      code: "incarnation_mismatch",
      message:
        "This root now belongs to a different space incarnation. Automatic cleanup was refused.",
    };
  }
  return {
    disposition: policy.onProjectDelete === "archive" ? "pending_archive" : "pending_destroy",
  };
}

export interface ArchiveSchedule {
  readonly anchorAt: string;
  readonly scheduledAt: string;
  readonly deadlineAt: string;
  readonly reset: boolean;
  readonly kept: boolean;
}

/** Lifecycle stamps identify activity episodes; provider/session metadata does not. */
export function resolveArchiveDeadline(input: {
  readonly anchors: ReadonlyArray<ProjectionThreadLifecycleAnchor>;
  readonly row: StaveLifecycleRow | null;
  readonly graceDays: number;
  readonly now: string;
}): ArchiveSchedule | null {
  const { anchors, row, graceDays, now } = input;
  if (anchors.length === 0) return null;
  for (const thread of anchors) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (thread.settledOverride === "active") return null;
    if (thread.settledOverride !== "settled") {
      if (thread.settledAt === null) return null;
      if (
        thread.unsettledAt !== null &&
        Date.parse(thread.unsettledAt) >= Date.parse(thread.settledAt)
      ) {
        return null;
      }
    }
  }
  const activityMillis = Math.max(
    ...anchors.flatMap((thread) =>
      [thread.createdAt, thread.settledAt, thread.unsettledAt, thread.archivedAt, thread.deletedAt]
        .filter((stamp): stamp is string => stamp !== null)
        .map((stamp) => Date.parse(stamp)),
    ),
  );
  const previousAnchor = row?.anchorAt == null ? null : Date.parse(row.anchorAt);
  const reset =
    previousAnchor === null || activityMillis > previousAnchor || row?.scheduledAt == null;
  // Older persisted episodes included generic updatedAt. Keep their baseline until
  // actual activity advances it, rather than undoing Keep when that timestamp is removed.
  const anchorMillis = reset ? activityMillis : Math.max(activityMillis, previousAnchor!);
  const anchorAt = DateTime.formatIso(DateTime.makeUnsafe(anchorMillis));
  const scheduledAt = reset ? now : row.scheduledAt!;
  const deadlineAt = DateTime.formatIso(
    DateTime.makeUnsafe(Math.max(anchorMillis, Date.parse(scheduledAt)) + graceDays * 86_400_000),
  );
  return { anchorAt, scheduledAt, deadlineAt, reset, kept: !reset && row?.disposition === "kept" };
}
