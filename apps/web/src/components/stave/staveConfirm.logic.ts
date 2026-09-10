import type { StaveOperation, StaveSagaReview } from "@t3tools/contracts";

/** Only refusals that Stave explicitly allows --force to bypass offer a retry. */
export function canForceStaveOperation(operation: StaveOperation, code: string | undefined) {
  return (
    !(
      operation.kind === "lifecycleAction" &&
      (operation.action === "keep" || operation.action === "dismiss")
    ) &&
    "force" in operation &&
    !operation.force &&
    (code === "dirty_worktrees" || code === "dependent_spaces")
  );
}

export function forceStaveOperation(operation: StaveOperation): StaveOperation {
  return "force" in operation ? { ...operation, force: true } : operation;
}

export function staveOperationLossCopy(operation: StaveOperation): string {
  switch (operation.kind) {
    case "lifecycleAction":
      if (operation.action === "keep")
        return "Keep this space and cancel this cleanup episode. Its files and memories remain in place.";
      if (operation.action === "dismiss")
        return "Dismiss this cleanup record. Lecturn will leave the space and its memories in place.";
      return operation.action === "archiveNow" || operation.target === "archive"
        ? "This stops sessions and archives the space. Specs, notes, memories and committed branches survive. Unarchive restores its worktrees."
        : "This permanently removes the space directory, including its spec and notes. Committed branches remain in Stave's repository cache.";
    case "destroySpace":
    case "removePartialSpace":
      return "This permanently removes the space directory, including its spec and notes. Committed branches remain in Stave's repository cache.";
    case "archiveSpace":
      return "This stops sessions, removes worktrees, and moves the space into the archive. Its manifest, spec, notes, and committed branches survive. Unarchive restores the worktrees.";
    case "sagaDestroy":
      return "This permanently removes the saga and every live member, including their specs and notes, in reverse dependency order. Committed branches remain in Stave's repository cache. A refusal can leave earlier members already removed; review the result before retrying.";
    case "sagaArchive":
      return "This stops sessions and archives the saga and every live member in reverse dependency order. Specs, notes and committed branches survive. A refusal can leave earlier members already archived. Members can be unarchived individually.";
    case "sagaRemove":
      return "This removes the member from the saga and removes other members' after edges to it. The member's files and project are kept. Rejoining does not restore the removed edges automatically.";
    case "sagaAdd":
      return operation.after.length > 0
        ? "This replaces the member's dependency edges with the selected predecessors. Its files are kept."
        : operation.clearAfter
          ? "This clears all existing dependency edges for the member. Its files are kept."
          : "This enrolls the space while keeping any existing dependency edges. Its files are kept.";
    case "removeRepo":
      return "This removes the selected checkout from this space. Its committed branch remains in Stave's repository cache.";
    case "memoryDetach":
      return operation.fate === "destroy"
        ? "This detaches the memory and destroys its owned store. An attached store owned elsewhere is kept."
        : "This detaches the memory and keeps its store.";
    case "restoreSpace":
      return "This rebuilds the archived space's worktrees and moves the project back to its live location.";
    default:
      return "Review the changes Stave will make to this space before continuing.";
  }
}

export function staveRefusalCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

/** Attach consent only to the operation whose options were reviewed. */
export function bindStaveSagaReview(
  operation: StaveOperation,
  review: StaveSagaReview | undefined,
  lifecycleIsSaga = false,
): StaveOperation | null {
  const requiresReview =
    operation.kind === "sagaArchive" ||
    operation.kind === "sagaDestroy" ||
    (operation.kind === "lifecycleAction" &&
      (lifecycleIsSaga || review !== undefined) &&
      (operation.action === "retry" || operation.action === "archiveNow"));
  if (!requiresReview) return operation;
  if (!review) return null;
  if (
    operation.kind !== "sagaArchive" &&
    operation.kind !== "sagaDestroy" &&
    operation.kind !== "lifecycleAction"
  )
    return null;
  const target =
    operation.kind === "sagaArchive" ||
    (operation.kind === "lifecycleAction" && operation.action === "archiveNow")
      ? "archive"
      : operation.kind === "sagaDestroy"
        ? "destroy"
        : operation.target;
  const root = operation.kind === "lifecycleAction" ? operation.workspaceRoot : operation.sagaRoot;
  if (
    review.target !== target ||
    review.force !== operation.force ||
    review.memory !== operation.memory ||
    review.sagaRoot !== root ||
    (operation.expectedManifestCreatedAt !== undefined &&
      review.sagaCreatedAt !== operation.expectedManifestCreatedAt)
  )
    return null;
  return { ...operation, expectedSagaReview: review.fingerprint };
}
